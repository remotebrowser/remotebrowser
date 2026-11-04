# Runs once, as SYSTEM, at the end of Windows Setup, from SetupComplete.cmd
# (see autounattend.xml). It prepares the guest for the snapshot, then shuts
# it down, which tells src/vm/windows-image.js that the image is done. Each step
# reports to COM1, which the host keeps in console.log.
$ErrorActionPreference = 'Stop'

function Report($message) {
  $port = New-Object System.IO.Ports.SerialPort 'COM1', 115200
  $port.Open()
  $port.WriteLine("remotebrowser: $message")
  $port.Close()
}

function Install($msi) {
  $process = Start-Process msiexec.exe -Wait -PassThru -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart'
  # 3010 means it is installed, and wants a restart.
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "$msi failed with exit code $($process.ExitCode)"
  }
}

function SetValue($key, $name, $value) {
  try {
    if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
    Set-ItemProperty $key $name $value -Type DWord
  } catch {
    Report "could not set $key\${name}: $_"
  }
}

# Each Windows build has its own set of apps, services and tasks, and some of
# them it will not remove or stop. So none of these steps can fail the setup.
function Debloat {
  $apps = 'Clipchamp.Clipchamp', 'Microsoft.BingNews', 'Microsoft.BingSearch', 'Microsoft.BingWeather',
    'Microsoft.GamingApp', 'Microsoft.GetHelp', 'Microsoft.MicrosoftOfficeHub',
    'Microsoft.MicrosoftSolitaireCollection', 'Microsoft.MicrosoftStickyNotes', 'Microsoft.OutlookForWindows',
    'Microsoft.Paint', 'Microsoft.PowerAutomateDesktop', 'Microsoft.ScreenSketch', 'Microsoft.Todos',
    'Microsoft.Windows.DevHome', 'Microsoft.Windows.Photos', 'Microsoft.WindowsAlarms', 'Microsoft.WindowsCamera',
    'Microsoft.WindowsFeedbackHub', 'Microsoft.WindowsSoundRecorder', 'Microsoft.WindowsStore',
    'Microsoft.Xbox.TCUI', 'Microsoft.XboxGamingOverlay', 'Microsoft.XboxIdentityProvider',
    'Microsoft.XboxSpeechToTextOverlay', 'Microsoft.YourPhone', 'Microsoft.ZuneMusic',
    'MicrosoftCorporationII.QuickAssist', 'MicrosoftWindows.Client.WebExperience', 'MicrosoftWindows.CrossDevice',
    'MSTeams', 'Microsoft.Copilot', 'Microsoft.Windows.Ai.Copilot.Provider', 'Microsoft.549981C3F5F10'
  # The user logs in for the first time after this, so an app that is no
  # longer provisioned is never installed for them.
  Get-AppxProvisionedPackage -Online | Where-Object DisplayName -in $apps | ForEach-Object {
    try { Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName | Out-Null } catch {}
  }
  Get-AppxPackage -AllUsers | Where-Object Name -in $apps | ForEach-Object {
    try { Remove-AppxPackage -Package $_.PackageFullName -AllUsers } catch {}
  }

  # No apps, tips, widgets, Copilot or OneDrive that Windows would add or start
  # on its own, and no telemetry.
  $policies = 'HKLM:\SOFTWARE\Policies\Microsoft'
  SetValue "$policies\Windows\CloudContent" DisableWindowsConsumerFeatures 1
  SetValue "$policies\Windows\CloudContent" DisableSoftLanding 1
  SetValue "$policies\Windows\CloudContent" DisableCloudOptimizedContent 1
  SetValue "$policies\Windows\DataCollection" AllowTelemetry 0
  SetValue "$policies\Dsh" AllowNewsAndInterests 0
  SetValue "$policies\Windows\Windows Chat" ChatIcon 3
  SetValue "$policies\Windows\WindowsCopilot" TurnOffWindowsCopilot 1
  SetValue "$policies\Windows\Windows Search" AllowCortana 0
  SetValue "$policies\Windows\Windows Search" DisableWebSearch 1
  SetValue "$policies\Windows\OneDrive" DisableFileSyncNGSC 1
  SetValue "$policies\Windows\Explorer" DisableSearchBoxSuggestions 1

  # The same for the user, through the profile it is made from.
  reg load 'HKU\Default' 'C:\Users\Default\NTUSER.DAT' | Out-Null
  if ($LASTEXITCODE -eq 0) {
    try {
      Remove-ItemProperty 'Registry::HKU\Default\Software\Microsoft\Windows\CurrentVersion\Run' OneDriveSetup `
        -ErrorAction SilentlyContinue
      $delivery = 'Registry::HKU\Default\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
      foreach ($name in 'ContentDeliveryAllowed', 'FeatureManagementEnabled', 'OemPreInstalledAppsEnabled',
        'PreInstalledAppsEnabled', 'SilentInstalledAppsEnabled', 'SoftLandingEnabled', 'SubscribedContentEnabled',
        'SystemPaneSuggestionsEnabled') {
        SetValue $delivery $name 0
      }
      $advanced = 'Registry::HKU\Default\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
      SetValue $advanced TaskbarDa 0
      SetValue $advanced TaskbarMn 0
      SetValue $advanced ShowCopilotButton 0
      SetValue 'Registry::HKU\Default\Software\Microsoft\Windows\CurrentVersion\Search' SearchboxTaskbarMode 0
    } finally {
      # The hive stays in use while anything still refers to it.
      [GC]::Collect()
      [GC]::WaitForPendingFinalizers()
      reg unload 'HKU\Default' | Out-Null
    }
  }

  # Services that fill the memory with file caches and search indexes, or
  # that serve hardware and features a browser VM does not have.
  $services = 'SysMain', 'WSearch', 'DiagTrack', 'dmwappushservice', 'DoSvc', 'MapsBroker', 'lfsvc',
    'WSAIFabricSvc', 'edgeupdate', 'edgeupdatem', 'PcaSvc', 'TrkWks', 'WerSvc', 'RetailDemo', 'PhoneSvc',
    'Fax', 'WpcMonSvc', 'XblAuthManager', 'XblGameSave', 'XboxGipSvc', 'XboxNetApiSvc', 'wisvc', 'SSDPSRV',
    'lmhosts', 'WbioSrvc', 'TabletInputService', 'CDPSvc'
  foreach ($name in $services) {
    try { Set-Service $name -StartupType Disabled -ErrorAction Stop } catch {}
  }

  # Tasks that collect data or keep the disk busy after the snapshot.
  $tasks = '\Microsoft\Windows\Application Experience\', '\Microsoft\Windows\Customer Experience Improvement Program\',
    '\Microsoft\Windows\Feedback\Siuf\', '\Microsoft\Windows\Windows Error Reporting\',
    '\Microsoft\Windows\DiskDiagnostic\', '\Microsoft\Windows\Defrag\', '\Microsoft\Windows\Maintenance\',
    '\Microsoft\Windows\Maps\', '\Microsoft\Windows\CloudExperienceHost\', '\Microsoft\Windows\Autochk\',
    '\Microsoft\Windows\Flighting\', '\Microsoft\Windows\WindowsAI\'
  foreach ($path in $tasks) {
    Get-ScheduledTask -TaskPath $path -ErrorAction SilentlyContinue | ForEach-Object {
      try { Disable-ScheduledTask -InputObject $_ | Out-Null } catch {}
    }
  }
}

try {
  # The serial driver that the guest agent talks over, the entropy one, and
  # the GPU one, which takes any screen size. Then the agent itself, which
  # the host sets the clock and the screen size through. Only these drivers:
  # virtio-win's own installer fails on some Windows builds.
  $virtio = Get-PSDrive -PSProvider FileSystem |
    Where-Object { Test-Path (Join-Path $_.Root 'guest-agent\qemu-ga-x86_64.msi') } |
    Select-Object -First 1
  if (-not $virtio) {
    throw 'the virtio-win CD is missing'
  }
  $os = if ([Environment]::OSVersion.Version.Build -ge 22000) { 'w11' } else { 'w10' }
  foreach ($driver in 'vioserial', 'viorng', 'viogpudo') {
    Report "installing the $driver driver"
    pnputil /add-driver (Join-Path $virtio.Root "$driver\$os\amd64\*.inf") /install | Out-Null
    # 259: no device needed it; 3010: it wants a restart.
    if ($LASTEXITCODE -notin 0, 259, 3010) {
      throw "pnputil failed for $driver with exit code $LASTEXITCODE"
    }
  }
  Report 'installing the guest agent'
  Install (Join-Path $virtio.Root 'guest-agent\qemu-ga-x86_64.msi')
  if (-not (Get-Service QEMU-GA -ErrorAction SilentlyContinue)) {
    throw 'the guest agent service is missing'
  }

  # QEMU keeps the hardware clock in UTC, as Linux does.
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation' RealTimeIsUniversal 1 -Type DWord

  # A VM that sleeps or hibernates stops answering; the host suspends it instead.
  powercfg /hibernate off
  powercfg /change monitor-timeout-ac 0
  powercfg /change standby-timeout-ac 0
  powercfg /change disk-timeout-ac 0

  # Every VM starts from the same snapshot, so updates there would download
  # again in each VM. A new image build gets them instead.
  New-Item 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Force | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoUpdate 1 -Type DWord

  # Less of Windows, as tiny11 and NTLite make it, but keeping Edge and
  # WebView2. What runs in the guest fills its memory, and that memory is in
  # the snapshot, which every VM loads at launch.
  Report 'removing apps and services the browser does not need'
  Debloat

  # 10.0.2.2 is the host's loopback in QEMU user-mode networking. Block new
  # connections to it, as vm/linux/files/etc/nftables.conf does for Linux.
  New-NetFirewallRule -DisplayName 'Block the host loopback' -Direction Outbound `
    -RemoteAddress 10.0.2.2 -Action Block | Out-Null

  # Autologon at every boot, not only the first few, so the snapshot has a
  # desktop.
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $winlogon AutoAdminLogon '1'
  Set-ItemProperty $winlogon DefaultUserName 'browser'
  Set-ItemProperty $winlogon DefaultPassword '{{PASSWORD}}'
  Remove-ItemProperty $winlogon AutoLogonCount -ErrorAction SilentlyContinue

  # The scripts that run at each logon, where users may not change them.
  # The unattend CD is gone once the image is built.
  $unattend = Get-PSDrive -PSProvider FileSystem |
    Where-Object { Test-Path (Join-Path $_.Root 'screen-resolution.ps1') } |
    Select-Object -First 1
  if (-not $unattend) {
    throw 'the unattend CD is missing'
  }
  $programs = 'C:\Program Files\remotebrowser'
  New-Item $programs -ItemType Directory -Force | Out-Null
  Copy-Item (Join-Path $unattend.Root 'screen-resolution.ps1'), (Join-Path $unattend.Root 'screen-scale.ps1'), `
    (Join-Path $unattend.Root 'proxy.ps1'), (Join-Path $unattend.Root 'browser.ps1'), `
    (Join-Path $unattend.Root 'guest-ready.ps1') $programs
  Copy-Item (Join-Path $virtio.Root "viogpudo\$os\amd64\viogpures.exe") $programs

  # 3proxy, the local proxy the browser will use, as tinyproxy is in the Linux
  # guest (see src/vm/proxy.js). It listens on 127.0.0.1:8119 and forwards to
  # the upstream proxy that the host sets. The image as it was built goes out
  # directly; proxy.ps1 rewrites this config and restarts the service.
  Report 'installing 3proxy'
  $three = 'C:\Program Files\3proxy'
  New-Item $three -ItemType Directory -Force | Out-Null
  Expand-Archive -Path (Join-Path $unattend.Root '3proxy.zip') -DestinationPath $three -Force
  Copy-Item (Join-Path $three '3proxy\bin64\3proxy.exe') (Join-Path $three '3proxy.exe')
  Remove-Item (Join-Path $three '3proxy') -Recurse -Force
  $cfg = @(
    '# Generated from C:\ProgramData\remotebrowser\proxy; do not edit.',
    'internal 127.0.0.1',
    'auth iponly',
    'allow *',
    'proxy -p8119'
  )
  [IO.File]::WriteAllText((Join-Path $three '3proxy.cfg'), ($cfg -join "`r`n") + "`r`n")
  # The service that `3proxy.exe --install` would add, without the license
  # box it shows first, which nobody can click here. The config path is given,
  # so the service holds it, not the directory it ran in.
  New-Service -Name 3proxy -DisplayName '3proxy tiny proxy server' -StartupType Automatic `
    -BinaryPathName "`"$three\3proxy.exe`" `"$three\3proxy.cfg`" --service" | Out-Null

  # The host writes the screen size and scale, and the proxy, here through
  # the guest agent. Users may read them, but not change them.
  $config = 'C:\ProgramData\remotebrowser'
  New-Item $config -ItemType Directory -Force | Out-Null
  icacls $config /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'Users:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls failed with exit code $LASTEXITCODE"
  }

  # Only a task for the Users group runs in the session of whoever logs in,
  # and it must run for as long as that session does.
  $forever = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries
  $logon = New-ScheduledTaskTrigger -AtLogOn
  $screen = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$programs\screen-resolution.ps1`""
  Register-ScheduledTask -TaskName 'remotebrowser-screen-resolution' -Action $screen -Trigger $logon `
    -Principal (New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users') -Settings $forever | Out-Null
  $scale = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$programs\screen-scale.ps1`""
  Register-ScheduledTask -TaskName 'remotebrowser-screen-scale' -Action $scale -Trigger $logon `
    -Principal (New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users') -Settings $forever | Out-Null
  # 3proxy runs as a service, so the task that configures it is a SYSTEM one,
  # not one in the session of the user who logs in.
  $proxy = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$programs\proxy.ps1`""
  Register-ScheduledTask -TaskName 'remotebrowser-proxy' -Action $proxy -Trigger $logon `
    -User 'SYSTEM' -RunLevel Highest -Settings $forever | Out-Null
  $browser = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$programs\browser.ps1`""
  Register-ScheduledTask -TaskName 'remotebrowser-browser' -Action $browser -Trigger $logon `
    -Principal (New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users') -Settings $forever | Out-Null

  # Edge listens for CDP on 127.0.0.1 only, but QEMU forwards the host port to
  # the guest's own address, as cdp-proxy.service handles in the Linux guest.
  # The port proxy needs the IP Helper service.
  Set-Service iphlpsvc -StartupType Automatic
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9222 `
    connectaddress=127.0.0.1 connectport=9221 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "netsh portproxy failed with exit code $LASTEXITCODE"
  }
  New-NetFirewallRule -DisplayName 'CDP from the host' -Direction Inbound -Protocol TCP -LocalPort 9222 `
    -Action Allow -Profile Any | Out-Null

  # Edge comes with Windows. Keep it from asking questions on its first run or
  # offering to translate a page, from running in the background, and so at
  # logon in the snapshot, and from changing itself under a running VM.
  $edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
  New-Item $edge -Force | Out-Null
  Set-ItemProperty $edge HideFirstRunExperience 1 -Type DWord
  Set-ItemProperty $edge StartupBoostEnabled 0 -Type DWord
  Set-ItemProperty $edge BackgroundModeEnabled 0 -Type DWord
  Set-ItemProperty $edge DefaultBrowserSettingEnabled 0 -Type DWord
  Set-ItemProperty $edge BrowserSignin 0 -Type DWord
  Set-ItemProperty $edge SyncDisabled 1 -Type DWord
  Set-ItemProperty $edge TranslateEnabled 0 -Type DWord
  $update = 'HKLM:\SOFTWARE\Policies\Microsoft\EdgeUpdate'
  New-Item $update -Force | Out-Null
  Set-ItemProperty $update UpdateDefault 0 -Type DWord
  Set-ItemProperty $update AutoUpdateCheckPeriodMinutes 0 -Type DWord

  $ready = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$programs\guest-ready.ps1`""
  Register-ScheduledTask -TaskName 'remotebrowser-guest-ready' -Action $ready -Trigger $logon `
    -User 'SYSTEM' -RunLevel Highest | Out-Null

  # The script holds the password, which the browser must not read.
  Remove-Item (Join-Path $PSScriptRoot 'remotebrowser-setup.ps1')
  Report 'windows setup done'
} catch {
  Report "windows setup failed: $_"
}
Stop-Computer -Force
