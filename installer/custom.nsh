!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include Sections.nsh
!include "${PROJECT_DIR}\installer\progress.nsh"
!include "${PROJECT_DIR}\installer\data-cleanup.nsh"
!include "${PROJECT_DIR}\installer\data-paths.nsh"
!ifdef BUILD_UNINSTALLER
Var DC_DataActive
Var DC_DataPending
Var DC_DataPrevious
!endif

; 原生向导跟随 2.0 的浅色表面和橙色品牌。图形与文字分别绘制，避免缩放时拉伸文字。
!define MUI_BGCOLOR "FFFDFB"
!define DC_BRAND_INK "211F1E"
!define DC_BRAND_MUTED "605A56"
!define DC_WELCOME_TITLE "安装 YOTOO 部署中心"
!define MUI_WELCOMEPAGE_TITLE "${DC_WELCOME_TITLE}"
!define MUI_WELCOMEPAGE_TEXT "在本机管理 Java 服务的构建、部署与回滚。$\r$\n$\r$\n继续后可选择安装位置与快捷方式。覆盖安装会保留配置、部署历史与日志。$\r$\n$\r$\n安装前请等待正在执行的任务结束，然后正常退出应用。"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "已安装 YOTOO 部署中心 v${VERSION}。$\r$\n$\r$\n可立即打开应用，也可稍后从开始菜单或 Windows 搜索启动。原有用户数据可继续使用。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 YOTOO 部署中心"
!define MUI_UNFINISHPAGE_TITLE "YOTOO 部署中心 已卸载"
!define MUI_UNFINISHPAGE_TEXT "程序与快捷方式已移除。$\r$\n$\r$\n默认保留用户配置、部署历史和日志，重新安装可继续使用。只有主动选择彻底清理时才删除用户数据。"
!define removeDefaultUninstallWelcomePage
!ifndef BUILD_UNINSTALLER
Var DC_FontSmall
Var DC_FontTitle
Var DC_FontCheck
Var DC_LogoHandle
!endif

!macro DC_LoadBrandIcon
  InitPluginsDir
  File /oname=$PLUGINSDIR\dc-brand.ico "${PROJECT_DIR}\installer\brand.ico"
!macroend

!ifndef BUILD_UNINSTALLER
Var DC_ChosenDir
Var DC_WizardDir
Var DC_PreviousDir
Var DC_BackupSource
Var DC_PathInput
Var DC_SpaceLabel
Var DC_RequiredMB
Var DC_DesktopChoice
Var DC_Checkbox
Var DC_Dialog
Var DC_Log
Var DC_Rollback
Var DC_BackupId
Var DC_OldVersion
Var DC_OldDesktop
Var DC_OldExecutable
Var DC_OldUninstaller
Var DC_OldName
Var DC_OldPublisher
Var DC_OldShortcut
Var DC_ProgramWithdrawn
Var DC_InstallError
!define DC_PENDING_EXE ".deploy-center-installing.exe"
!endif

!macro DC_StageProgramExecutable
  ; 所有文件准备好之前，解包结果中的 EXE 只使用暂存文件名。
  ClearErrors
  Rename "$OUTDIR\${APP_EXECUTABLE_FILENAME}" "$OUTDIR\${DC_PENDING_EXE}"
  ${If} ${Errors}
    Push "无法暂存主程序"
    Call DC_AbortProgramInstall
  ${EndIf}
!macroend

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
  !insertmacro customCheckAppRunning
  Call DC_SetDataPaths
  ${IfNot} ${Silent}
    !insertmacro DC_LoadBrandIcon
  ${EndIf}
  Call DC_ReadPreviousDirectory
  StrCpy $DC_WizardDir $INSTDIR
  !ifdef APP_64_UNPACKED_SIZE
    IntOp $DC_RequiredMB ${APP_64_UNPACKED_SIZE} / 1024
    IntOp $DC_RequiredMB $DC_RequiredMB * 2
    IntOp $DC_RequiredMB $DC_RequiredMB + 100
  !else
    StrCpy $DC_RequiredMB 1024
  !endif
  StrCpy $DC_DesktopChoice ${BST_CHECKED}
  ${If} ${Silent}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/YOTOOUPDATE" $1
    ${IfNot} ${Errors}
      ${If} $DC_PreviousDir == ""
      ${OrIf} $INSTDIR != $DC_PreviousDir
        SetErrorLevel 1603
        Abort
      ${EndIf}
      IfFileExists "$DESKTOP\${SHORTCUT_NAME}.lnk" +2 0
      StrCpy $DC_DesktopChoice ${BST_UNCHECKED}
    ${EndIf}
  ${EndIf}
  CreateDirectory "$DC_InstallerLogs"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileWrite $DC_Log "开始安装 ${VERSION}，目录：$INSTDIR$\r$\n"
  FileClose $DC_Log
  !insertmacro customCheckAppRunning
  ${If} ${Silent}
    Call DC_ValidateDirectory
    StrCpy $DC_ChosenDir $INSTDIR
  ${EndIf}
!macroend

!macro DC_PreviousDirectoryFunction
Function DC_ReadPreviousDirectory
  ReadRegStr $DC_PreviousDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $DC_PreviousDir == ""
    ; 旧版的框架位置可能为空。仅接受同一安装标识且和旧卸载器指向一致的位置。
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $0 == ""
      Return
    ${EndIf}
    GetFullPathName $0 "$0"
    StrCpy $2 $0 1 -1
    ${If} $2 == "\"
      StrCpy $0 $0 -1
    ${EndIf}
    StrCpy $2 $0 2 1
    ${If} $2 != ":\"
      Return
    ${EndIf}
    IfFileExists "$0\resources\app.asar" 0 DC_NoPreviousDirectory
    StrCpy $2 "${APP_EXECUTABLE_FILENAME}"
    IfFileExists "$0\$2" DC_MatchUninstaller 0
    StrCpy $2 "Deploy Center.exe"
    IfFileExists "$0\$2" 0 DC_NoPreviousDirectory
    DC_MatchUninstaller:
    IfFileExists "$0\Uninstall $2" 0 DC_NoPreviousDirectory
    StrCpy $3 '$\"$0\Uninstall $2$\"'
    StrLen $2 $3
    StrCpy $1 $1 $2
    ${If} $1 != $3
      Return
    ${EndIf}
    StrCpy $DC_PreviousDir $0
  ${Else}
    GetFullPathName $DC_PreviousDir "$DC_PreviousDir"
    StrCpy $0 $DC_PreviousDir 1 -1
    ${If} $0 == "\"
      StrCpy $DC_PreviousDir $DC_PreviousDir -1
    ${EndIf}
  ${EndIf}
  ; 保留显式 /D，尤其是静默更新传入的路径，仍由原有路径校验判断。
  !insertmacro GetDParameter $0
  ${If} $0 == ""
    StrCpy $INSTDIR $DC_PreviousDir
  ${EndIf}
  DC_NoPreviousDirectory:
FunctionEnd
!macroend

!macro DC_CenteredLabel Y H TEXT FONT COLOR
  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_CENTER} 0 0 ${Y} 100% ${H} "${TEXT}"
  Pop $0
  SetCtlColors $0 "${COLOR}" "${MUI_BGCOLOR}"
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
!macroend

!macro DC_WizardVisuals
Function DC_InitFonts
  ${If} $DC_FontTitle == ""
    CreateFont $DC_FontTitle "Microsoft YaHei" 19 600
    CreateFont $DC_FontSmall "Microsoft YaHei" 9 400
    CreateFont $DC_FontCheck "Segoe UI Symbol" 32 600
  ${EndIf}
FunctionEnd

Function DC_BrandWelcome
  ShowWindow $mui.WelcomePage.Image ${SW_HIDE}
  ShowWindow $mui.WelcomePage.Title ${SW_HIDE}
  ShowWindow $mui.WelcomePage.Text ${SW_HIDE}
  Call DC_InitFonts
  ; 按窗口 DPI 从 ICO 选择清晰的尺寸，再在内容区水平居中。
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.r0'
  IntOp $1 $0 * 76
  IntOp $1 $1 / 96
  ${NSD_CreateIcon} 0 24u $1 $1 ""
  Pop $3
  ${If} $DC_LogoHandle == ""
    System::Call 'user32::LoadImageW(p0,w "$PLUGINSDIR\dc-brand.ico",i1,ir1,ir1,i0x10)p.r2'
    StrCpy $DC_LogoHandle $2
  ${EndIf}
  SendMessage $3 ${STM_SETIMAGE} ${IMAGE_ICON} $DC_LogoHandle
  System::Call 'user32::GetParent(p r3)p.r4'
  System::Call '*(i0,i0,i0,i0)p.r5'
  System::Call 'user32::GetWindowRect(p r3,p r5)'
  System::Call 'user32::MapWindowPoints(p0,p r4,p r5,i2)'
  System::Call '*$5(i,i.r2,i,i)'
  System::Call 'user32::GetClientRect(p r4,p r5)'
  System::Call '*$5(i,i,i.r0,i)'
  System::Free $5
  IntOp $0 $0 - $1
  IntOp $0 $0 / 2
  System::Call 'user32::SetWindowPos(p r3,p0,ir0,ir2,ir1,ir1,i0x14)'
  !insertmacro DC_CenteredLabel 71u 15u "Windows x64 · v${VERSION}" $DC_FontSmall "${DC_BRAND_MUTED}"
  !insertmacro DC_CenteredLabel 87u 24u "${DC_WELCOME_TITLE}" $DC_FontTitle "${DC_BRAND_INK}"
  !insertmacro DC_CenteredLabel 116u 18u "在本机管理 Java 服务的构建、部署与回滚。" $DC_FontSmall "${DC_BRAND_MUTED}"
  !insertmacro DC_CenteredLabel 146u 18u "覆盖安装会保留现有配置、部署历史和日志。" $DC_FontSmall "${DC_BRAND_MUTED}"
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:开始设置"
FunctionEnd

Function DC_BrandFinish
  ; 重启提示页仍由 MUI 处理。
  ${If} $mui.FinishPage.Run == ""
    Return
  ${EndIf}
  ShowWindow $mui.FinishPage.Image ${SW_HIDE}
  ShowWindow $mui.FinishPage.Title ${SW_HIDE}
  ShowWindow $mui.FinishPage.Text ${SW_HIDE}
  ShowWindow $mui.FinishPage.Run ${SW_HIDE}
  Call DC_InitFonts
  !insertmacro DC_CenteredLabel 20u 14u "第 4 步 / 共 4 步" $DC_FontSmall "166649"
  !insertmacro DC_CenteredLabel 37u 40u "✓" $DC_FontCheck "166649"
  !insertmacro DC_CenteredLabel 83u 25u "安装完成" $DC_FontTitle "${DC_BRAND_INK}"
  !insertmacro DC_CenteredLabel 115u 17u "YOTOO 部署中心已安装，可以从开始菜单打开。" $DC_FontSmall "${DC_BRAND_MUTED}"
  ${NSD_CreateCheckbox} 103u 143u 130u 16u "立即打开 YOTOO 部署中心"
  Pop $mui.FinishPage.Run
  SetCtlColors $mui.FinishPage.Run "${DC_BRAND_INK}" "${MUI_BGCOLOR}"
  ${NSD_SetState} $mui.FinishPage.Run ${BST_CHECKED}
FunctionEnd
!macroend

!macro customFinishPage
  Function DC_StartApp
    ; 当前用户安装。直接启动已校验的入口，避免在完成页等待资源管理器解析快捷方式。
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION DC_StartApp
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_BrandFinish
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
  ShowInstDetails show
  !insertmacro DC_ProgressFunctions
!endif
!insertmacro DC_DataCleanupVariables
!ifdef BUILD_UNINSTALLER
  !insertmacro DC_DataPathFunctions "un."
!else
  !insertmacro DC_DataPathFunctions ""
  !define DC_DATA_CHECK_ONLY
  !insertmacro DC_DataCleanupFunctions ""
  !undef DC_DATA_CHECK_ONLY
!endif
ManifestDPIAware true
SetFont /LANG=2052 "Microsoft YaHei" 9
!ifndef BUILD_UNINSTALLER
!insertmacro DC_WizardVisuals
!insertmacro DC_PreviousDirectoryFunction
Function DC_ValidateDirectory
  StrCpy $0 $INSTDIR 2 1
  System::Call 'shlwapi::PathGetDriveNumberW(w "$INSTDIR")i.r1'
  ${If} $0 != ":\"
  ${OrIf} $1 < 0
    StrCpy $0 "请输入带盘符的完整安装目录。"
    Goto DC_DirectoryError
  ${EndIf}
  GetFullPathName $INSTDIR "$INSTDIR"
  StrCpy $0 $INSTDIR 1 -1
  ${If} $0 == "\"
    StrCpy $INSTDIR $INSTDIR -1
  ${EndIf}
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == $INSTDIR
  ${OrIf} "$0\" == $INSTDIR
    StrCpy $0 "请指定应用文件夹，不能直接安装到磁盘根目录。"
    Goto DC_DirectoryError
  ${EndIf}
  ; 程序目录会由卸载器管理。它须与数据目录分开，新位置也不能占用原安装目录。
  StrLen $0 "$DC_DataRoot\"
  StrCpy $1 "$INSTDIR\" $0
  StrLen $0 "$INSTDIR\"
  StrCpy $2 "$DC_DataRoot\" $0
  ${If} $1 == "$DC_DataRoot\"
  ${OrIf} $2 == "$INSTDIR\"
    StrCpy $0 "安装目录与用户数据目录不能重合或互相包含。"
    Goto DC_DirectoryError
  ${EndIf}
  ${If} $INSTDIR != $DC_PreviousDir
    ${If} $DC_PreviousDir != ""
      StrLen $0 "$DC_PreviousDir\"
      StrCpy $1 "$INSTDIR\" $0
      ${If} $1 == "$DC_PreviousDir\"
        StrCpy $0 "新目录不能位于原安装目录内。"
        Goto DC_DirectoryError
      ${EndIf}
    ${EndIf}
    FindFirst $0 $1 "$INSTDIR\*"
    ${While} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        FindClose $0
        StrCpy $0 "请选择空目录，或输入一个新的应用目录。"
        Goto DC_DirectoryError
      ${EndIf}
      FindNext $0 $1
    ${EndWhile}
    FindClose $0
  ${EndIf}
  StrCpy $2 $INSTDIR
  DC_CheckDirectoryParents:
    System::Call 'kernel32::GetFileAttributesW(w r2)i.r3'
    ${If} $3 != -1
      IntOp $3 $3 & 0x400
      ${If} $3 != 0
        StrCpy $0 "安装路径包含链接或目录联接，请选择普通目录。"
        Goto DC_DirectoryError
      ${EndIf}
    ${EndIf}
    ${GetParent} "$2" $3
    ${If} $3 != ""
    ${AndIf} $3 != $2
      StrCpy $2 $3
      Goto DC_CheckDirectoryParents
    ${EndIf}
  ClearErrors
  CreateDirectory "$INSTDIR"
  GetTempFileName $0 "$INSTDIR"
  ${If} ${Errors}
    StrCpy $0 "无法写入所选目录，请选择当前用户有写入权限的位置。"
    Goto DC_DirectoryError
  ${EndIf}
  Delete "$0"
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$INSTDIR",*l .r0,p0,p0)i.r3'
  ${If} $3 == 0
    StrCpy $0 "无法读取安装磁盘的可用空间。"
    Goto DC_DirectoryError
  ${EndIf}
  System::Int64Op $0 / 1048576
  Pop $0
  ${If} $0 < $DC_RequiredMB
    StrCpy $0 "磁盘空间不足。需要至少 $DC_RequiredMB MB，可用 $0 MB。"
    Goto DC_DirectoryError
  ${EndIf}
  Return
  DC_DirectoryError:
  MessageBox MB_OK|MB_ICONSTOP "$0$\r$\n$INSTDIR" /SD IDOK
  SetErrorLevel 1603
  Abort
FunctionEnd

Function DC_RefreshSpace
  Pop $0
  ${NSD_GetText} $DC_PathInput $1
  StrCpy $DC_WizardDir $1
  StrCpy $2 $1 3
  System::Call 'kernel32::GetDiskFreeSpaceExW(w r2,*l .r3,p0,p0)i.r4'
  ${If} $4 != 0
    System::Int64Op $3 / 1048576
    Pop $3
    ${NSD_SetText} $DC_SpaceLabel "需要 $DC_RequiredMB MB · 磁盘可用 $3 MB"
  ${Else}
    ${NSD_SetText} $DC_SpaceLabel "需要 $DC_RequiredMB MB · 安装前检查可用空间"
  ${EndIf}
FunctionEnd

Function DC_BrowseDirectory
  Pop $0
  ${NSD_GetText} $DC_PathInput $1
  nsDialogs::SelectFolderDialog "选择安装目录" "$1"
  Pop $1
  ${If} $1 != "error"
    ${NSD_SetText} $DC_PathInput "$1"
  ${EndIf}
FunctionEnd

Function DC_OptionsCreate
  !insertmacro MUI_HEADER_TEXT "选择安装位置" "第 2 步 / 共 4 步"
  nsDialogs::Create 1018
  Pop $DC_Dialog
  ${If} $DC_Dialog == error
    Abort
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装"
  ${NSD_CreateLabel} 0 5u 100% 15u "输入完整路径，或点击「浏览」选择其他磁盘或文件夹。"
  Pop $0
  ${NSD_CreateLabel} 0 29u 100% 13u "安装目录"
  Pop $0
  ; 交互式安装模式页即使跳过，也会重算 $INSTDIR。使用向导自己的路径，并保留用户编辑。
  ${NSD_CreateDirRequest} 0 44u 80% 17u "$DC_WizardDir"
  Pop $DC_PathInput
  ${NSD_CreateBrowseButton} 82% 44u 18% 17u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 DC_BrowseDirectory
  ${NSD_CreateLabel} 0 65u 100% 14u ""
  Pop $DC_SpaceLabel
  ${NSD_OnChange} $DC_PathInput DC_RefreshSpace
  Push $DC_PathInput
  Call DC_RefreshSpace
  ${NSD_CreateCheckbox} 0 88u 100% 14u "创建桌面快捷方式"
  Pop $DC_Checkbox
  ${NSD_SetState} $DC_Checkbox $DC_DesktopChoice
  ${NSD_CreateLabel} 0 113u 100% 29u "配置、部署历史和日志保存在原数据目录。$\r$\n开始菜单入口会自动创建。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DC_OptionsLeave
  ${NSD_GetState} $DC_Checkbox $DC_DesktopChoice
  ${NSD_GetText} $DC_PathInput $INSTDIR
  Call DC_ValidateDirectory
  StrCpy $DC_ChosenDir $INSTDIR
FunctionEnd

Function .onInstFailed
  ${If} $DC_ProgramWithdrawn == "1"
    CreateDirectory "$DC_BackupSource"
    ClearErrors
    ; 恢复旧版时同样先恢复依赖，最后恢复原有快捷方式对应的 EXE。
    Rename "$DC_Rollback\$DC_OldExecutable" "$DC_Rollback\${DC_PENDING_EXE}"
    ${IfNot} ${Errors}
      CopyFiles /SILENT "$DC_Rollback\*.*" "$DC_BackupSource"
      ${IfNot} ${Errors}
        Rename "$DC_BackupSource\${DC_PENDING_EXE}" "$DC_BackupSource\$DC_OldExecutable"
      ${EndIf}
    ${EndIf}
    ${IfNot} ${Errors}
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$DC_BackupSource"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName "$DC_OldName"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "$DC_OldVersion"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" Publisher "$DC_OldPublisher"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$DC_BackupSource"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString '$\"$DC_BackupSource\$DC_OldUninstaller$\"'
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayIcon "$DC_BackupSource\$DC_OldExecutable,0"
      WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoModify 1
      WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoRepair 1
      CreateShortCut "$SMPROGRAMS\$DC_OldShortcut.lnk" "$DC_BackupSource\$DC_OldExecutable"
      ${If} $DC_OldDesktop == 1
        CreateShortCut "$DESKTOP\$DC_OldShortcut.lnk" "$DC_BackupSource\$DC_OldExecutable"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  CreateDirectory "$DC_InstallerLogs"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileSeek $DC_Log 0 END
  FileWrite $DC_Log "安装未完成，目录：$INSTDIR。请查看向导详细信息并确认目录权限、空间和应用运行状态。$\r$\n"
  FileClose $DC_Log
  ${If} $DC_InstallError == ""
    StrCpy $DC_InstallError "请检查安装目录权限、磁盘空间，以及应用是否已退出。"
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "YOTOO 部署中心 安装未完成。$\r$\n$DC_InstallError$\r$\n安装日志：$DC_InstallerLogs\last-install.log$\r$\n用户配置和部署历史不会因此被清空。" /SD IDOK
FunctionEnd
Function DC_BackupOldProgram
  ${If} $DC_Rollback != ""
    Return
  ${EndIf}
  StrCpy $DC_BackupSource $DC_PreviousDir
  ${If} $DC_BackupSource == ""
    StrCpy $DC_BackupSource $INSTDIR
  ${EndIf}
  StrCpy $DC_OldExecutable "${APP_EXECUTABLE_FILENAME}"
  IfFileExists "$DC_BackupSource\${APP_EXECUTABLE_FILENAME}" DC_FoundPreviousProgram 0
  StrCpy $DC_OldExecutable "Deploy Center.exe"
  IfFileExists "$DC_BackupSource\Deploy Center.exe" 0 DC_NoPreviousProgram
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
  StrCpy $DC_BackupId $0
  StrCpy $DC_Rollback "$DC_InstallerBackups\$DC_BackupId"
  CreateDirectory "$DC_Rollback"
  ClearErrors
  CopyFiles /SILENT "$DC_BackupSource\*.*" "$DC_Rollback"
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
    ; 仅标记本次成功升级的备份。应用启动后在后台清理，保留未确认的备份。
    Rename "$DC_Rollback" "$DC_InstallerBackups\completed-$DC_BackupId"
  ${EndIf}
FunctionEnd

Function DC_WithdrawProgram
  ${If} $DC_PreviousDir != ""
    ; 旧卸载器需要搬走 app.asar。先检查删除共享权限，避免被其他进程占用时先删掉入口。
    StrCpy $0 "$DC_PreviousDir\resources\app.asar"
    ${If} ${FileExists} "$0"
      System::Call 'kernel32::CreateFileW(w r0, i 0x10000, i 7, p0, i 3, i 0x80, p0)p.r1'
      ${If} $1 == -1
        Push "旧版程序文件正被占用或无法修改。请关闭占用该文件的程序后重试：$0"
        Call DC_AbortProgramInstall
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r1)'
    ${EndIf}
  ${EndIf}
  !insertmacro DC_InstallStage 1 "正在准备安装；覆盖升级时备份旧版程序"
  Call DC_BackupOldProgram
  ${If} $DC_Rollback == ""
    Return
  ${EndIf}
  !insertmacro customCheckAppRunning
  ; 备份完成后先移除旧快捷方式的启动目标，避免卸载过程中启动半套程序。
  ClearErrors
  Delete "$DC_BackupSource\$DC_OldExecutable"
  ${If} ${Errors}
    Push "无法关闭旧版程序入口"
    Call DC_AbortProgramInstall
  ${EndIf}
  StrCpy $DC_ProgramWithdrawn "1"
FunctionEnd

Function DC_AbortProgramInstall
  Pop $0
  StrCpy $DC_InstallError $0
  DetailPrint "$0"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileSeek $DC_Log 0 END
  FileWrite $DC_Log "$0$\r$\n"
  FileClose $DC_Log
  SetErrorLevel 1603
  Abort
FunctionEnd

Function DC_PublishProgram
  ; EXE 的版本号不能证明应用归档和依赖已经可读。静默安装返回前实际加载启动依赖，
  ; 让已有更新助手也只在完整程序可用后重启。Node 模式不会打开窗口或读取用户数据。
  File /oname=$PLUGINSDIR\dc-verify.cjs "${PROJECT_DIR}\installer\verify-installed.cjs"
  ReadEnvStr $2 "ELECTRON_RUN_AS_NODE"
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
  StrCpy $3 0
  ${Do}
    nsExec::ExecToStack /TIMEOUT=15000 '"$INSTDIR\${DC_PENDING_EXE}" "$PLUGINSDIR\dc-verify.cjs" "${VERSION}"'
    Pop $0
    Pop $1
    ${If} $0 == "0"
    ${AndIf} $1 == "YOTOO_PROGRAM_READY"
      ${ExitDo}
    ${EndIf}
    ; 新写入的文件可能暂时被系统扫描。每次重试期间仍关闭对外入口。
    IntOp $3 $3 + 1
    ${If} $3 < 3
    ${AndIf} $0 != "timeout"
      Sleep 500
    ${Else}
      ${ExitDo}
    ${EndIf}
  ${Loop}
  ${If} $2 == ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w r2)'
  ${EndIf}
  ${If} $0 != "0"
  ${OrIf} $1 != "YOTOO_PROGRAM_READY"
    Push "程序依赖检查失败：$0 $1"
    Call DC_AbortProgramInstall
  ${EndIf}
  StrCpy $3 0
  ${Do}
    ClearErrors
    Rename "$INSTDIR\${DC_PENDING_EXE}" "$appExe"
    ${IfNot} ${Errors}
      Return
    ${EndIf}
    IntOp $3 $3 + 1
    ${If} $3 < 3
      Sleep 500
    ${EndIf}
  ${LoopWhile} $3 < 3
  Push "无法启用主程序入口"
  Call DC_AbortProgramInstall
FunctionEnd
!endif
!macroend

!macro customPageAfterChangeDir
  Page custom DC_OptionsCreate DC_OptionsLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_ShowInstallProgress
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE DC_CloseInstallProgress
!macroend

!macro customUnInstallCheck
  ; 已关闭旧入口后，卸载失败也要走安装失败回调，恢复备份里的旧程序。
  ${If} $R0 != 0
    Push "卸载旧程序失败，退出码：$R0"
    Call DC_AbortProgramInstall
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /oname=deploy-center.ico "${PROJECT_DIR}\assets\icon.ico"
  ; 先写独立快捷方式，再替换旧文件，避免 Windows 继续解析已有快捷方式的坏目标。
  !insertmacro DC_ReplaceShortcut "$newStartMenuLink"
  ${If} $DC_DesktopChoice == ${BST_UNCHECKED}
    Delete "$newDesktopLink"
  ${Else}
    !insertmacro DC_ReplaceShortcut "$newDesktopLink"
  ${EndIf}
  CreateDirectory "$DC_InstallerLogs"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileWrite $DC_Log "安装成功 ${VERSION}，目录：$INSTDIR$\r$\n"
  FileClose $DC_Log
  !insertmacro DC_InstallStage 4 "程序文件与快捷方式已安装完成"
!macroend

!macro DC_ReplaceShortcut LINK
  StrCpy $4 "${LINK}"
  StrCpy $7 0
  ${GetParent} "$4" $5
  CreateDirectory "$5"
  ClearErrors
  GetTempFileName $6 "$5"
  ${IfNot} ${Errors}
    Delete "$6"
    StrCpy $6 "$6.lnk"
    ClearErrors
    CreateShortCut "$6" "$appExe" "" "$INSTDIR\deploy-center.ico" 0 "" "" "${APP_DESCRIPTION}"
    ${IfNot} ${Errors}
      WinShell::SetLnkAUMI "$6" "${APP_ID}"
      System::Call 'kernel32::MoveFileExW(w r6, w r4, i 9)i.r7'
    ${EndIf}
    ${If} $7 == 0
      Delete "$6"
    ${EndIf}
  ${EndIf}
  ${If} $7 == 0
    Push "无法创建 Windows 快捷方式：$4"
    Call DC_AbortProgramInstall
  ${EndIf}
  ; 通知 Explorer 更新这个入口，避免清理全局图标缓存。
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 5, w r4, p0)'
!macroend

; 卸载组件页默认不勾选数据清理。升级时即使被传入该选项，也不执行删除。
!macro customUnInit
  Call un.DC_SetDataPaths
  Call un.DC_ParsePurgeOptions
!macroend

!macro customUnInstallSection
  !insertmacro DC_DataCleanupFunctions "un."
  Section /o "un.彻底清理当前用户的配置、部署历史和日志（可选）" DC_PurgeData
    ${IfNot} ${isUpdated}
      StrCpy $DC_PurgeError ""
      StrCpy $DC_DataActive "$DC_DataRoot"
      StrCpy $DC_DataPending ""
      StrCpy $DC_DataPrevious ""
      IfFileExists "$DC_ControlDirectory\data-location.ini" DC_PurgeReadIni 0
      IfFileExists "$DC_ControlDirectory\data-location.json" 0 DC_PurgeReadDone
      StrCpy $DC_PurgeError "数据位置记录不完整，所有用户数据及位置记录已保留。"
      Goto DC_PurgeReadDone
      DC_PurgeReadIni:
      ReadINIStr $DC_DataActive "$DC_ControlDirectory\data-location.ini" "location" "active"
      ReadINIStr $DC_DataPending "$DC_ControlDirectory\data-location.ini" "location" "pending"
      ReadINIStr $DC_DataPrevious "$DC_ControlDirectory\data-location.ini" "location" "previous"
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
      ${If} $DC_ControlDirectory == "$LOCALAPPDATA\DeployCenter\Settings"
        Push $DC_ControlDirectory
        Call un.DC_ValidateDataRoot
      ${EndIf}
      ${If} $DC_PurgeError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$DC_PurgeError$\r$\n程序卸载继续，未清理用户数据。" /SD IDOK
        Goto DC_PurgeDone
      ${EndIf}
      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "将永久删除以下数据目录中的配置、历史、凭据、日志及本地产物：$\r$\n当前：$DC_DataActive$\r$\n待切换：$DC_DataPending$\r$\n旧副本：$DC_DataPrevious$\r$\n位置记录：$DC_ControlDirectory$\r$\n$\r$\n服务器文件不受影响。确定彻底清理吗？" /SD IDNO IDYES +2
        Goto DC_PurgeDone
      ${EndIf}
      Push $DC_DataActive
      Call un.DC_RemoveDataRoot
      Push $DC_DataPending
      Call un.DC_RemoveDataRoot
      Push $DC_DataPrevious
      Call un.DC_RemoveDataRoot
      ${If} $DC_ControlDirectory == "$LOCALAPPDATA\DeployCenter\Settings"
        Push $DC_ControlDirectory
        Call un.DC_RemoveDataRoot
      ${EndIf}
      ${If} $DC_PurgeError == ""
        DeleteRegValue HKCU "${YOTOO_LOCATION_KEY}" "DataDirectory"
      ${EndIf}
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

; 解压及写入程序文件已经完成后，进入系统注册和快捷方式阶段。
!macro customFiles_x64
  !insertmacro DC_InstallStage 3 "正在注册程序并创建快捷方式"
!macroend
!macro customFiles_ia32
  !insertmacro DC_InstallStage 3 "正在注册程序并创建快捷方式"
!macroend
!macro customFiles_arm64
  !insertmacro DC_InstallStage 3 "正在注册程序并创建快捷方式"
!macroend
