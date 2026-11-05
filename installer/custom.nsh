!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include Sections.nsh
!include "${PROJECT_DIR}\installer\data-cleanup.nsh"
!ifdef BUILD_UNINSTALLER
Var DC_DataActive
Var DC_DataPending
Var DC_DataPrevious
!endif

; 品牌图形沿用应用的深蓝和绿色；向导只使用简体中文。
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 YOTOO 部署中心"
!define MUI_WELCOMEPAGE_TEXT "在本机管理 Java 服务的构建、部署与回滚。$\r$\n$\r$\n向导将帮助您选择安装目录和快捷方式。配置、部署历史与日志独立保存在当前用户的数据目录，升级不会清空。$\r$\n$\r$\n安装前请正常退出 YOTOO 部署中心；有部署任务时请等待结束或安全取消。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 YOTOO 部署中心 的安装文件夹。您可以直接输入路径，或点击浏览选择其他磁盘和目录。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装目录"
!define MUI_FINISHPAGE_TITLE "YOTOO 部署中心 已安装"
!define MUI_FINISHPAGE_TEXT "应用已安装完成，可从开始菜单或 Windows 搜索启动。$\r$\n$\r$\n首次启动请添加服务和服务器配置，部署前建议先执行试运行。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 YOTOO 部署中心"
!define MUI_UNFINISHPAGE_TITLE "YOTOO 部署中心 已卸载"
!define MUI_UNFINISHPAGE_TEXT "程序与快捷方式已移除。$\r$\n$\r$\n默认保留用户配置、部署历史和日志，重新安装可继续使用。只有主动选择彻底清理时才删除用户数据。"
!define removeDefaultUninstallWelcomePage
Var DC_FontBrand
Var DC_FontBrandCn
Var DC_FontSmall
Var DC_FontFoot
Var DC_FontTitle
Var DC_LogoHandle

!macro DC_LoadBrandIcon
  InitPluginsDir
  File /oname=$PLUGINSDIR\dc-brand.ico "${PROJECT_DIR}\installer\brand.ico"
!macroend

!ifndef BUILD_UNINSTALLER
Var DC_ChosenDir
Var DC_DesktopChoice
Var DC_Checkbox
Var DC_Dialog
Var DC_Log
Var DC_Rollback
Var DC_OldVersion
Var DC_OldDesktop
Var DC_OldExecutable
Var DC_OldUninstaller
Var DC_OldName
Var DC_OldPublisher
Var DC_OldShortcut
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_BrandWelcome
  !insertmacro MUI_PAGE_WELCOME
!macroend

; 禁止安装器或卸载器强杀应用，包括正在执行部署的应用。
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${If} $DC_ChosenDir != ""
      ; 保持用户确认的原安装目录，避免品牌改名时框架自动再追加一层文件夹。
      StrCpy $INSTDIR $DC_ChosenDir
      StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
  !endif
  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop $0
  ${If} $0 != 0
    nsProcess::_FindProcess /NOUNLOAD "Deploy Center.exe"
    Pop $0
  ${EndIf}
  ${If} $0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "YOTOO 部署中心 正在运行。$\r$\n请返回应用，等待部署结束或请求安全取消，然后正常退出，再重新运行本向导。$\r$\n安装程序不会强制关闭应用。" /SD IDOK
    SetErrorLevel 1602
    Quit
  ${EndIf}
!macroend

!macro customInit
  !insertmacro DC_LoadBrandIcon
  StrCpy $DC_DesktopChoice ${BST_CHECKED}
  CreateDirectory "$LOCALAPPDATA\DeployCenter\InstallerLogs"
  FileOpen $DC_Log "$LOCALAPPDATA\DeployCenter\InstallerLogs\last-install.log" a
  FileWrite $DC_Log "开始安装 ${VERSION}，目录：$INSTDIR$\r$\n"
  FileClose $DC_Log
  !insertmacro customCheckAppRunning
  ${If} ${Silent}
    Call DC_ValidateDirectory
    StrCpy $DC_ChosenDir $INSTDIR
    Call DC_BackupOldProgram
  ${EndIf}
!macroend

!macro DC_BrandFunctions PREFIX
Function ${PREFIX}DC_BrandPanel
  ; 侧栏背景可以铺满，但图标用 ICO 的原生方形尺寸，文字用原生控件绘制。
  ${NSD_CreateLabel} 0u 0u 109u 193u ""
  Pop $0
  System::Call 'user32::SetWindowPos(p r0,p0,i0,i0,i0,i0,i0x13)'
  SetCtlColors $0 "FFFFFF" "153B66"
  SendMessage $0 ${WM_SETTEXT} 0 "STR:"
  System::Call 'user32::SetWindowPos(p r0,p1,i0,i0,i0,i0,i0x13)'
  ${If} $DC_FontBrand == ""
    CreateFont $DC_FontBrand "Segoe UI" 20 600
    CreateFont $DC_FontBrandCn "Microsoft YaHei" 17 600
    CreateFont $DC_FontSmall "Microsoft YaHei" 9 400
    CreateFont $DC_FontFoot "Segoe UI" 8 400
    CreateFont $DC_FontTitle "Microsoft YaHei" 13 600
  ${EndIf}
  System::Call 'user32::GetDpiForWindow(p$HWNDPARENT)i.r0'
  IntOp $1 $0 * 80
  IntOp $1 $1 / 96
  ${NSD_CreateIcon} 12u 14u $1 $1 ""
  Pop $3
  ${If} $DC_LogoHandle == ""
    System::Call 'user32::LoadImageW(p0,w "$PLUGINSDIR\dc-brand.ico",i1,ir1,ir1,i0x10)p.r2'
    StrCpy $DC_LogoHandle $2
  ${EndIf}
  SendMessage $3 ${STM_SETIMAGE} ${IMAGE_ICON} $DC_LogoHandle
  System::Call 'user32::SetWindowPos(p r3,p0,i0,i0,i0,i0,i0x13)'
  ${NSD_CreateLabel} 12u 69u 92u 24u "YOTOO"
  Pop $0
  System::Call 'user32::SetWindowPos(p r0,p0,i0,i0,i0,i0,i0x13)'
  SetCtlColors $0 "FFFFFF" "153B66"
  SendMessage $0 ${WM_SETFONT} $DC_FontBrand 1
  ${NSD_CreateLabel} 12u 91u 92u 24u "部署中心"
  Pop $0
  System::Call 'user32::SetWindowPos(p r0,p0,i0,i0,i0,i0,i0x13)'
  SetCtlColors $0 "FFFFFF" "153B66"
  SendMessage $0 ${WM_SETFONT} $DC_FontBrandCn 1
  ${NSD_CreateLabel} 12u 122u 22u 2u ""
  Pop $0
  System::Call 'user32::SetWindowPos(p r0,p0,i0,i0,i0,i0,i0x13)'
  SetCtlColors $0 "5BDFC5" "5BDFC5"
  ${NSD_CreateLabel} 12u 140u 92u 18u "构建 · 部署 · 回滚"
  Pop $0
  System::Call 'user32::SetWindowPos(p r0,p0,i0,i0,i0,i0,i0x13)'
  SetCtlColors $0 "DCE8F3" "153B66"
  SendMessage $0 ${WM_SETFONT} $DC_FontSmall 1
  ${NSD_CreateLabel} 12u 171u 92u 14u "本地部署工作台"
  Pop $0
  System::Call 'user32::SetWindowPos(p r0,p0,i0,i0,i0,i0,i0x13)'
  SetCtlColors $0 "B5C9DF" "153B66"
  SendMessage $0 ${WM_SETFONT} $DC_FontFoot 1
FunctionEnd

Function ${PREFIX}DC_BrandFinish
  Call ${PREFIX}DC_BrandPanel
  SendMessage $mui.FinishPage.Title ${WM_SETFONT} $DC_FontTitle 1
  SendMessage $mui.FinishPage.Text ${WM_SETFONT} $DC_FontSmall 1
FunctionEnd
!macroend

!macro customFinishPage
  Function DC_StartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION DC_StartApp
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_BrandFinish
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.DC_BrandFinish
!macroend

!macro customHeader
ManifestDPIAware true
SetFont /LANG=2052 "Microsoft YaHei" 9
!ifdef BUILD_UNINSTALLER
  !insertmacro DC_BrandFunctions "un."
!else
  !insertmacro DC_BrandFunctions ""
  Function DC_BrandWelcome
    Call DC_BrandPanel
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $DC_FontTitle 1
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $DC_FontSmall 1
  FunctionEnd
!endif
!ifndef BUILD_UNINSTALLER
Function DC_ValidateDirectory
  ${If} $INSTDIR == ""
    MessageBox MB_OK|MB_ICONSTOP "安装目录不能为空。" /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == $INSTDIR
  ${OrIf} "$0\" == $INSTDIR
    MessageBox MB_OK|MB_ICONSTOP "请选择磁盘中的应用文件夹，不能直接安装到磁盘根目录。" /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
  ClearErrors
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\.deploy-center-write-test" w
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法写入所选目录：$\r$\n$INSTDIR$\r$\n$\r$\n请确认路径有效，并选择当前用户有写入权限的位置。受保护目录可能需要管理员权限，本安装器不会请求提权。" /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
  FileClose $0
  Delete "$INSTDIR\.deploy-center-write-test"
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$INSTDIR", *l .r0, *l .r1, *l .r2) i .r3'
  ${If} $3 == 0
    MessageBox MB_OK|MB_ICONSTOP "无法读取安装磁盘的可用空间，请检查目录或磁盘状态。" /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
  System::Int64Op $0 / 1048576
  Pop $0
  !ifdef APP_64_UNPACKED_SIZE
    IntOp $1 ${APP_64_UNPACKED_SIZE} / 1024
    IntOp $1 $1 * 2
    IntOp $1 $1 + 100
  !else
    StrCpy $1 1024
  !endif
  ${If} $0 < $1
    MessageBox MB_OK|MB_ICONSTOP "磁盘空间不足。$\r$\n需要至少 $1 MB，可用 $0 MB。$\r$\n请更换安装目录或释放空间后重试。" /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
FunctionEnd

Function DC_OptionsCreate
  !insertmacro MUI_HEADER_TEXT "安装选项" "确认安装位置与快捷方式"
  nsDialogs::Create 1018
  Pop $DC_Dialog
  ${If} $DC_Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "安装位置：$\r$\n$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0 35u 100% 30u "配置、历史和日志默认保存在：$\r$\n$APPDATA\DeployCenter（可在应用设置中迁移）"
  Pop $0
  ${NSD_CreateCheckbox} 0 82u 100% 14u "创建桌面快捷方式"
  Pop $DC_Checkbox
  ${NSD_SetState} $DC_Checkbox $DC_DesktopChoice
  ${NSD_CreateLabel} 0 112u 100% 28u "始终创建开始菜单入口。升级会保留用户数据；安装和使用均以当前普通用户运行。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DC_OptionsLeave
  ${NSD_GetState} $DC_Checkbox $DC_DesktopChoice
  Call DC_ValidateDirectory
  StrCpy $DC_ChosenDir $INSTDIR
  Call DC_BackupOldProgram
FunctionEnd

Function .onInstFailed
  ${If} $DC_Rollback != ""
    CreateDirectory "$INSTDIR"
    ClearErrors
    CopyFiles /SILENT "$DC_Rollback\*.*" "$INSTDIR"
    ${IfNot} ${Errors}
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName "$DC_OldName"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "$DC_OldVersion"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" Publisher "$DC_OldPublisher"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString '$\"$INSTDIR\$DC_OldUninstaller$\"'
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayIcon "$INSTDIR\$DC_OldExecutable,0"
      WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoModify 1
      WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoRepair 1
      CreateShortCut "$SMPROGRAMS\$DC_OldShortcut.lnk" "$INSTDIR\$DC_OldExecutable"
      ${If} $DC_OldDesktop == 1
        CreateShortCut "$DESKTOP\$DC_OldShortcut.lnk" "$INSTDIR\$DC_OldExecutable"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  CreateDirectory "$LOCALAPPDATA\DeployCenter\InstallerLogs"
  FileOpen $DC_Log "$LOCALAPPDATA\DeployCenter\InstallerLogs\last-install.log" a
  FileWrite $DC_Log "安装未完成，目录：$INSTDIR。请查看向导详细信息并确认目录权限、空间和应用运行状态。$\r$\n"
  FileClose $DC_Log
  MessageBox MB_OK|MB_ICONSTOP "YOTOO 部署中心 安装未完成。$\r$\n请检查安装目录权限、磁盘空间，以及应用是否已退出。$\r$\n安装日志：$LOCALAPPDATA\DeployCenter\InstallerLogs\last-install.log$\r$\n用户配置和部署历史不会因此被清空。" /SD IDOK
FunctionEnd
Function DC_BackupOldProgram
  ${If} $DC_Rollback != ""
    Return
  ${EndIf}
  StrCpy $DC_OldExecutable "${APP_EXECUTABLE_FILENAME}"
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" DC_FoundPreviousProgram 0
  StrCpy $DC_OldExecutable "Deploy Center.exe"
  IfFileExists "$INSTDIR\Deploy Center.exe" 0 DC_NoPreviousProgram
  DC_FoundPreviousProgram:
  ReadRegStr $DC_OldName HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName
  ReadRegStr $DC_OldPublisher HKCU "${UNINSTALL_REGISTRY_KEY}" Publisher
  ReadRegStr $DC_OldShortcut HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName
  ${If} $DC_OldShortcut == ""
    StrCpy $DC_OldShortcut "Deploy Center"
  ${EndIf}
  StrCpy $DC_OldUninstaller "Uninstall $DC_OldExecutable"
  ; EXE 文件名带后缀，卸载器名称同样以 .exe 结束。

  !insertmacro customCheckAppRunning
  ReadRegStr $DC_OldVersion HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  StrCpy $DC_OldDesktop 0
  IfFileExists "$DESKTOP\$DC_OldShortcut.lnk" 0 +2
  StrCpy $DC_OldDesktop 1
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $DC_Rollback "$LOCALAPPDATA\DeployCenter\InstallerRollback\$0"
  CreateDirectory "$DC_Rollback"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\*.*" "$DC_Rollback"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法备份旧版程序，已停止升级。请检查磁盘空间与目录权限。旧版尚未被卸载。" /SD IDOK
    StrCpy $DC_Rollback ""
    SetErrorLevel 1603
    Abort
  ${EndIf}
  DC_NoPreviousProgram:
FunctionEnd

Function .onInstSuccess
  SetErrorLevel 0
  ${If} $DC_Rollback != ""
    ; 路径只由固定应用目录与 GetTickCount 生成，禁止使用用户输入作为删除目标。
    StrLen $0 "$LOCALAPPDATA\DeployCenter\InstallerRollback\"
    StrCpy $1 $DC_Rollback $0
    ${If} $1 == "$LOCALAPPDATA\DeployCenter\InstallerRollback\"
      RMDir /r "$DC_Rollback"
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif
!macroend

!macro customPageAfterChangeDir
  Page custom DC_OptionsCreate DC_OptionsLeave
!macroend

!macro customInstall
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  ${If} $DC_DesktopChoice == ${BST_UNCHECKED}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${EndIf}
  CreateDirectory "$LOCALAPPDATA\DeployCenter\InstallerLogs"
  FileOpen $DC_Log "$LOCALAPPDATA\DeployCenter\InstallerLogs\last-install.log" a
  FileWrite $DC_Log "安装成功 ${VERSION}，目录：$INSTDIR$\r$\n"
  FileClose $DC_Log
!macroend

; 卸载组件页默认不勾选数据清理。升级时即使被传入该选项，也不执行删除。
!macro customUnInit
  !insertmacro DC_LoadBrandIcon
  Call un.DC_ParsePurgeOptions
!macroend

!macro customUnInstallSection
  !insertmacro DC_DataCleanupFunctions "un."
  Section /o "un.彻底清理当前用户的配置、部署历史和日志（可选）" DC_PurgeData
    ${IfNot} ${isUpdated}
      StrCpy $DC_PurgeError ""
      StrCpy $DC_DataActive "$APPDATA\DeployCenter"
      StrCpy $DC_DataPending ""
      StrCpy $DC_DataPrevious ""
      IfFileExists "$LOCALAPPDATA\DeployCenter\Settings\data-location.ini" DC_PurgeReadIni 0
      IfFileExists "$LOCALAPPDATA\DeployCenter\Settings\data-location.json" 0 DC_PurgeReadDone
      StrCpy $DC_PurgeError "数据位置记录不完整，所有用户数据及位置记录已保留。"
      Goto DC_PurgeReadDone
      DC_PurgeReadIni:
      ReadINIStr $DC_DataActive "$LOCALAPPDATA\DeployCenter\Settings\data-location.ini" "location" "active"
      ReadINIStr $DC_DataPending "$LOCALAPPDATA\DeployCenter\Settings\data-location.ini" "location" "pending"
      ReadINIStr $DC_DataPrevious "$LOCALAPPDATA\DeployCenter\Settings\data-location.ini" "location" "previous"
      ${If} $DC_DataActive == ""
        StrCpy $DC_PurgeError "数据位置记录无法读取，所有用户数据已保留。"
      ${EndIf}
      DC_PurgeReadDone:
      Push $DC_DataActive
      Call un.DC_ValidateDataRoot
      Push $DC_DataPending
      Call un.DC_ValidateDataRoot
      Push $DC_DataPrevious
      Call un.DC_ValidateDataRoot
      Push "$LOCALAPPDATA\DeployCenter\Settings"
      Call un.DC_ValidateDataRoot
      ${If} $DC_PurgeError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$DC_PurgeError$\r$\n程序卸载继续，未清理用户数据。" /SD IDOK
        Goto DC_PurgeDone
      ${EndIf}
      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "将永久删除以下数据目录中的配置、历史、凭据、日志及本地产物：$\r$\n当前：$DC_DataActive$\r$\n待切换：$DC_DataPending$\r$\n旧副本：$DC_DataPrevious$\r$\n位置设置：$LOCALAPPDATA\DeployCenter\Settings$\r$\n$\r$\n服务器文件不受影响。确定彻底清理吗？" /SD IDNO IDYES +2
        Goto DC_PurgeDone
      ${EndIf}
      Push $DC_DataActive
      Call un.DC_RemoveDataRoot
      Push $DC_DataPending
      Call un.DC_RemoveDataRoot
      Push $DC_DataPrevious
      Call un.DC_RemoveDataRoot
      Push "$LOCALAPPDATA\DeployCenter\Settings"
      Call un.DC_RemoveDataRoot
      ${If} $DC_PurgeError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$DC_PurgeError$\r$\n未清理的内容与位置记录已保留，请手动核实。" /SD IDOK
      ${EndIf}
      DC_PurgeDone:
    ${EndIf}
  SectionEnd
  Function un.DC_ParsePurgeOptions
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/PURGEDATA" $1
    ${IfNot} ${Errors}
    ${AndIfNot} ${isUpdated}
      !insertmacro SelectSection ${DC_PurgeData}
    ${EndIf}
  FunctionEnd
!macroend
