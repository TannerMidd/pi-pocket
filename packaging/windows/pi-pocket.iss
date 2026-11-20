; Pi Pocket's Windows installer (Inno Setup). It installs for the current user only, without admin rights:
; - a portable Node.js (the official win-x64 zip, checked by build.ps1) in {app}\node;
; - the pi-pocket npm package in a private npm prefix, {app}\app, which the user owns, so in-app updates work;
; - pi-pocket.cmd, which starts the launcher with that Node.js and prefix, and Start menu and sign-in shortcuts.
; build.ps1 compiles it: ISCC /DAppVersion=0.29.0 /DNodeDir=<unpacked Node.js> pi-pocket.iss
; Setup takes /PACKAGE=<npm spec or .tgz> to install another package than pi-pocket@<AppVersion> (the CI test does).

#ifndef AppVersion
  #error Define AppVersion, such as /DAppVersion=0.29.0
#endif
#ifndef NodeDir
  #error Define NodeDir, the folder of the unpacked Node.js zip
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif

[Setup]
AppId={{6D3A0E52-7C1B-4F7E-9B8E-2A4C5D9F1E37}
AppName=Pi Pocket
AppVersion={#AppVersion}
AppVerName=Pi Pocket {#AppVersion}
AppPublisher=Tanner Middleton
AppPublisherURL=https://tannermidd.github.io/pi-pocket/
AppSupportURL=https://github.com/TannerMidd/pi-pocket/issues
AppUpdatesURL=https://github.com/TannerMidd/pi-pocket/releases
DefaultDirName={localappdata}\Pi Pocket
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=Pi-Pocket-Setup-{#AppVersion}
SetupIconFile=pi-pocket.ico
UninstallDisplayIcon={app}\pi-pocket.ico
UninstallDisplayName=Pi Pocket
LicenseFile=..\..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Setup stops a running Pi Pocket itself (StopPiPocket below), with the user's yes.
CloseApplications=no
#ifdef Sign
SignTool=signtool
SignedUninstaller=yes
#endif

[Tasks]
Name: startup; Description: "Start Pi Pocket when I sign in to Windows"; Flags: unchecked

[InstallDelete]
; An older Node.js must not leave files behind in the new one.
Type: filesandordirs; Name: "{app}\node"
Type: files; Name: "{autostartup}\Pi Pocket.lnk"; Tasks: not startup

[Files]
Source: "{#NodeDir}\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "pi-pocket.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-app.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "pi-pocket.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Pi Pocket"; Filename: "{app}\pi-pocket.cmd"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\pi-pocket.ico"; Comment: "Start the Pi Pocket server"
Name: "{autostartup}\Pi Pocket"; Filename: "{app}\pi-pocket.cmd"; Parameters: "--yes"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\pi-pocket.ico"; Flags: runminimized; Tasks: startup

[Run]
Filename: "{app}\pi-pocket.cmd"; WorkingDir: "{%USERPROFILE}"; Description: "Start Pi Pocket now"; Flags: postinstall nowait skipifsilent shellexec; Check: AppInstalled

[UninstallDelete]
; npm made these, so Inno Setup does not know their files.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\npm-cache"
Type: filesandordirs; Name: "{app}\node"
Type: files; Name: "{app}\install.log"
Type: dirifempty; Name: "{app}"

[Code]
var
  InstallFailed: Boolean;

function AppInstalled: Boolean;
begin
  Result := not InstallFailed;
end;

{ PowerShell with a script that has no outside input but the install folder, quoted for a single-quoted string. }
function RunPowerShell(const Script: String): Integer;
var
  Code: Integer;
begin
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Result := Code;
end;

{ The node.exe processes that run from this install: the launcher, the server, and their Node.js children. }
function NodeProcesses: String;
var
  Folder: String;
begin
  Folder := ExpandConstant('{app}\node\');
  StringChangeEx(Folder, '''', '''''', True);
  Result := '@(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ' +
    '$_.Path.StartsWith(''' + Folder + ''', [StringComparison]::OrdinalIgnoreCase) })';
end;

function PiPocketRunning: Boolean;
begin
  Result := RunPowerShell('if (' + NodeProcesses + '.Count -gt 0) { exit 1 } else { exit 0 }') = 1;
end;

{ Also the launcher's cloudflared (the tunnel) from the data folder, which would run on without it. }
procedure StopPiPocket;
var
  Tunnel: String;
begin
  Tunnel := ExpandConstant('{%USERPROFILE}\.pi-pocket\bin\');
  StringChangeEx(Tunnel, '''', '''''', True);
  RunPowerShell('$all = ' + NodeProcesses + ' + @(Get-Process -Name cloudflared -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -and $_.Path.StartsWith(''' + Tunnel + ''', [StringComparison]::OrdinalIgnoreCase) }); ' +
    '$all | ForEach-Object { try { $_.Kill() } catch {} }; $all | ForEach-Object { try { $null = $_.WaitForExit(10000) } catch {} }');
end;

{ Ask, then stop it. Silent setup takes the default answer: stop it. }
function MayStopPiPocket(const Action: String): Boolean;
begin
  Result := True;

  if not PiPocketRunning then
    exit;

  if SuppressibleMsgBox('Pi Pocket is running. ' + Action + ' must stop it first.' + #13#10#13#10 +
    'Work in progress continues when Pi Pocket starts again.', mbConfirmation, MB_OKCANCEL, IDOK) <> IDOK then
  begin
    Result := False;
    exit;
  end;

  StopPiPocket;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';

  if not MayStopPiPocket('Setup') then
    Result := 'Pi Pocket is still running. Quit it (press q in its window), then run Setup again.';
end;

function PackageSpec: String;
begin
  Result := ExpandConstant('{param:PACKAGE|pi-pocket@{#AppVersion}}');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;

  WizardForm.StatusLabel.Caption := 'Installing the pi-pocket package from npm. This can take a few minutes...';
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    if not Exec(ExpandConstant('{app}\node\node.exe'),
      AddQuotes(ExpandConstant('{app}\install-app.mjs')) + ' ' + AddQuotes(PackageSpec) + ' {#AppVersion}',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then
      Code := -1;
  finally
    WizardForm.ProgressGauge.Style := npbstNormal;
  end;

  Log('install-app.mjs exited with ' + IntToStr(Code));

  if Code <> 0 then
  begin
    InstallFailed := True;
    SuppressibleMsgBox('Setup could not install the pi-pocket package from npm (exit code ' + IntToStr(Code) + ').' + #13#10#13#10 +
      'Check the internet connection, then run Setup again. The details are in:' + #13#10 +
      ExpandConstant('{app}\install.log'), mbError, MB_OK, IDOK);
  end;
end;

{ Silent installs report a failed npm step through the exit code. }
function GetCustomSetupExitCode: Integer;
begin
  if InstallFailed then
    Result := 20
  else
    Result := 0;
end;

function GitBashFound: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf64}\Git\bin\bash.exe')) or
    FileExists(ExpandConstant('{commonpf32}\Git\bin\bash.exe'));
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and not InstallFailed and not GitBashFound then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
      'Pi''s bash tool needs Git for Windows (https://git-scm.com/download/win), unless bash.exe is on your PATH.';
end;

function InitializeUninstall: Boolean;
begin
  Result := MayStopPiPocket('Uninstall');
end;

{ The data folder holds sessions, sign-ins, and settings. Keep it unless the user says yes; silent uninstall keeps it. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep <> usPostUninstall then
    exit;

  Data := ExpandConstant('{%USERPROFILE}\.pi-pocket');

  if not DirExists(Data) then
    exit;

  if SuppressibleMsgBox('Also delete your Pi Pocket data?' + #13#10#13#10 + Data + #13#10#13#10 +
    'It holds your sessions, sign-ins, settings, and extensions. Another Pi Pocket install on this account uses it too. ' +
    'Choose No to keep it.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
    DelTree(Data, True, True, True);
end;
