# Finds, and stops, a running Pi Pocket of one install. Setup and the uninstaller run it (pi-pocket.iss) with Windows
# PowerShell, and write what it prints to their logs.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File stop-pi-pocket.ps1 -App <install folder> [-Check]
#
# Processes are found by their executable path, whatever their command line says: the desktop app, the install's node.exe
# and what it started, Edge's processes for the app's window (by its profile folder), and the launcher's tunnel.
#
# -Check: exit 1 when Pi Pocket runs, 0 when not. Otherwise it asks the app to quit, waits up to 25 seconds, then ends what
# is left, again until none is left, as the launcher can start a new server.
param(
    [Parameter(Mandatory = $true)][string]$App,
    [switch]$Check
)

$ErrorActionPreference = "Continue"
$appExe = Join-Path $App "Pi Pocket.exe"
$nodeDir = (Join-Path $App "node") + "\"
$edgeProfile = Join-Path $App "Edge profile"
$cloudflared = (Join-Path $env:USERPROFILE ".pi-pocket\bin") + "\"

function Test-Under([string]$Path, [string]$Folder) {
    return $Path -and $Path.StartsWith($Folder, [StringComparison]::OrdinalIgnoreCase)
}

function Find-PiPocket {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $desktop = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($appExe, [StringComparison]::OrdinalIgnoreCase) })
    $rest = @($all | Where-Object {
            (Test-Under $_.ExecutablePath $nodeDir) -or
            (Test-Under $_.ExecutablePath $cloudflared) -or
            ($_.Name -eq "msedge.exe" -and $_.CommandLine -and $_.CommandLine.Contains($edgeProfile))
        })

    return @{ Desktop = $desktop; Rest = $rest }
}

function Show([string]$What, $Found) {
    foreach ($each in $Found.Desktop + $Found.Rest) {
        Write-Output "$What $($each.ProcessId) $($each.Name)"
    }
}

$found = Find-PiPocket
Show "Runs:" $found

if ($Check) {
    if ($found.Desktop.Count + $found.Rest.Count -gt 0) { exit 1 } else { exit 0 }
}

if ($found.Desktop.Count -gt 0) {
    & $appExe --quit
    for ($wait = 0; $wait -lt 25 -and (Find-PiPocket).Desktop.Count -gt 0; $wait++) {
        Start-Sleep -Seconds 1
    }
}

for ($round = 0; $round -lt 5; $round++) {
    $found = Find-PiPocket

    if ($found.Desktop.Count + $found.Rest.Count -eq 0) {
        Write-Output "Pi Pocket is stopped."
        exit 0
    }

    Show "Stopping:" $found

    # The desktop app alone: its job ends what it started, and a default browser that it opened stays.
    foreach ($each in $found.Desktop) {
        & taskkill.exe /F /PID $each.ProcessId 2>&1 | Out-Null
    }

    foreach ($each in $found.Rest) {
        & taskkill.exe /F /T /PID $each.ProcessId 2>&1 | Out-Null
    }

    Start-Sleep -Seconds 1
}

Show "Still runs:" (Find-PiPocket)
exit 1
