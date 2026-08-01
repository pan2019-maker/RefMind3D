#define AppName "RefMind3D"
#define AppVersion "1.0.0"
#define Publisher "RefMind3D Team"
#define StagingDir "..\..\release\offline-staging"

[Setup]
AppId={{A6E83B48-36DF-4D5C-A6E9-8C3D1A0F1000}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\RefMind3D
DefaultGroupName=RefMind3D
OutputDir=..\..\release\installer
OutputBaseFilename=RefMind3D_Offline_Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
DisableProgramGroupPage=yes
DisableDirPage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "compact"; Description: "Main app only"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Components]
Name: "main"; Description: "RefMind3D main program"; Types: compact custom; Flags: fixed
Name: "runtime"; Description: "Required offline runtimes"; Types: compact custom; Flags: fixed
Name: "runtime\ollama"; Description: "Ollama local vision runtime"; Types: custom
Name: "vision"; Description: "Local vision understanding models"; Types: custom
Name: "vision\qwen25vl7b"; Description: "Qwen2.5-VL 7B, recommended VRAM 6G"; Types: custom
Name: "vision\minicpmv45"; Description: "MiniCPM-V 4.5, recommended VRAM 8G"; Types: custom
Name: "vision\gemma312b"; Description: "Gemma 3 12B, recommended VRAM 12G"; Types: custom

[Files]
Source: "{#StagingDir}\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion; Components: main
Source: "{#StagingDir}\redist\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: ignoreversion skipifsourcedoesntexist deleteafterinstall; Components: runtime
Source: "{#StagingDir}\redist\VC_redist.x64.exe"; DestDir: "{tmp}"; Flags: ignoreversion skipifsourcedoesntexist deleteafterinstall; Components: runtime
Source: "{#StagingDir}\ai-runtime\ollama\*"; DestDir: "{app}\ai-runtime\ollama"; Flags: recursesubdirs ignoreversion skipifsourcedoesntexist; Components: runtime\ollama vision
Source: "{src}\..\payload\ollama-models\all\*"; DestDir: "{app}\ai-runtime\ollama-models"; Flags: external recursesubdirs ignoreversion skipifsourcedoesntexist; Components: vision

[Icons]
Name: "{autoprograms}\RefMind3D"; Filename: "{app}\refmind3d.exe"
Name: "{autodesktop}\RefMind3D"; Filename: "{app}\refmind3d.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 Runtime..."; Flags: waituntilterminated skipifdoesntexist; Components: runtime
Filename: "{tmp}\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Visual C++ Runtime..."; Flags: waituntilterminated skipifdoesntexist; Components: runtime
Filename: "{app}\refmind3d.exe"; Description: "Launch RefMind3D"; Flags: nowait postinstall skipifsilent
