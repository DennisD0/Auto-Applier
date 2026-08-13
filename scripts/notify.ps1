<#
.SYNOPSIS
  Desktop notification for the auto-apply rig.

.DESCRIPTION
  Tries three delivery methods in order and uses the first that works:
    1. BurntToast module, if it happens to be installed
    2. Raw WinRT toast via Windows.UI.Notifications (no install needed)
    3. Tray balloon tip via System.Windows.Forms (always available fallback)

  Exits 0 if any method delivered, 1 if all failed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File notify.ps1 -Title "3 ready" -Message "Tabs 2-4"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet('info', 'warning', 'critical')][string]$Level = 'info'
)

$ErrorActionPreference = 'Stop'

function Send-ViaBurntToast {
    if (-not (Get-Module -ListAvailable -Name BurntToast)) { return $false }
    try {
        Import-Module BurntToast -ErrorAction Stop
        New-BurntToastNotification -Text $Title, $Message -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Send-ViaWinRT {
    try {
        # WinRT projections are loaded by type name, not by assembly reference.
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

        # PowerShell's registered AUMID — present on every Windows install, so the toast has a
        # valid identity without us registering a Start Menu shortcut.
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

        $esc = {
            param($s)
            $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;'
        }

        $xml = @"
<toast scenario="$(if ($Level -eq 'critical') { 'urgent' } else { 'default' })">
  <visual>
    <binding template="ToastGeneric">
      <text>$(& $esc $Title)</text>
      <text>$(& $esc $Message)</text>
    </binding>
  </visual>
</toast>
"@

        $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
        $doc.LoadXml($xml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
        return $true
    } catch { return $false }
}

function Send-ViaBalloon {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Information
        $icon.BalloonTipTitle = $Title
        $icon.BalloonTipText = $Message
        $icon.Visible = $true
        $icon.ShowBalloonTip(10000)
        Start-Sleep -Seconds 6   # the balloon dies with the NotifyIcon, so hold it briefly
        $icon.Dispose()
        return $true
    } catch { return $false }
}

foreach ($method in 'Send-ViaBurntToast', 'Send-ViaWinRT', 'Send-ViaBalloon') {
    if (& $method) {
        Write-Output "notified via $method"
        exit 0
    }
}

Write-Error 'All notification methods failed.'
exit 1
