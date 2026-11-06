# Renders C:\Program Files\3proxy\3proxy.cfg from the proxy that the host sets
# in C:\ProgramData\remotebrowser\proxy (see src/vm/proxy.js), and restarts the
# 3proxy service when the config changes. 3proxy is the local proxy the browser
# uses, as tinyproxy is in the Linux guest: it listens on 127.0.0.1:8119 and
# forwards to the upstream proxy, which may take a user and password. It runs
# as SYSTEM at each logon, since the config belongs to the machine, not to one
# session.
#
# The file holds one line: "direct", or a URL such as
# http://user:password@host:8080 or socks5://host:1080. Anything else, e.g. a
# write that the host did not finish, leaves the browser offline rather than
# going out directly.
$dir = 'C:\ProgramData\remotebrowser'
$file = Join-Path $dir 'proxy'
$config = 'C:\Program Files\3proxy\3proxy.cfg'
# Nothing listens there, so every request fails.
$offline = 'parent 1000 http 127.0.0.1 9'

# The proxy chain line for the file's line, '' for direct, or the offline line
# for anything else.
function Route {
  # No file is the image as it was built: direct.
  if (-not (Test-Path $file)) {
    return ''
  }
  try {
    $text = [IO.File]::ReadAllText($file) -replace "`r", ''
  } catch {
    return $offline
  }
  if ($text -eq "direct`n") {
    return ''
  }
  # The user and password may hold only the chars that the host allows, so they
  # need no escaping, but a $ would start a file name, so both are quoted.
  if ($text -match '^(http|socks4|socks5)://(([-A-Za-z0-9._~!$&*+,;=]+):([-A-Za-z0-9._~!$&*+,;=]*)@)?([a-z0-9][-a-z0-9.]*):([0-9]{1,5})\n\z') {
    $credentials = if ($Matches[3]) { " `"$($Matches[3])`" `"$($Matches[4])`"" } else { '' }
    return "parent 1000 $($Matches[1]) $($Matches[5]) $($Matches[6])$credentials"
  }
  $offline
}

# The whole config. 3proxy ends a command at CR, so the lines are CRLF.
function Config {
  $lines = @(
    '# Generated from C:\ProgramData\remotebrowser\proxy; do not edit.',
    'internal 127.0.0.1',
    'auth iponly',
    'allow *'
  )
  $route = Route
  if ($route) { $lines += $route }
  $lines += 'proxy -p8119'
  ($lines -join "`r`n") + "`r`n"
}

# What 3proxy runs with, for browser.ps1, which starts the browser only once
# the proxy that the host set at launch is in use, as chromium.service waits
# for tinyproxy-upstream.service on Linux. It holds the text of the proxy
# file, or nothing for no file.
$done = Join-Path $dir 'proxy-applied'

function Source {
  if (Test-Path $file) {
    try { [IO.File]::ReadAllText($file) -replace "`r", '' } catch { 'not readable' }
  } else {
    ''
  }
}

# The baked config already matches a missing file, so the first pass writes
# nothing.
$applied = $null
try { $applied = [IO.File]::ReadAllText($config) } catch {}
$watcher = New-Object IO.FileSystemWatcher $dir, 'proxy'
while ($true) {
  $source = Source
  $wanted = Config
  if ($wanted -ne $applied) {
    try {
      [IO.File]::WriteAllText($config, $wanted)
      if ((Get-Service 3proxy).Status -eq 'Running') {
        Restart-Service 3proxy
      } else {
        Start-Service 3proxy
      }
      $applied = $wanted
    } catch {}
  }
  # Not applied until 3proxy listens, so the browser never starts without it.
  $listening = $false
  if ($wanted -eq $applied) {
    try {
      if ((Get-Service 3proxy).Status -ne 'Running') {
        Start-Service 3proxy
      }
    } catch {}
    $listening = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
      Where-Object { $_.Port -eq 8119 -and $_.Address -eq [Net.IPAddress]::Loopback }
  }
  if ($listening) {
    try {
      if (-not (Test-Path $done) -or [IO.File]::ReadAllText($done) -ne $source) {
        [IO.File]::WriteAllText($done, $source)
      }
    } catch {}
  }
  # Also wakes up now and then, in case a change slipped past the watcher.
  $watcher.WaitForChanged('All', 1000) | Out-Null
}
