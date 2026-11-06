# Runs Microsoft Edge with CDP on, as chromium.service does Chromium in the
# Linux guest. It runs in the session of the user who logs in, since the
# browser shows on that desktop.
#
# Edge does not start at logon. Every VM starts from a snapshot of a logged-in
# guest, and a browser that was already running in it would keep the
# snapshot's random number state, the same in every VM. So it waits until the
# host, once it has set the clock, writes the file below (see
# src/vm/browser-app.js). It then starts Edge again whenever Edge exits.
$dir = 'C:\ProgramData\remotebrowser'
$start = Join-Path $dir 'start-browser'
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
# Edge, like Chromium, listens on 127.0.0.1 only. A port proxy, set up in
# remotebrowser-setup.ps1, exposes it on 9222, which QEMU forwards to the host.
$port = 9221
$profileDir = Join-Path $env:LOCALAPPDATA 'remotebrowser\profile'

# What proxy.ps1 last set 3proxy from. 3proxy, like tinyproxy on Linux,
# listens on 127.0.0.1:8119 and forwards to the upstream proxy.
$proxy = Join-Path $dir 'proxy'
$proxyApplied = Join-Path $dir 'proxy-applied'

function ProxyApplied {
  try {
    $wanted = if (Test-Path $proxy) { [IO.File]::ReadAllText($proxy) -replace "`r", '' } else { '' }
    (Test-Path $proxyApplied) -and [IO.File]::ReadAllText($proxyApplied) -eq $wanted
  } catch {
    $false
  }
}

# The browser process, not its helpers, which have a --type flag.
function Running {
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -like "*--remote-debugging-port=$port*" -and $_.CommandLine -notlike '*--type=*' }
}

# The first WMI query and COM call in a process are slow. Make them now, so
# they are done in the snapshot and not at every launch.
$shell = New-Object -ComObject WScript.Shell
$null = Running

# Not before the proxy is in use, so even the first request takes that
# route. A proxy that is never set keeps the browser from starting, and the
# host gives up on it.
while (-not (Test-Path $start) -or -not (ProxyApplied)) {
  Start-Sleep -Milliseconds 200
}

# Windows opens the Start menu at the first logon, so the snapshot has it
# open, above the browser window. Esc closes it.
$shell.SendKeys('{ESC}')

while ($true) {
  if (-not (Running)) {
    $flags = @(
      "--remote-debugging-port=$port",
      '--proxy-server=http://127.0.0.1:8119',
      "--user-data-dir=`"$profileDir`"",
      '--start-maximized',
      '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
      '--disable-background-networking', '--disable-component-update',
      '--disable-domain-reliability', '--disable-sync', '--no-pings'
    )
    # Written by the host at launch (see src/vm/webgl.js). The VM has no GPU.
    if (Test-Path (Join-Path $dir 'webgl')) {
      $flags += '--ignore-gpu-blocklist'
    }
    Start-Process $edge -ArgumentList ($flags + 'about:blank')
  }
  Start-Sleep -Seconds 2
}
