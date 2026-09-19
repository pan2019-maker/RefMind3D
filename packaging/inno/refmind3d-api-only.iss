#define AppName "RefMind3D"
#define AppVersion "1.14.0"
#define Publisher "RefMind3D Team"
#define StagingDir "..\..\release\api-only-staging"

[Setup]
AppId={{A6E83B48-36DF-4D5C-A6E9-8C3D1A0F1001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\RefMind3D
DefaultGroupName=RefMind3D
OutputDir=..\..\release\api-only-installer
OutputBaseFilename=RefMind3D_Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
DisableProgramGroupPage=yes
DisableDirPage=no
SetupIconFile=..\..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\RefMind3D-App-1.14.0.ico
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "compact"; Description: "RefMind3D compact edition"

[Components]
Name: "main"; Description: "RefMind3D main program"; Types: compact; Flags: fixed
Name: "runtime"; Description: "Required Windows runtimes"; Types: compact; Flags: fixed

[Files]
Source: "{#StagingDir}\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion; Components: main
Source: "{#StagingDir}\redist\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: ignoreversion skipifsourcedoesntexist deleteafterinstall; Components: runtime
Source: "{#StagingDir}\redist\VC_redist.x64.exe"; DestDir: "{tmp}"; Flags: ignoreversion skipifsourcedoesntexist deleteafterinstall; Components: runtime

[Registry]
Root: HKCR; Subkey: ".refmind3d"; ValueType: string; ValueName: ""; ValueData: "RefMind3D.Project"; Flags: uninsdeletevalue
Root: HKCR; Subkey: ".refmind"; ValueType: string; ValueName: ""; ValueData: "RefMind3D.Project"; Flags: uninsdeletevalue
Root: HKCR; Subkey: "RefMind3D.Project"; ValueType: string; ValueName: ""; ValueData: "RefMind3D Project"; Flags: uninsdeletekeyifempty
Root: HKCR; Subkey: "RefMind3D.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\RefMind3D-Project-1.14.0.ico,0"; Flags: uninsdeletekeyifempty
Root: HKCR; Subkey: "RefMind3D.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\refmind3d.exe"" ""%1"""; Flags: uninsdeletekeyifempty

[Icons]
Name: "{autoprograms}\RefMind3D"; Filename: "{app}\refmind3d.exe"; IconFilename: "{app}\RefMind3D-App-1.14.0.ico"
Name: "{autodesktop}\RefMind3D"; Filename: "{app}\refmind3d.exe"; IconFilename: "{app}\RefMind3D-App-1.14.0.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 Runtime..."; Flags: waituntilterminated skipifdoesntexist; Components: runtime
Filename: "{tmp}\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Visual C++ Runtime..."; Flags: waituntilterminated skipifdoesntexist; Components: runtime
Filename: "{app}\refmind3d.exe"; Description: "Launch RefMind3D"; Flags: nowait postinstall skipifsilent

[Code]
var
  DeleteCacheCheckbox: TNewCheckBox;

procedure InitializeUninstallProgressForm();
begin
  DeleteCacheCheckbox := TNewCheckBox.Create(UninstallProgressForm);
  DeleteCacheCheckbox.Parent := UninstallProgressForm;
  DeleteCacheCheckbox.Left := UninstallProgressForm.StatusLabel.Left;
  DeleteCacheCheckbox.Top := UninstallProgressForm.StatusLabel.Top + 44;
  DeleteCacheCheckbox.Width := UninstallProgressForm.StatusLabel.Width;
  DeleteCacheCheckbox.Caption := '同时删除 RefMind3D 图片缓存（默认保留，工程文件和原图不受影响）';
  DeleteCacheCheckbox.Checked := False;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  CacheDir: String;
  CacheDirFile: String;
  CacheDirRaw: AnsiString;
begin
  if (CurUninstallStep = usUninstall) and DeleteCacheCheckbox.Checked then
  begin
    CacheDirFile := ExpandConstant('{localappdata}\RefMind3D\cache-directory.txt');
    CacheDir := ExpandConstant('{localappdata}\RefMind3D\ImageCache');
    if FileExists(CacheDirFile) and LoadStringFromFile(CacheDirFile, CacheDirRaw) then
      CacheDir := String(CacheDirRaw);
    CacheDir := Trim(CacheDir);
    if (CacheDir <> '') and FileExists(AddBackslash(CacheDir) + '.refmind3d-image-cache') then
      DelTree(CacheDir, True, True, True);
    DeleteFile(ExpandConstant('{localappdata}\RefMind3D\cache-settings.json'));
    DeleteFile(CacheDirFile);
  end;
end;
