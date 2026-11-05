; Gateway for Windows: a per-user wizard that installs a self-contained tree,
; creates the command shim you ask for, and leaves an uninstaller plus a
; manager behind.
;
; Build with scripts/release/windows/build-windows-installer.mjs, which passes
; TreeDir / AppVersion / SourceSha.

#ifndef TreeDir
  #error TreeDir must be defined (the packaged release tree)
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceSha
  #define SourceSha "unknown"
#endif

#define AppName "Gateway"
#define AppPublisher "Ahmed Sajid"
#define AppUrl "https://github.com/asajid2-cell/gateway"

[Setup]
; A stable AppId is what makes an upgrade an upgrade instead of a second copy.
AppId={{6F0C3C1E-6B7A-4E2D-9C5B-2F7A9D4B1E33}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
DefaultDirName={autopf}\Gateway
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Per-user by default so no elevation is needed; the user can opt into an
; all-users install, and then autopf resolves to Program Files.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=GatewaySetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\scripts\cc.cmd
SetupLogging=yes
UsePreviousAppDir=yes
UsePreviousTasks=yes
ChangesEnvironment=yes
CloseApplications=no
AllowNoIcons=yes
; Inno wants four numeric components here even though AppVersion has three.
#ifndef VersionQuad
  #define VersionQuad "1.0.0.0"
#endif
VersionInfoVersion={#VersionQuad}
VersionInfoDescription={#AppName} setup
VersionInfoCompany={#AppPublisher}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add the command to my PATH (recommended)"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#TreeDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ManagerExe}"; DestDir: "{app}"; DestName: "GatewayManager.exe"; Flags: ignoreversion

[Icons]
Name: "{group}\Gateway"; Filename: "{app}\scripts\cc.cmd"; WorkingDir: "{%USERPROFILE}"
Name: "{group}\Gateway Manager"; Filename: "{app}\GatewayManager.exe"
Name: "{group}\Uninstall Gateway"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Gateway"; Filename: "{app}\scripts\cc.cmd"; WorkingDir: "{%USERPROFILE}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Gateway"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Gateway"; ValueType: string; ValueName: "Alias"; ValueData: "{code:GetAlias}"
Root: HKCU; Subkey: "Software\Gateway"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"
Root: HKCU; Subkey: "Software\Gateway"; ValueType: string; ValueName: "SourceSha"; ValueData: "{#SourceSha}"
Root: HKCU; Subkey: "Software\Gateway"; ValueType: string; ValueName: "PathEntry"; ValueData: "{app}\bin"

[UninstallDelete]
; bin/ holds shims written after the file copy, so the uninstaller does not
; know about them; without this, "uninstall" leaves an empty folder behind.
Type: filesandordirs; Name: "{app}\bin"
Type: dirifempty; Name: "{app}"

[Run]
Filename: "{app}\scripts\cc.cmd"; Parameters: "login --status"; Description: "Check the installation"; Flags: postinstall nowait skipifsilent unchecked
Filename: "{app}\GatewayManager.exe"; Description: "Open Gateway Manager"; Flags: postinstall nowait skipifsilent unchecked

[Code]
const
  WM_SETTINGCHANGE = $001A;
  SMTO_ABORTIFHUNG = $0002;

var
  AliasPage: TInputQueryWizardPage;
  ModifyMode: Boolean;
  RepairMode: Boolean;
  PreviousAlias: string;
  SilentAlias: string;
  SilentRun: Boolean;

function SendMessageTimeout(hWnd: Longint; Msg: Longint; wParam: Longint; lParam: Longint;
  fuFlags: Longint; uTimeout: Longint; var lpdwResult: Longint): Longint;
  external 'SendMessageTimeoutA@user32.dll stdcall';

procedure BroadcastEnvironmentChange;
var
  Ignored: Longint;
begin
  SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 0, SMTO_ABORTIFHUNG, 5000, Ignored);
end;

// The alias becomes a file name and a PATH entry name, so the value read back
// from the registry is validated before it is ever concatenated into a path.
function AliasIsValid(const Value: string): Boolean;
var
  I: Integer;
begin
  Result := (Length(Value) > 0) and (Length(Value) <= 32);
  if not Result then Exit;
  if Value[1] = '-' then Result := False;
  for I := 1 to Length(Value) do
    if Pos(Value[I], 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_') = 0 then
      Result := False;
end;

// The wizard asks before taking a compiler's name; an unattended run has no
// one to ask, so /ALIAS=cc is refused there instead.
function AliasIsCompiler(const Value: string): Boolean;
begin
  Result := (CompareText(Value, 'cc') = 0) or (CompareText(Value, 'cl') = 0) or
            (CompareText(Value, 'gcc') = 0) or (CompareText(Value, 'clang') = 0);
end;

function InitializeSetup(): Boolean;
var
  I: Integer;
  Arg: string;
  Ok: Boolean;
begin
  Result := True;
  for I := 1 to ParamCount do
  begin
    Arg := ParamStr(I);
    if Uppercase(Arg) = '/MODIFY' then ModifyMode := True;
    if Uppercase(Arg) = '/REPAIR' then RepairMode := True;
    // /SUPPRESSMSGBOXES does not suppress a MsgBox written in [Code], so an
    // unattended run must never show one: a modal box in /VERYSILENT waits
    // forever for a click nobody is there to make.
    if (Uppercase(Arg) = '/SILENT') or (Uppercase(Arg) = '/VERYSILENT') then
      SilentRun := True;
    // Unattended runs have no page to type into, so the command name has to
    // be settable from the command line too.
    if Copy(Uppercase(Arg), 1, 7) = '/ALIAS=' then
      SilentAlias := Copy(Arg, 8, MaxInt);
  end;
  if SilentAlias <> '' then
  begin
    Ok := (Length(SilentAlias) > 0) and (Length(SilentAlias) <= 32);
    for I := 1 to Length(SilentAlias) do
      if Pos(SilentAlias[I], 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_') = 0 then
        Ok := False;
    if not Ok then
    begin
      if not SilentRun then
        MsgBox('/ALIAS must be 1-32 letters, digits, "-" or "_", and must not start with "-".', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if AliasIsCompiler(SilentAlias) then
    begin
      if not SilentRun then
        MsgBox('"' + SilentAlias + '" is the name of a C compiler; /ALIAS cannot take it unattended. Choose another name.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
  if not RegQueryStringValue(HKCU, 'Software\Gateway', 'Alias', PreviousAlias) then
    PreviousAlias := '';
  if not AliasIsValid(PreviousAlias) then
    PreviousAlias := '';
end;

procedure InitializeWizard;
begin
  AliasPage := CreateInputQueryPage(wpSelectDir,
    'Command name',
    'Which command should start Gateway?',
    'Type the name you will use in a terminal. "gateway" is recommended. ' +
    'The installer creates it on your PATH and keeps it up to date.');
  AliasPage.Add('Command name:', False);
  if SilentAlias <> '' then
    AliasPage.Values[0] := SilentAlias
  else if PreviousAlias <> '' then
    AliasPage.Values[0] := PreviousAlias
  else
    AliasPage.Values[0] := 'gateway';
end;

function GetAlias(Param: string): string;
begin
  if Assigned(AliasPage) then
    Result := Trim(AliasPage.Values[0])
  else
    Result := 'gateway';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Value: string;
begin
  Result := True;
  if CurPageID = AliasPage.ID then
  begin
    Value := Trim(AliasPage.Values[0]);
    if not AliasIsValid(Value) then
    begin
      MsgBox('Use 1-32 letters, digits, "-" or "_", and do not start with "-".', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if (CompareText(Value, 'cc') = 0) or (CompareText(Value, 'cl') = 0) or
       (CompareText(Value, 'gcc') = 0) or (CompareText(Value, 'clang') = 0) then
      if MsgBox('"' + Value + '" is also the name of a C compiler on many machines. ' +
        'Windows resolves your own command first, so a developer shell may run Gateway where it expected a compiler.' + Chr(13) + Chr(10) + Chr(13) + Chr(10) + 'Use it anyway?', mbConfirmation, MB_YESNO) <> IDYES then
        Result := False;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if RepairMode then
    Result := True
  else if ModifyMode and (PageID = wpSelectDir) then
    Result := True;
end;

function CmdShim(const Name: string): string;
var
  Target: string;
begin
  Target := ExpandConstant('{app}\scripts\cc.cmd');
  Result := '@echo off' + #13#10 +
            'call "' + Target + '" %*' + #13#10;
end;

procedure WriteShim(const Name: string);
begin
  SaveStringToFile(ExpandConstant('{app}\bin\') + Name + '.cmd', CmdShim(Name), False);
end;

procedure AddPathEntry;
var
  Dir, Path: string;
begin
  Dir := ExpandConstant('{app}\bin');
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then
    Path := '';
  if Pos(Lowercase(Dir) + ';', Lowercase(Path) + ';') = 0 then
  begin
    if Path = '' then
      Path := Dir
    else if Path[Length(Path)] = ';' then
      Path := Path + Dir
    else
      Path := Path + ';' + Dir;
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
    BroadcastEnvironmentChange;
  end;
end;

procedure RemovePathEntry;
var
  Dir, Path, Lower, Needle: string;
  P: Integer;
begin
  Dir := ExpandConstant('{app}\bin');
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then Exit;
  Needle := Lowercase(Dir);
  // A PATH can hold the same folder more than once; remove every copy.
  repeat
    Lower := Lowercase(Path);
    P := Pos(';' + Needle + ';', ';' + Lower + ';');
    if P = 0 then Break;
    Delete(Path, P, Length(Dir) + 1);
  until False;
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
  BroadcastEnvironmentChange;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Alias: string;
begin
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(ExpandConstant('{app}\bin'));
    Alias := Trim(GetAlias(''));
    if not AliasIsValid(Alias) then Alias := 'gateway';
    WriteShim('gateway');
    if CompareText(Alias, 'gateway') <> 0 then
      WriteShim(Alias);
    if AliasIsValid(PreviousAlias) and (CompareText(PreviousAlias, Alias) <> 0)
       and (CompareText(PreviousAlias, 'gateway') <> 0) then
      DeleteFile(ExpandConstant('{app}\bin\') + PreviousAlias + '.cmd');
    if WizardIsTaskSelected('addtopath') then
      AddPathEntry
    else
      RemovePathEntry;
  end;
  // Never block an unattended run: a modal box in /VERYSILENT waits forever.
  if (CurStep = ssDone) and RepairMode and (not WizardSilent) then
    MsgBox('Gateway was repaired: files, command shims and shortcuts are in place, and the install folder is on your PATH.', mbInformation, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemovePathEntry;
end;
