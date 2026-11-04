# Sets the display scale to the one that the host sets in
# C:\ProgramData\remotebrowser\screen-scale (see src/vm/screen-scale.js), as
# vm/linux/files/usr/local/bin/screen-scale does in the Linux guest. It runs
# in the session of the user who logs in, since the scale belongs to that
# session, and keeps watching the file.
#
# The file holds one line: the scale in percent, e.g. 150, or "default".
# Anything else, e.g. a write that the host did not finish, leaves the scale
# as it is.
$dir = 'C:\ProgramData\remotebrowser'
$file = Join-Path $dir 'screen-scale'
# No file is the image as it was built: 150%, as in src/vm/screen-scale.js.
$default = 150

# Windows has no public API to set the scale. The Settings app uses these
# undocumented DisplayConfig calls, which apply at once, without a sign-out.
# Windows keeps the scale as a step up or down from the one it recommends,
# which depends on the screen size.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DisplayScale {
  [StructLayout(LayoutKind.Sequential)]
  struct Luid { public uint Low; public int High; }

  [StructLayout(LayoutKind.Sequential)]
  struct Header { public int Type; public int Size; public Luid AdapterId; public uint Id; }

  [StructLayout(LayoutKind.Sequential)]
  struct GetScale { public Header Header; public int MinStep; public int CurrentStep; public int MaxStep; }

  [StructLayout(LayoutKind.Sequential)]
  struct SetScale { public Header Header; public int Step; }

  // Only the source of the path is read, so the rest stays opaque.
  [StructLayout(LayoutKind.Explicit, Size = 72)]
  struct PathInfo { [FieldOffset(0)] public Luid AdapterId; [FieldOffset(8)] public uint SourceId; }

  [StructLayout(LayoutKind.Explicit, Size = 64)]
  struct ModeInfo { [FieldOffset(0)] public int InfoType; }

  [DllImport("user32.dll")]
  static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);

  [DllImport("user32.dll")]
  static extern int QueryDisplayConfig(uint flags, ref uint paths, [Out] PathInfo[] pathInfo, ref uint modes,
    [Out] ModeInfo[] modeInfo, IntPtr topology);

  [DllImport("user32.dll")]
  static extern int DisplayConfigGetDeviceInfo(ref GetScale request);

  [DllImport("user32.dll")]
  static extern int DisplayConfigSetDeviceInfo(ref SetScale request);

  const uint QDC_ONLY_ACTIVE_PATHS = 2;
  const int GET_DPI_SCALE = -3;
  const int SET_DPI_SCALE = -4;

  // The steps, from 100%, as Windows counts them.
  static readonly int[] Scales = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  static void Check(int status) {
    if (status != 0) throw new Win32Exception(status);
  }

  // The VM has one screen.
  static Header FirstScreen(int type, int size) {
    uint paths, modes;
    Check(GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out paths, out modes));
    var pathInfo = new PathInfo[paths];
    var modeInfo = new ModeInfo[modes];
    Check(QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref paths, pathInfo, ref modes, modeInfo, IntPtr.Zero));
    if (paths == 0) throw new InvalidOperationException("no screen");
    var header = new Header();
    header.Type = type;
    header.Size = size;
    header.AdapterId = pathInfo[0].AdapterId;
    header.Id = pathInfo[0].SourceId;
    return header;
  }

  // Sets the scale in percent, or the largest that Windows offers for this
  // screen size, when that is less. Returns the scale that the screen has.
  public static int Apply(int percent) {
    int wanted = Array.IndexOf(Scales, percent);
    if (wanted < 0) throw new ArgumentException("Windows has no " + percent + "% scale");
    var get = new GetScale();
    get.Header = FirstScreen(GET_DPI_SCALE, Marshal.SizeOf(typeof(GetScale)));
    Check(DisplayConfigGetDeviceInfo(ref get));
    // The smallest step is 100%, so it tells which step is the recommended one.
    int recommended = -get.MinStep;
    int target = Math.Min(wanted, recommended + get.MaxStep);
    if (recommended + get.CurrentStep != target) {
      var set = new SetScale();
      set.Header = FirstScreen(SET_DPI_SCALE, Marshal.SizeOf(typeof(SetScale)));
      set.Step = target - recommended;
      Check(DisplayConfigSetDeviceInfo(ref set));
    }
    return Scales[target];
  }
}
'@

function Wanted {
  $text = [IO.File]::ReadAllText($file) -replace "`r", ''
  if ($text -notmatch '^(default|[1-9][0-9]{2})\n$') {
    return $null
  }
  $line = $Matches[1]
  if ($line -eq 'default') { $default } else { [int]$line }
}

$watcher = New-Object IO.FileSystemWatcher $dir, 'screen-scale'
while ($true) {
  $wanted = if (Test-Path $file) { try { Wanted } catch { $null } } else { $default }
  if ($wanted) {
    # Set again on each pass, not only when the file changes: Windows keeps
    # the scale as a step from the recommended one, so a new screen size can
    # change it.
    try { [DisplayScale]::Apply($wanted) | Out-Null } catch {}
  }
  $watcher.WaitForChanged('All', 1000) | Out-Null
}
