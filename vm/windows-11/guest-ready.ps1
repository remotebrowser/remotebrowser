# Runs as SYSTEM at each logon. Once screen-resolution.ps1 has set the default
# screen, it writes the line that src/vm/snapshot.js waits for, as
# guest-ready.service does in the Linux guest. So the snapshot, and every VM
# started from it, has that screen.
$deadline = (Get-Date).AddMinutes(2)
while ((Get-Date) -lt $deadline) {
  $screen = Get-CimInstance Win32_VideoController |
    Where-Object { $_.CurrentHorizontalResolution -eq 1920 -and $_.CurrentVerticalResolution -eq 1080 }
  if ($screen) { break }
  Start-Sleep -Milliseconds 500
}

# Windows fills its free memory with file cache, the standby list, so it would
# all be in the snapshot, which every VM then loads. Free it, and give Windows
# a moment to zero those pages, which QEMU leaves out of the snapshot.
try {
  Add-Type @'
using System.Runtime.InteropServices;
public static class MemoryList {
  [DllImport("ntdll.dll")] static extern int RtlAdjustPrivilege(int privilege, bool enable, bool thread, out bool was);
  [DllImport("ntdll.dll")] static extern int NtSetSystemInformation(int infoClass, ref int command, int length);
  public static int PurgeStandby() {
    bool was;
    // SeProfileSingleProcessPrivilege, which SYSTEM has but must turn on.
    RtlAdjustPrivilege(13, true, false, out was);
    // SystemMemoryListInformation, MemoryPurgeStandbyList.
    int command = 4;
    return NtSetSystemInformation(80, ref command, 4);
  }
}
'@
  [MemoryList]::PurgeStandby() | Out-Null
  Start-Sleep -Seconds 5
} catch {}
$port = New-Object System.IO.Ports.SerialPort 'COM1', 115200
$port.Open()
$port.WriteLine('remotebrowser: guest ready')
$port.Close()
