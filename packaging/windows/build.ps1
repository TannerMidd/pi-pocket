# Builds Pi-Pocket-Setup-<version>.exe on Windows: the pinned Node.js zip and Inno Setup (each checked against the SHA256
# below), the desktop app (PiPocket.cs), and the pi-pocket package (packaging/bundle-app.mjs), so Setup needs no npm and no
# network.
#
#   pwsh packaging/windows/build.ps1 -Version 0.30.0 [-OutDir out] [-Source <checkout>] [-SignThumbprint <SHA1>]
#
# -Source is the checkout to pack (default: the one this script is in), with -Version in its package.json.
# -SignThumbprint signs Pi Pocket.exe, Setup, and its uninstaller with that certificate from the user's store.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutDir = (Join-Path $PSScriptRoot "out"),
    [string]$Source = (Join-Path $PSScriptRoot "..\.."),
    [string]$SignThumbprint = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# To move to another Node.js, take the win-x64.zip line of https://nodejs.org/dist/v<version>/SHASUMS256.txt.
$NodeVersion = "26.13.1"
$NodeSha256 = "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7"
# The SHA256 that https://github.com/jrsoftware/issrc/releases lists for the file.
$InnoVersion = "7.1.1"
$InnoSha256 = "8a5a6711c3766a6e5fb74f280ba0e3551e719ce94538d901fdbd1f8f9920b3f0"

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw "Version '$Version' is not a version such as 0.29.0 or 0.30.0-beta.1"
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) "pi-pocket-setup-build"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, $OutDir | Out-Null

function Get-Checked([string]$Url, [string]$File, [string]$Sha256) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant()

    if ($actual -ne $Sha256) {
        throw "SHA256 of $Url is $actual, not the pinned $Sha256"
    }

    Write-Host "SHA256 matches: $actual"
}

$nodeName = "node-v$NodeVersion-win-x64"
$nodeZip = Join-Path $work "$nodeName.zip"
Get-Checked "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip" $nodeZip $NodeSha256
Expand-Archive -Path $nodeZip -DestinationPath $work
$nodeDir = Join-Path $work $nodeName

if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
    throw "The Node.js zip has no $nodeName\node.exe"
}

$appDir = Join-Path $work "app"
& (Join-Path $nodeDir "node.exe") (Join-Path $PSScriptRoot "..\bundle-app.mjs") $Source $appDir $Version

if ($LASTEXITCODE -ne 0) {
    throw "bundle-app.mjs exited with $LASTEXITCODE"
}

# C# 5: the compiler that every Windows 10 and 11 has in its .NET Framework 4.x.
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) {
    throw "No C# compiler of the .NET Framework at $csc"
}

$desktop = Join-Path $work "desktop"
New-Item -ItemType Directory -Force $desktop | Out-Null
$numeric = ($Version -replace '-.*$', '') + ".0"
$source = Get-Content -Raw (Join-Path $PSScriptRoot "PiPocket.cs")
$source = $source.Replace('Version = "0.0.0-dev"', "Version = `"$Version`"")
$source = $source.Replace('NumericVersion = "0.0.0.0"', "NumericVersion = `"$numeric`"")
$sourceFile = Join-Path $desktop "PiPocket.cs"
[IO.File]::WriteAllText($sourceFile, $source, (New-Object Text.UTF8Encoding $false))
$appExe = Join-Path $desktop "Pi Pocket.exe"
& $csc /nologo /target:winexe /optimize+ /platform:anycpu /warnaserror+ `
    "/win32icon:$(Join-Path $PSScriptRoot 'pi-pocket.ico')" "/win32manifest:$(Join-Path $PSScriptRoot 'PiPocket.manifest')" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/out:$appExe" $sourceFile

if ($LASTEXITCODE -ne 0) {
    throw "csc exited with $LASTEXITCODE"
}

Write-Host "Built $appExe"

$innoSetup = Join-Path $work "innosetup-$InnoVersion-x64.exe"
$innoDir = Join-Path $work "inno"
Get-Checked "https://github.com/jrsoftware/issrc/releases/download/is-$($InnoVersion.Replace('.', '_'))/innosetup-$InnoVersion-x64.exe" $innoSetup $InnoSha256
$inno = Start-Process -FilePath $innoSetup -Wait -PassThru -ArgumentList @(
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/CURRENTUSER", "/NOICONS", "/DIR=`"$innoDir`""
)

if ($inno.ExitCode -ne 0) {
    throw "Inno Setup's installer exited with $($inno.ExitCode)"
}

$iscc = Join-Path $innoDir "ISCC.exe"

if (-not (Test-Path $iscc)) {
    throw "No ISCC.exe in $innoDir"
}

$arguments = @("/Qp", "/DAppVersion=$Version", "/DNodeDir=$nodeDir", "/DOutputDir=$OutDir", "/DDesktopDir=$desktop", "/DAppDir=$appDir")

if ($SignThumbprint -ne "") {
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $signtool = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1

    if ($null -eq $signtool) {
        throw "No signtool.exe in $kits"
    }

    & $signtool.FullName sign /sha1 $SignThumbprint /fd sha256 /tr http://timestamp.digicert.com /td sha256 $appExe

    if ($LASTEXITCODE -ne 0) {
        throw "signtool could not sign $appExe"
    }

    # ISCC puts a quote for each `$q and the quoted file name for `$f.
    $arguments += "/Ssigntool=`$q$($signtool.FullName)`$q sign /sha1 $SignThumbprint /fd sha256 /tr http://timestamp.digicert.com /td sha256 `$f"
    $arguments += "/DSign"
}

& $iscc @arguments (Join-Path $PSScriptRoot "pi-pocket.iss")

if ($LASTEXITCODE -ne 0) {
    throw "ISCC exited with $LASTEXITCODE"
}

$setup = Join-Path $OutDir "Pi-Pocket-Setup-$Version.exe"
Write-Host "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)"
Write-Host "SHA256 $((Get-FileHash -Algorithm SHA256 $setup).Hash.ToLowerInvariant())"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
