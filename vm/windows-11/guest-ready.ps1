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
$port = New-Object System.IO.Ports.SerialPort 'COM1', 115200
$port.Open()
$port.WriteLine('remotebrowser: guest ready')
$port.Close()
