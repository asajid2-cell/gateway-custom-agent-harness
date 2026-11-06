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
; {code:} so a detected install can supply its own folder as the default.
DefaultDirName={code:GetDefaultInstallDir}
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
; Our own detection decides the default folder. Inno's remembered folder would
; otherwise outrank GetDefaultInstallDir and point at whichever copy ran last.
UsePreviousAppDir=no
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
Name: "{group}\Gateway{code:GetShortcutSuffix}"; Filename: "{app}\scripts\cc.cmd"; WorkingDir: "{%USERPROFILE}"
Name: "{group}\Gateway Manager{code:GetShortcutSuffix}"; Filename: "{app}\GatewayManager.exe"
Name: "{group}\Uninstall Gateway{code:GetShortcutSuffix}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Gateway{code:GetShortcutSuffix}"; Filename: "{app}\scripts\cc.cmd"; WorkingDir: "{%USERPROFILE}"; Tasks: desktopicon

[UninstallDelete]
; bin/ holds shims written after the file copy, so the uninstaller does not
; know about them; without this, "uninstall" leaves an empty folder behind.
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\install.env"
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
  // What an earlier install left behind, if anything: '', 'wizard', 'msi',
  // 'tree'. The choice page lets the user update it, replace it, or put this
  // copy beside it without sharing a folder or a command name.
  ExistingPage: TInputOptionWizardPage;
  ExistingKind: string;
  ExistingDir: string;
  ExistingAlias: string;
  ExistingVersion: string;
  ExistingProduct: string;
  ExistingRoot: Integer;
  ExistingNotes: string;
  ExistingChoice: Integer;
  ExistingDirs: TArrayOfString;
  ExistingAliases: TArrayOfString;
  ExistingRecordCount: Integer;
  AliasDefault: string;

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

// --- an existing install ---------------------------------------------------
// Three shapes are possible: an install made by this wizard (HKCU\Software\
// Gateway), an MSI product (an Add/Remove Programs entry with a product
// code), and a plain tree at the per-user default (a portable copy, or an
// install whose registry key was lost). Detection only reads.
function DirLooksLikeGateway(const Dir: string): Boolean;
begin
  Result := (Dir <> '') and
    (FileExists(Dir + '\scripts\cc.cmd') or FileExists(Dir + '\dist\cli.js'));
end;

function TrimDir(const Value: string): string;
begin
  Result := Trim(Value);
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
end;

function DirIsNotEmpty(const Dir: string): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if not FindFirst(Dir + '\*', FindRec) then Exit;
  repeat
    if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
    begin
      Result := True;
      Break;
    end;
  until not FindNext(FindRec);
  FindClose(FindRec);
end;

// Every recorded install, so the folder the user picks decides what happens:
// the same folder is an update, any other folder is a second copy.
procedure AddRecord(const Dir, Alias: string);
begin
  SetArrayLength(ExistingDirs, ExistingRecordCount + 1);
  SetArrayLength(ExistingAliases, ExistingRecordCount + 1);
  ExistingDirs[ExistingRecordCount] := TrimDir(Dir);
  ExistingAliases[ExistingRecordCount] := Alias;
  ExistingRecordCount := ExistingRecordCount + 1;
end;

function RecordForDir(const Dir: string; var Alias: string): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 0 to ExistingRecordCount - 1 do
    if CompareText(TrimDir(Dir), ExistingDirs[I]) = 0 then
    begin
      Alias := ExistingAliases[I];
      Result := True;
      Exit;
    end;
end;

procedure DetectMsiIn(const Root: Integer; const Base: string);
var
  Names: TArrayOfString;
  I: Integer;
  Key, Disp, Loc, Ver: string;
begin
  if not RegGetSubkeyNames(Root, Base, Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
  begin
    if Copy(Names[I], 1, 1) <> '{' then Continue;
    Key := Base + '\' + Names[I];
    if not RegQueryStringValue(Root, Key, 'DisplayName', Disp) then Continue;
    if CompareText(Disp, 'Gateway') <> 0 then Continue;
    if not RegQueryStringValue(Root, Key, 'DisplayVersion', Ver) then Ver := '?';
    if not RegQueryStringValue(Root, Key, 'InstallLocation', Loc) then Loc := '';
    if ExistingKind = '' then
    begin
      ExistingKind := 'msi';
      ExistingProduct := Names[I];
      ExistingRoot := Root;
      ExistingVersion := Ver;
      ExistingDir := Loc;
      if (ExistingDir = '') and DirLooksLikeGateway(ExpandConstant('{localappdata}\Programs\Gateway')) then
        ExistingDir := ExpandConstant('{localappdata}\Programs\Gateway');
      // Record it too, so the choice page follows the folder: an MSI in a
      // non-default folder must not be mistaken for "install alongside".
      if ExistingDir <> '' then AddRecord(ExistingDir, 'gateway');
    end;
    ExistingNotes := ExistingNotes + 'MSI ' + Ver + ' (product ' + Names[I] + ')' + #13#10;
  end;
end;

procedure DetectExisting;
var
  Dir, Ver, Alias, Key: string;
  Names: TArrayOfString;
  I: Integer;
begin
  ExistingKind := '';
  ExistingDir := '';
  ExistingAlias := '';
  ExistingVersion := '';
  ExistingProduct := '';
  ExistingNotes := '';
  ExistingChoice := 0;
  ExistingRoot := HKCU;
  ExistingRecordCount := 0;
  SetArrayLength(ExistingDirs, 0);
  SetArrayLength(ExistingAliases, 0);

  if RegQueryStringValue(HKCU, 'Software\Gateway', 'InstallDir', Dir) and DirLooksLikeGateway(Dir) then
  begin
    ExistingKind := 'wizard';
    ExistingDir := Dir;
    if not RegQueryStringValue(HKCU, 'Software\Gateway', 'Version', Ver) then Ver := '?';
    if not RegQueryStringValue(HKCU, 'Software\Gateway', 'Alias', Alias) then Alias := '';
    ExistingVersion := Ver;
    ExistingAlias := Alias;
    ExistingNotes := ExistingNotes + 'Gateway ' + Ver + ' at ' + Dir +
      ' (command "' + Alias + '")' + #13#10;
    AddRecord(Dir, Alias);
  end;

  // Copies installed beside the first one.
  if RegGetSubkeyNames(HKCU, 'Software\Gateway\Installs', Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
    begin
      Key := 'Software\Gateway\Installs\' + Names[I];
      if RegQueryStringValue(HKCU, Key, 'InstallDir', Dir) and DirLooksLikeGateway(Dir) then
      begin
        if not RegQueryStringValue(HKCU, Key, 'Version', Ver) then Ver := '?';
        if not RegQueryStringValue(HKCU, Key, 'Alias', Alias) then Alias := Names[I];
        if ExistingKind = '' then
        begin
          ExistingKind := 'wizard';
          ExistingDir := Dir;
          ExistingVersion := Ver;
          ExistingAlias := Alias;
        end;
        ExistingNotes := ExistingNotes + 'Gateway ' + Ver + ' at ' + Dir +
          ' (command "' + Alias + '")' + #13#10;
        AddRecord(Dir, Alias);
      end;
    end;

  DetectMsiIn(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall');
  DetectMsiIn(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall');
  DetectMsiIn(HKLM, 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall');

  Dir := ExpandConstant('{localappdata}\Programs\Gateway');
  if DirLooksLikeGateway(Dir) and
     ((ExistingDir = '') or (CompareText(TrimDir(Dir), TrimDir(ExistingDir)) <> 0)) then
  begin
    if ExistingKind = '' then
    begin
      ExistingKind := 'tree';
      ExistingDir := Dir;
      ExistingVersion := '?';
    end;
    ExistingNotes := ExistingNotes + 'Gateway files at ' + Dir + #13#10;
    AddRecord(Dir, 'gateway');
  end;
end;

function GetDefaultInstallDir(Param: string): string;
begin
  if ExistingDir <> '' then Result := ExistingDir
  else Result := ExpandConstant('{autopf}\Gateway');
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
  DetectExisting;
end;

procedure InitializeWizard;
var
  AfterID: Integer;
begin
  // The choice page comes before the command-name page, so a name that
  // collides with the other install can be rejected when it is typed.
  if ExistingKind <> '' then
  begin
    ExistingPage := CreateInputOptionPage(wpSelectDir,
      'Existing installation',
      'Gateway is already on this computer.',
      ExistingNotes +
        'Choose what this copy should do. Installing alongside needs a ' +
        'different folder and a different command name; it leaves the other ' +
        'installation and its PATH entry alone.',
      True, False);
    if ExistingKind = 'msi' then
    begin
      ExistingPage.Add('Replace the MSI installation (uninstall it, then install this copy)');
      ExistingPage.Add('Install alongside it (different folder and command)');
    end
    else if ExistingKind = 'tree' then
    begin
      ExistingPage.Add('Update those files in place');
      ExistingPage.Add('Install alongside them (different folder and command)');
    end
    else
    begin
      ExistingPage.Add('Update the existing installation in place');
      ExistingPage.Add('Install alongside it (different folder and command)');
    end;
    ExistingPage.Values[0] := True;
    AfterID := ExistingPage.ID;
  end
  else
    AfterID := wpSelectDir;

  AliasPage := CreateInputQueryPage(AfterID,
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
  AliasDefault := Trim(AliasPage.Values[0]);
end;

function GetAlias(Param: string): string;
begin
  if Assigned(AliasPage) then
    Result := Trim(AliasPage.Values[0])
  else
    Result := 'gateway';
end;

// "Alongside" is decided by where it is going, not only by the page: an
// unattended run has no page, and a different folder means a second copy.
function ChoosingAlongside: Boolean;
begin
  Result := (ExistingKind <> '') and (ExistingDir <> '') and
    (CompareText(TrimDir(ExpandConstant('{app}')), TrimDir(ExistingDir)) <> 0);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Value: string;
  AlongsideNow: Boolean;
begin
  Result := True;
  // Silent runs have no pages to correct and must never show a dialog: a modal
  // box in /VERYSILENT waits forever for a click. The install-time logic
  // (ChoosingAlongside, PrepareToInstall) already handles both choices.
  if SilentRun then Exit;
  // The folder decides whether this is an update: picking a recorded copy's
  // folder makes that copy the target and offers its command name, rather than
  // leaving the page pointing at whichever copy happened to be detected first.
  if CurPageID = wpSelectDir then
  begin
    if RecordForDir(WizardForm.DirEdit.Text, Value) then
    begin
      ExistingKind := 'wizard';
      ExistingDir := TrimDir(WizardForm.DirEdit.Text);
      ExistingAlias := Value;
      if Assigned(AliasPage) and
         ((Trim(AliasPage.Values[0]) = '') or (CompareText(Trim(AliasPage.Values[0]), AliasDefault) = 0)) then
      begin
        AliasPage.Values[0] := Value;
        AliasDefault := Value;
      end;
    end;
  end;
  if Assigned(ExistingPage) and (CurPageID = ExistingPage.ID) then
  begin
    if ExistingPage.Values[0] then ExistingChoice := 0 else ExistingChoice := 1;
    if ExistingDir <> '' then
    begin
      if ExistingChoice = 1 then
      begin
        if CompareText(TrimDir(WizardForm.DirEdit.Text), TrimDir(ExistingDir)) = 0 then
        begin
          MsgBox('That is the folder the existing installation uses. Go back and choose a different folder for a second copy.', mbError, MB_OK);
          Result := False;
          Exit;
        end;
      end
      else if CompareText(TrimDir(WizardForm.DirEdit.Text), TrimDir(ExistingDir)) <> 0 then
      begin
        MsgBox('This choice updates the installation at ' + ExistingDir + '.' + Chr(13) + Chr(10) + Chr(13) + Chr(10) +
          'Go back and select that folder, or choose "Install alongside".', mbError, MB_OK);
        Result := False;
        Exit;
      end;
    end;
  end;
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
    // A second copy must not answer to the same command as the first: both
    // bin folders end up on PATH, so the winner would depend on PATH order.
    AlongsideNow := (ExistingKind <> '') and (ExistingDir <> '') and
      (CompareText(TrimDir(WizardForm.DirEdit.Text), TrimDir(ExistingDir)) <> 0);
    if AlongsideNow then
    begin
      if (ExistingAlias <> '') and (CompareText(Value, ExistingAlias) = 0) then
      begin
        MsgBox('"' + Value + '" is the command the existing installation uses. Choose a different name so the two copies stay apart.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
      if (ExistingDir <> '') and FileExists(ExistingDir + '\bin\' + Value + '.cmd') then
      begin
        MsgBox('The installation in ' + ExistingDir + ' already provides "' + Value + '". Choose a different command name.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
    end;
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

// Keep the radio honest as the folder changes: a recorded folder is an update,
// anything else is a second copy.
procedure CurPageChanged(CurPageID: Integer);
var
  Found: string;
begin
  if Assigned(ExistingPage) and (CurPageID = ExistingPage.ID) then
  begin
    if RecordForDir(WizardForm.DirEdit.Text, Found) then
      ExistingPage.Values[0] := True
    else
      ExistingPage.Values[1] := True;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code, I: Integer;
  Key: string;
begin
  Result := '';
  // Replacing an MSI install means removing the product first: the wizard and
  // the MSI would otherwise both own Programs\Gateway and leave two Add/Remove
  // Programs entries. Repair and Modify never remove anything.
  if (ExistingKind = 'msi') and (ExistingChoice = 0) and (not RepairMode) and (not ModifyMode) then
  begin
    if (not Exec('msiexec.exe', '/x ' + ExistingProduct + ' /qn /norestart', '',
      SW_HIDE, ewWaitUntilTerminated, Code)) or (Code <> 0) then
      Result := 'The existing Gateway MSI could not be removed (msiexec returned ' +
        IntToStr(Code) + '). Uninstall it from Settings > Apps, then run this setup again.'
    else
    begin
      // msiexec can return before the service finishes writing its registry
      // cleanup; wait for the product key to go, or the MSI's own deletion can
      // land after our install record and remove it again.
      Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + ExistingProduct;
      for I := 1 to 120 do
      begin
        if not RegKeyExists(ExistingRoot, Key) then Break;
        Sleep(500);
      end;
      if RegKeyExists(ExistingRoot, Key) then
        Result := 'The existing Gateway MSI is still registered after 60 seconds. ' +
          'Wait for it to finish, then run this setup again.';
    end;
  end;
end;

// A second copy gets its own Start Menu entries: the first copy owns the
// unsuffixed names, and two installs sharing one shortcut path would mean one
// uninstaller removes the other's icon.
function GetShortcutSuffix(Param: string): string;
begin
  if ChoosingAlongside then
    Result := ' (' + GetAlias('') + ')'
  else
    Result := '';
end;

// --- install records -------------------------------------------------------
// The first copy owns HKCU\Software\Gateway. A copy installed beside it gets
// HKCU\Software\Gateway\Installs\<command> instead, so uninstalling one copy
// cannot delete the other's record, and detection can list both.
// A stable directory name for this install's own vault. The install folder is
// the identity, so renaming the command keeps the same credentials and two
// copies never share a store.
// Four hex digits of the low 16 bits. Pascal Script has no IntToHex.
function Hex4(Value: Int64): string;
var
  N: Integer;
  D: string;
begin
  D := '0123456789ABCDEF';
  N := Integer(Value) and $FFFF;
  Result := D[((N shr 12) and 15) + 1] + D[((N shr 8) and 15) + 1] +
            D[((N shr 4) and 15) + 1] + D[(N and 15) + 1];
end;

function VaultId: string;
var
  S, R: string;
  I: Integer;
  C: Char;
  H: Int64;
begin
  S := ExpandConstant('{app}');
  R := '';
  H := 2166136261; // FNV-1a: two folders that differ only in punctuation
  for I := 1 to Length(S) do // must still get different vaults.
  begin
    C := S[I];
    H := H xor Ord(C);
    H := (H * 16777619) and $FFFFFFFF;
    if ((C >= 'a') and (C <= 'z')) or ((C >= 'A') and (C <= 'Z')) or
       ((C >= '0') and (C <= '9')) or (C = '_') or (C = '-') then
      R := R + C
    else
      R := R + '-';
  end;
  if R = '' then R := 'default';
  Result := R + '-' + Hex4(H);
end;

// The installed copy runs on the bundled vault, and that vault lives in a
// directory of its own. Without this it would inherit whatever ~/.keysafe or
// ~/.claude/keysafe the machine already had.
procedure WriteInstallEnv;
var
  Text: string;
begin
  Text := '# Written by the Gateway installer.' + #13#10 +
          'GATEWAY_CREDENTIALS_MODE=bundled' + #13#10 +
          'GATEWAY_KEYSAFE_DIR=' + ExpandConstant('{localappdata}\Gateway\keysafe\') + VaultId + #13#10;
  SaveStringToFile(ExpandConstant('{app}\install.env'), Text, False);
end;

procedure WriteInstallRecord(Alias: string);
var
  Dir, Primary: string;
begin
  // The name becomes a registry key when this copy is not the first one.
  if not AliasIsValid(Alias) then Alias := 'gateway';
  Dir := ExpandConstant('{app}');
  Primary := '';
  RegQueryStringValue(HKCU, 'Software\Gateway', 'InstallDir', Primary);
  if (Primary = '') or (CompareText(TrimDir(Primary), TrimDir(Dir)) = 0) then
  begin
    RegWriteStringValue(HKCU, 'Software\Gateway', 'InstallDir', Dir);
    RegWriteStringValue(HKCU, 'Software\Gateway', 'Alias', Alias);
    RegWriteStringValue(HKCU, 'Software\Gateway', 'Version', '{#AppVersion}');
    RegWriteStringValue(HKCU, 'Software\Gateway', 'SourceSha', '{#SourceSha}');
    RegWriteStringValue(HKCU, 'Software\Gateway', 'PathEntry', Dir + '\bin');
  end
  else
  begin
    RegWriteStringValue(HKCU, 'Software\Gateway\Installs\' + Alias, 'InstallDir', Dir);
    RegWriteStringValue(HKCU, 'Software\Gateway\Installs\' + Alias, 'Alias', Alias);
    RegWriteStringValue(HKCU, 'Software\Gateway\Installs\' + Alias, 'Version', '{#AppVersion}');
    RegWriteStringValue(HKCU, 'Software\Gateway\Installs\' + Alias, 'SourceSha', '{#SourceSha}');
  end;
end;

procedure RemoveInstallRecord;
var
  Names: TArrayOfString;
  I: Integer;
  Key, Dir, Value: string;
begin
  Dir := ExpandConstant('{app}');
  if RegQueryStringValue(HKCU, 'Software\Gateway', 'InstallDir', Value) and
     (CompareText(TrimDir(Value), TrimDir(Dir)) = 0) then
  begin
    RegDeleteValue(HKCU, 'Software\Gateway', 'InstallDir');
    RegDeleteValue(HKCU, 'Software\Gateway', 'Alias');
    RegDeleteValue(HKCU, 'Software\Gateway', 'Version');
    RegDeleteValue(HKCU, 'Software\Gateway', 'SourceSha');
    RegDeleteValue(HKCU, 'Software\Gateway', 'PathEntry');
    // Leave a subkey tree alone: another copy may still be listed there.
    RegDeleteKeyIfEmpty(HKCU, 'Software\Gateway');
    Exit;
  end;
  if RegGetSubkeyNames(HKCU, 'Software\Gateway\Installs', Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
    begin
      Key := 'Software\Gateway\Installs\' + Names[I];
      if RegQueryStringValue(HKCU, Key, 'InstallDir', Value) and
         (CompareText(TrimDir(Value), TrimDir(Dir)) = 0) then
      begin
        RegDeleteKeyIncludingSubkeys(HKCU, Key);
        RegDeleteKeyIfEmpty(HKCU, 'Software\Gateway\Installs');
        RegDeleteKeyIfEmpty(HKCU, 'Software\Gateway');
        Exit;
      end;
    end;
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
    WriteShim(Alias);
    // When installing alongside, `gateway` belongs to the other install: do
    // not put a second `gateway.cmd` on PATH behind its back.
    if (CompareText(Alias, 'gateway') <> 0) and
       not (ChoosingAlongside and FileExists(ExistingDir + '\bin\gateway.cmd')) then
      WriteShim('gateway');
    if AliasIsValid(PreviousAlias) and (CompareText(PreviousAlias, Alias) <> 0)
       and (CompareText(PreviousAlias, 'gateway') <> 0) then
      DeleteFile(ExpandConstant('{app}\bin\') + PreviousAlias + '.cmd');
    WriteInstallRecord(Alias);
    WriteInstallEnv;
    if WizardIsTaskSelected('addtopath') then
      AddPathEntry
    else
      RemovePathEntry;
  end;
  // Write the record once more at the end: an MSI removal started in
  // PrepareToInstall can still be finishing its own registry cleanup.
  if CurStep = ssDone then
    WriteInstallRecord(GetAlias(''));
  // Never block an unattended run: a modal box in /VERYSILENT waits forever.
  if (CurStep = ssDone) and RepairMode and (not WizardSilent) then
    MsgBox('Gateway was repaired: files, command shims and shortcuts are in place, and the install folder is on your PATH.', mbInformation, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemovePathEntry;
    RemoveInstallRecord;
  end;
end;
