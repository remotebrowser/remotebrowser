# Sets the screen to the size that the host sets in
# C:\ProgramData\remotebrowser\screen-resolution (see
# src/vm/screen-resolution.js), as vm/linux/files/usr/local/bin/screen-resolution
# does in the Linux guest. It runs in the session of the user who logs in,
# since only that session can change its screen, and keeps watching the file.
#
# The file holds one line: the size, e.g. 1920x1080, or "default". Anything
# else, e.g. a write that the host did not finish, leaves the screen as it is.
$dir = 'C:\ProgramData\remotebrowser'
$file = Join-Path $dir 'screen-resolution'
# viogpures.exe from the virtio-win ISO sets any size; Windows itself only
# offers the GPU driver's list.
$tool = Join-Path $PSScriptRoot 'viogpures.exe'
# No file is the image as it was built: Full HD, as in src/vm/screen-resolution.js.
$default = '1920x1080'

function Wanted {
  $text = [IO.File]::ReadAllText($file) -replace "`r", ''
  if ($text -notmatch '^(default|[1-9][0-9]{2,3}x[1-9][0-9]{2,3})\n$') {
    return $null
  }
  $line = $Matches[1]
  if ($line -eq 'default') { $default } else { $line }
}

$applied = $null
$watcher = New-Object IO.FileSystemWatcher $dir, 'screen-resolution'
while ($true) {
  $wanted = if (Test-Path $file) { try { Wanted } catch { $null } } else { $default }
  if ($wanted -and $wanted -ne $applied) {
    $width, $height = $wanted -split 'x'
    # viogpures.exe writes its log to the working dir, which the user owns.
    $process = Start-Process $tool -ArgumentList $width, $height -Wait -PassThru -WindowStyle Hidden `
      -WorkingDirectory $env:TEMP
    if ($process.ExitCode -eq 0) {
      $applied = $wanted
    }
  }
  # Also wakes up now and then, in case a change slipped past the watcher.
  $watcher.WaitForChanged('All', 1000) | Out-Null
}
