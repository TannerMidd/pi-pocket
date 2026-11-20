; Pi Pocket's Windows installer (Inno Setup). It installs for the current user only, without admin rights:
; - a portable Node.js (the official win-x64 zip, checked by build.ps1) in {app}\node;
; - the pi-pocket npm package in a private npm prefix, {app}\app, which the user owns, so in-app updates work;
; - Pi Pocket.exe, the desktop app (PiPocket.cs): an icon in the notification area and a window, with no console;
; - pi-pocket.cmd, which starts the launcher with that Node.js and prefix in a console, and Start menu and sign-in
;   shortcuts.
; build.ps1 compiles it: ISCC /DAppVersion=0.29.0 /DNodeDir=<unpacked Node.js> /DDesktopDir=<Pi Pocket.exe's folder>
; pi-pocket.iss
; Setup takes /PACKAGE=<npm spec or .tgz> to install another package than pi-pocket@<AppVersion> (the CI test does).

#ifndef AppVersion
  #error Define AppVersion, such as /DAppVersion=0.29.0
#endif
#ifndef NodeDir
  #error Define NodeDir, the folder of the unpacked Node.js zip
#endif
#ifndef DesktopDir
  #error Define DesktopDir, the folder of the compiled Pi Pocket.exe
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
UninstallDisplayIcon={app}\Pi Pocket.exe
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
Source: "{#DesktopDir}\Pi Pocket.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "pi-pocket.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-app.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "pi-pocket.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "stop-pi-pocket.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The app, and the console launcher for access modes, tunnels, and the sign-in QR code. The sign-in shortcut starts the
; app with its icon only, without a window.
Name: "{autoprograms}\Pi Pocket"; Filename: "{app}\Pi Pocket.exe"; WorkingDir: "{%USERPROFILE}"; Comment: "Open Pi Pocket"
Name: "{autoprograms}\Pi Pocket (console)"; Filename: "{app}\pi-pocket.cmd"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\pi-pocket.ico"; Comment: "Start Pi Pocket in a console window, to choose how other devices reach it"
Name: "{autostartup}\Pi Pocket"; Filename: "{app}\Pi Pocket.exe"; Parameters: "--hidden"; WorkingDir: "{%USERPROFILE}"; Tasks: startup

[Run]
Filename: "{app}\Pi Pocket.exe"; WorkingDir: "{%USERPROFILE}"; Description: "Open Pi Pocket now"; Flags: postinstall nowait skipifsilent; Check: AppInstalled

[UninstallDelete]
; npm made these, so Inno Setup does not know their files.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\npm-cache"
Type: filesandordirs; Name: "{app}\node"
Type: files; Name: "{app}\install.log"
Type: files; Name: "{app}\launcher.log"
Type: files; Name: "{app}\launcher.old.log"
; The app window's Edge profile, with its sign-in cookie.
Type: filesandordirs; Name: "{app}\Edge profile"
Type: dirifempty; Name: "{app}"

[Code]
var
  InstallFailed: Boolean;

function AppInstalled: Boolean;
begin
  Result := not InstallFailed;
end;

{ stop-pi-pocket.ps1 with Windows PowerShell, for this install: what it prints goes to Setup's or the uninstaller's
  log. Setup runs its own copy from its temporary folder; the uninstaller the one in the install folder, which it
  deletes after. }
function RunStopScript(const Arguments: String): Integer;
var
  Script: String;
  Code, Index: Integer;
  Output: TExecOutput;
begin
  if IsUninstaller then
    Script := ExpandConstant('{app}\stop-pi-pocket.ps1')
  else
  begin
    ExtractTemporaryFile('stop-pi-pocket.ps1');
    Script := ExpandConstant('{tmp}\stop-pi-pocket.ps1');
  end;

  if not ExecAndCaptureOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + AddQuotes(Script) + ' -App ' +
    AddQuotes(ExpandConstant('{app}')) + Arguments, '', SW_HIDE, ewWaitUntilTerminated, Code, Output) then
    Code := -1;

  for Index := 0 to GetArrayLength(Output.StdOut) - 1 do
    Log(Output.StdOut[Index]);

  for Index := 0 to GetArrayLength(Output.StdErr) - 1 do
    Log(Output.StdErr[Index]);

  Log('stop-pi-pocket.ps1' + Arguments + ' exited with ' + IntToStr(Code));
  Result := Code;
end;

function PiPocketRunning: Boolean;
begin
  Result := RunStopScript(' -Check') = 1;
end;

procedure StopPiPocket;
begin
  RunStopScript('');
end;

{ A folder that Setup may install into: none yet, an empty one, or an earlier install. With /DIR= pointed at another
  folder, Setup's and the uninstaller's deletes of node, app, and npm-cache would hit files that are not Pi Pocket's. }
function FolderIsSafe(const Folder: String): Boolean;
var
  Find: TFindRec;
  Found: Boolean;
begin
  Result := True;

  if not DirExists(Folder) or FileExists(AddBackslash(Folder) + 'unins000.dat') or
    FileExists(AddBackslash(Folder) + 'pi-pocket.cmd') then
    exit;

  if FindFirst(AddBackslash(Folder) + '*', Find) then
  begin
    try
      Found := True;
      while Found and Result do
      begin
        if (Find.Name <> '.') and (Find.Name <> '..') then
          Result := False;
        Found := FindNext(Find);
      end;
    finally
      FindClose(Find);
    end;
  end;
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

  if not FolderIsSafe(ExpandConstant('{app}')) then
  begin
    Result := ExpandConstant('{app}') + ' is not empty and holds no Pi Pocket install. Choose an empty folder.';
    exit;
  end;

  if not MayStopPiPocket('Setup') then
    Result := 'Pi Pocket is still running. Quit it (Pi Pocket''s icon in the notification area, then Quit), then run Setup again.';
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

{ After the user said yes to the uninstall: stop Pi Pocket, whose files are in use. At the end, the data folder holds
  sessions, sign-ins, and settings: keep it unless the user says yes. A silent uninstall keeps it. Only the default data
  folder: one chosen with PI_POCKET_DIR or --data stays. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if (CurUninstallStep = usUninstall) and PiPocketRunning then
  begin
    SuppressibleMsgBox('Pi Pocket is running. Uninstall stops it now.', mbInformation, MB_OK, IDOK);
    StopPiPocket;
  end;

  if CurUninstallStep <> usPostUninstall then
    exit;

  Data := ExpandConstant('{%USERPROFILE}\.pi-pocket');

  if not DirExists(Data) then
    exit;

  if SuppressibleMsgBox('Also delete your Pi Pocket data?' + #13#10#13#10 + Data + #13#10#13#10 +
    'It holds your sessions, sign-ins, settings, extensions, and the git worktrees of sessions, with any work in them ' +
    'that is not committed. Another Pi Pocket install on this account uses it too. ' +
    'Choose No to keep it.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
    DelTree(Data, True, True, True);
end;
