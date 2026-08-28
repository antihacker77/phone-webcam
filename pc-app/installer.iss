; Inno Setup script — builds a Windows installer for Phone Webcam.
; Requires: dist\PhoneWebcam.exe and dist\camera_worker.exe already built
; (pyinstaller build.spec)
; Compile: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
;
; Bundles the OBS Virtual Camera DirectShow filter (see
; vendor\obs-virtualcam\NOTICE.md) and registers it during install, so no
; separate camera-driver install is needed — installing this app is enough.

#define MyAppName "Phone Webcam"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Phone Webcam"
#define MyAppExeName "PhoneWebcam.exe"

[Setup]
AppId={{B6F2E9C0-6B0A-4C7B-9C7C-6D6F6E6F6F01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist_installer
OutputBaseFilename=PhoneWebcam-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
; Registering the virtual camera writes to HKEY_LOCAL_MACHINE, which needs
; admin rights — unlike the rest of the app, this one step can't run as a
; regular user.
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "dist\PhoneWebcam.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\camera_worker.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "vendor\obs-virtualcam\obs-virtualcam-module64.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "vendor\obs-virtualcam\obs-virtualcam-module32.dll"; DestDir: "{app}"; Flags: ignoreversion; Check: Is64BitInstallMode
Source: "vendor\obs-virtualcam\NOTICE.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{sys}\regsvr32.exe"; Parameters: "/s ""{app}\obs-virtualcam-module64.dll"""; Flags: runhidden; StatusMsg: "Registering virtual camera..."
Filename: "{syswow64}\regsvr32.exe"; Parameters: "/s ""{app}\obs-virtualcam-module32.dll"""; Flags: runhidden; Check: Is64BitInstallMode; StatusMsg: "Registering virtual camera (32-bit)..."
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\regsvr32.exe"; Parameters: "/u /s ""{app}\obs-virtualcam-module64.dll"""; Flags: runhidden; RunOnceId: "UnregVirtualCam64"
Filename: "{syswow64}\regsvr32.exe"; Parameters: "/u /s ""{app}\obs-virtualcam-module32.dll"""; Flags: runhidden; Check: Is64BitInstallMode; RunOnceId: "UnregVirtualCam32"
