; Pi Pocket's Windows installer (Inno Setup). It installs for the current user only, without admin rights:
; - a portable Node.js (the official win-x64 zip, checked by build.ps1) in {app}\node;
; - the pi-pocket npm package with its dependencies, in a private npm prefix, {app}\app, which the user owns, so in-app
;   updates work. build.ps1 made it (packaging/bundle-app.mjs): Setup needs no npm and no network. A newer pi-pocket that
;   the app already updated to stays;
; - Pi Pocket.exe, the desktop app (PiPocket.cs): an icon in the notification area and a window, with no console;
; - pi-pocket.cmd, which starts the launcher with that Node.js and prefix in a console, and Start menu and sign-in
;   shortcuts.
; build.ps1 compiles it: ISCC /DAppVersion=0.29.0 /DNodeDir=<unpacked Node.js> /DDesktopDir=<Pi Pocket.exe's folder>
; /DAppDir=<the app folder> pi-pocket.iss

#ifndef AppVersion
  #error Define AppVersion, such as /DAppVersion=0.29.0
#endif
#ifndef NodeDir
  #error Define NodeDir, the folder of the unpacked Node.js zip
#endif
#ifndef DesktopDir
  #error Define DesktopDir, the folder of the compiled Pi Pocket.exe
#endif
#ifndef AppDir
  #error Define AppDir, the npm prefix with the pi-pocket package that bundle-app.mjs made
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
; The package goes in whole, unless a newer one that the app updated to stays. An install that stops after this leaves
; no package, never an older one: the app then says to run Setup again.
Type: filesandordirs; Name: "{app}\app"; Check: ReplaceApp
; What the installers that got the package from npm left.
Type: files; Name: "{app}\install-app.mjs"
Type: files; Name: "{app}\install.log"

[Files]
Source: "{#NodeDir}\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#AppDir}\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: ReplaceApp
Source: "{#DesktopDir}\Pi Pocket.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "pi-pocket.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "pi-pocket.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "stop-pi-pocket.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The app, and the console launcher for access modes, tunnels, and the sign-in QR code. The sign-in shortcut starts the
; app with its icon only, without a window.
Name: "{autoprograms}\Pi Pocket"; Filename: "{app}\Pi Pocket.exe"; WorkingDir: "{%USERPROFILE}"; Comment: "Open Pi Pocket"
Name: "{autoprograms}\Pi Pocket (console)"; Filename: "{app}\pi-pocket.cmd"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\pi-pocket.ico"; Comment: "Start Pi Pocket in a console window, to choose how other devices reach it"
Name: "{autostartup}\Pi Pocket"; Filename: "{app}\Pi Pocket.exe"; Parameters: "--hidden"; WorkingDir: "{%USERPROFILE}"; Tasks: startup

[Run]
Filename: "{app}\Pi Pocket.exe"; WorkingDir: "{%USERPROFILE}"; Description: "Open Pi Pocket now"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; In-app updates change the package, and npm made the cache, so Inno Setup does not know all their files.
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
  KeepApp: Boolean;

{ The next identifier of a dotted version part, which loses it and its dot. }
function NextPart(var Text: String): String;
var
  Dot: Integer;
begin
  Dot := Pos('.', Text);
  if Dot = 0 then
  begin
    Result := Text;
    Text := '';
  end
  else
  begin
    Result := Copy(Text, 1, Dot - 1);
    Delete(Text, 1, Dot);
  end;
end;

function IsDigits(const Text: String): Boolean;
var
  Index: Integer;
begin
  Result := Text <> '';
  for Index := 1 to Length(Text) do
    if (Text[Index] < '0') or (Text[Index] > '9') then
      Result := False;
end;

function SignOf(Value: Int64): Integer;
begin
  if Value < 0 then
    Result := -1
  else if Value > 0 then
    Result := 1
  else
    Result := 0;
end;

{ -1, 0, or 1, as SemVer orders the two versions; a pre-release comes before its release (the same order as
  CompareVersions in PiPocket.cs). }
function CompareVersions(A, B: String): Integer;
var
  PreA, PreB, X, Y: String;
  Index, At: Integer;
begin
  At := Pos('+', A);
  if At > 0 then
    A := Copy(A, 1, At - 1);
  At := Pos('+', B);
  if At > 0 then
    B := Copy(B, 1, At - 1);
  PreA := '';
  At := Pos('-', A);
  if At > 0 then
  begin
    PreA := Copy(A, At + 1, Length(A));
    A := Copy(A, 1, At - 1);
  end;
  PreB := '';
  At := Pos('-', B);
  if At > 0 then
  begin
    PreB := Copy(B, At + 1, Length(B));
    B := Copy(B, 1, At - 1);
  end;

  for Index := 1 to 3 do
  begin
    Result := SignOf(StrToInt64Def(NextPart(A), 0) - StrToInt64Def(NextPart(B), 0));
    if Result <> 0 then
      exit;
  end;

  if (PreA = '') or (PreB = '') then
  begin
    if (PreA = '') and (PreB <> '') then
      Result := 1
    else if (PreA <> '') and (PreB = '') then
      Result := -1;
    exit;
  end;

  while (PreA <> '') or (PreB <> '') do
  begin
    if PreA = '' then
    begin
      Result := -1;
      exit;
    end;
    if PreB = '' then
    begin
      Result := 1;
      exit;
    end;
    X := NextPart(PreA);
    Y := NextPart(PreB);
    if IsDigits(X) and IsDigits(Y) then
      Result := SignOf(StrToInt64Def(X, 0) - StrToInt64Def(Y, 0))
    else
      Result := SignOf(CompareStr(X, Y));
    if Result <> 0 then
      exit;
  end;
end;

{ The version of the pi-pocket package in the app folder, or an empty string when it has none that can start. }
function InstalledAppVersion: String;
var
  Folder: String;
  Text: AnsiString;
  Rest: String;
  At: Integer;
begin
  Result := '';
  Folder := ExpandConstant('{app}\app\node_modules\pi-pocket');

  if not FileExists(Folder + '\bin\pi-pocket.js') or not LoadStringFromFile(Folder + '\package.json', Text) then
    exit;

  Rest := String(Text);
  At := Pos('"version"', Rest);
  if At = 0 then
    exit;
  Delete(Rest, 1, At + Length('"version"') - 1);
  At := Pos('"', Rest);
  if At = 0 then
    exit;
  Delete(Rest, 1, At);
  At := Pos('"', Rest);
  if At = 0 then
    exit;
  Result := Copy(Rest, 1, At - 1);
end;

{ Setup's package replaces the one in the app folder, unless that one is newer: an in-app update stays. }
function ReplaceApp: Boolean;
begin
  Result := not KeepApp;
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
var
  Installed: String;
begin
  Result := '';

  if not FolderIsSafe(ExpandConstant('{app}')) then
  begin
    Result := ExpandConstant('{app}') + ' is not empty and holds no Pi Pocket install. Choose an empty folder.';
    exit;
  end;

  if not MayStopPiPocket('Setup') then
  begin
    Result := 'Pi Pocket is still running. Quit it (Pi Pocket''s icon in the notification area, then Quit), then run Setup again.';
    exit;
  end;

  Installed := InstalledAppVersion;
  KeepApp := (Installed <> '') and (CompareVersions(Installed, '{#AppVersion}') > 0);

  if KeepApp then
    Log('pi-pocket ' + Installed + ' is newer than {#AppVersion}: it stays.')
  else if Installed <> '' then
    Log('pi-pocket {#AppVersion} replaces ' + Installed + '.');
end;

function GitBashFound: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonpf64}\Git\bin\bash.exe')) or
    FileExists(ExpandConstant('{commonpf32}\Git\bin\bash.exe'));
end;

{ Last of all: the mark that the package in the app folder is whole. Pi Pocket.exe refuses a package without it, which
  an install that stopped while it copied the package leaves. }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\app\setup-finished.txt'),
      'Pi Pocket Setup {#AppVersion} put the package in this folder in place.' + #13#10, False);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and not GitBashFound then
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
