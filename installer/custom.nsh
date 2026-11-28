!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include Sections.nsh
!define DC_ELECTRON_UI
!include "${PROJECT_DIR}\installer\electron-wizard.nsh"
!include "${PROJECT_DIR}\installer\progress.nsh"
!include "${PROJECT_DIR}\installer\data-cleanup.nsh"
!include "${PROJECT_DIR}\installer\data-paths.nsh"
!ifdef BUILD_UNINSTALLER
!include "${PROJECT_DIR}\installer\wizard-style.nsh"
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.DC_InitializeWizardStyle
Var DC_DataActive
Var DC_DataPending
Var DC_DataPrevious
Var DC_UninstallPurge
Var DC_UninstallCloseState
Var DC_ConfirmedDataActive
Var DC_ConfirmedDataPending
Var DC_ConfirmedDataPrevious
!endif

; 原生控件沿用安装器原型的底色和排版，窗口由 Windows 负责标题栏与缩放。
!define MUI_BGCOLOR "FFFFFF"
!define DC_BRAND_INK "18181B"
!define DC_BRAND_MUTED "52525B"
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
!define MUI_CUSTOMFUNCTION_GUIINIT DC_InitializeWizardStyle
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
Var DC_PreviousVersion
Var DC_InstallMode
Var DC_DowngradeConfirm
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
Var DC_ProgramPublished
Var DC_ProgramDestination
Var DC_FreshStage
Var DC_InstallError
Var DC_RecoveryNote
Var DC_PathError
!define DC_PENDING_EXE ".deploy-center-installing.exe"
!endif

!macro DC_CopyProgramTree SOURCE DEST EXCLUDE
  nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\robocopy.exe" "${SOURCE}" "${DEST}" /E /XJ /SL /COPY:DAT /DCOPY:DAT /IS /IT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP ${EXCLUDE}'
  Pop $0
  Pop $1
  ClearErrors
  ; Robocopy 的 0 至 7 均表示未遇到复制失败。插件也可能返回字符串。
  ${If} $0 == "error"
  ${OrIf} $0 == "timeout"
  ${OrIf} $0 >= 8
    SetErrors
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE DC_SkipWelcomeForFailureBack
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_BrandWelcome
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE DC_LeaveWelcome
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro preInit
!ifndef BUILD_UNINSTALLER
  ; 用户在失败页主动重试时，新实例等旧实例释放框架的安装锁。
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/YOTOORETRYFROM=" $1
  ${IfNot} ${Errors}
    System::Call 'kernel32::OpenProcess(i0x100000,i0,ir1)p.r2'
    ${If} $2 != 0
      System::Call 'kernel32::WaitForSingleObject(pr2,i15000)i.r3'
      System::Call 'kernel32::CloseHandle(pr2)'
      ${If} $3 != 0
        SetErrorLevel 1618
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!endif
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
  ${Do}
    !insertmacro DC_CheckRunning $0
    ${If} $0 != 0
      ${ExitDo}
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      ${If} $DC_WizardProcess != 0
      ${AndIf} $DC_WizardProcess != ""
        Push "YOTOO 部署中心正在运行，请正常退出后重试。"
        Call DC_AbortProgramInstall
      ${EndIf}
    !else
      ${If} $DC_WizardProcess != 0
      ${AndIf} $DC_WizardProcess != ""
        Call un.DC_EndElectronUninstallFailure
        SetErrorLevel 1602
        Quit
      ${EndIf}
    !endif
    ${IfNot} ${Silent}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "YOTOO 部署中心仍在运行。$\r$\n请等待部署任务结束，从系统托盘正常退出应用，然后点击「重试」重新检查。" /SD IDCANCEL IDCANCEL +2
      ${Continue}
    ${EndIf}
    SetErrorLevel 1602
    Quit
  ${Loop}
!macroend

!macro customInit
  ${If} ${Silent}
    !insertmacro customCheckAppRunning
  ${EndIf}
  Call DC_SetDataPaths
  ${IfNot} ${Silent}
    !insertmacro DC_LoadBrandIcon
  ${EndIf}
  Call DC_ReadPreviousDirectory
  Call DC_ClassifyInstall
  ${If} $DC_InstallMode != "fresh"
    StrCpy $DC_ProgressHasPrevious 1
  ${EndIf}
  StrCpy $DC_WizardDir $INSTDIR
  !ifdef APP_64_UNPACKED_SIZE
    IntOp $DC_RequiredMB ${APP_64_UNPACKED_SIZE} / 1024
    IntOp $DC_RequiredMB $DC_RequiredMB * 2
    IntOp $DC_RequiredMB $DC_RequiredMB + 100
  !else
    StrCpy $DC_RequiredMB 1024
  !endif
  StrCpy $DC_DesktopChoice ${BST_CHECKED}
  ${If} $DC_InstallMode != "fresh"
  ${AndIf} $INSTDIR == $DC_PreviousDir
    ; 兼容品牌改名前创建的桌面快捷方式，判断用户原先是否保留了它。
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName
    ${If} $0 == ""
      StrCpy $0 "Deploy Center"
    ${EndIf}
    ${IfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${AndIfNot} ${FileExists} "$DESKTOP\$0.lnk"
      StrCpy $DC_DesktopChoice ${BST_UNCHECKED}
    ${EndIf}
  ${EndIf}
  ${If} ${Silent}
    ; 静默调用无法确认降级风险，避免旧版打开可能不兼容的用户数据。
    ${If} $DC_InstallMode == "downgrade"
      SetErrorLevel 1603
      Abort
    ${EndIf}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/YOTOOUPDATE" $1
    ${IfNot} ${Errors}
      ${If} $DC_PreviousDir == ""
      ${OrIf} $INSTDIR != $DC_PreviousDir
        SetErrorLevel 1603
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
  CreateDirectory "$DC_InstallerLogs"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileWrite $DC_Log "开始安装 ${VERSION}，目录：$INSTDIR$\r$\n"
  FileClose $DC_Log
  ${If} ${Silent}
    !insertmacro customCheckAppRunning
    Call DC_ValidateDirectory
    StrCpy $DC_ChosenDir $INSTDIR
  ${Else}
    Call DC_StartElectronInstall
  ${EndIf}
!macroend

!macro DC_InstallClassification
Function DC_ClassifyInstall
  StrCpy $DC_InstallMode "fresh"
  StrCpy $DC_PreviousVersion ""
  ${If} $DC_PreviousDir == ""
    Return
  ${EndIf}
  ; 内部安装记录可信时也允许修复损坏或缺少 app.asar 的安装。
  IfFileExists "$DC_PreviousDir\${APP_EXECUTABLE_FILENAME}" dc_installed_program 0
  IfFileExists "$DC_PreviousDir\Deploy Center.exe" dc_installed_program 0
  ; 注册信息残留时当作首装，显式 /D 仍由原有目录校验处理。
  StrCpy $DC_PreviousDir ""
  Return
  dc_installed_program:
  StrCpy $DC_InstallMode "existing"
  ReadRegStr $DC_PreviousVersion HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  StrCpy $0 $DC_PreviousVersion 1
  ${If} $0 == "v"
    StrCpy $DC_PreviousVersion $DC_PreviousVersion "" 1
  ${EndIf}
  StrLen $1 $DC_PreviousVersion
  System::Call 'shlwapi::StrSpnW(w "$DC_PreviousVersion",w "0123456789.")i.r0'
  ${If} $1 == 0
  ${OrIf} $1 != $0
    StrCpy $DC_PreviousVersion ""
    Return
  ${EndIf}
  ${VersionCompare} "$DC_PreviousVersion" "${VERSION}" $0
  ${If} $0 == 0
    StrCpy $DC_InstallMode "repair"
  ${ElseIf} $0 == 1
    StrCpy $DC_InstallMode "downgrade"
  ${Else}
    StrCpy $DC_InstallMode "upgrade"
  ${EndIf}
FunctionEnd
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
  !insertmacro DC_WizardColors $0 "${COLOR}" "${MUI_BGCOLOR}" "E4E4E7" "1C1C1E"
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
!macroend

!macro DC_WelcomeLabel X Y W H TEXT FONT COLOR
  ${NSD_CreateLabel} ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop $0
  !insertmacro DC_WizardColors $0 "${COLOR}" "${MUI_BGCOLOR}" "E4E4E7" "1C1C1E"
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
!macroend

!macro DC_FinishBadge FONT
  ${If} $DC_WizardDark == -1
    !insertmacro DC_CenteredLabel 42u 26u "✓" ${FONT} "007634"
  ${Else}
    !insertmacro DC_WizardScale $1 54
    IntOp $2 $DC_WizardWidth - $1
    IntOp $2 $2 / 2
    nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_CENTER}|${SS_CENTERIMAGE} 0 $2 42u $1 $1 "✓"
    Pop $0
    !insertmacro DC_WizardColors $0 "007634" "E8F7EE" "4ADE80" "0F2B1A"
    SendMessage $0 ${WM_SETFONT} ${FONT} 1
    ; SetWindowRgn 成功后由窗口接管随 DPI 缩放的区域句柄。
    System::Call 'gdi32::CreateEllipticRgn(i0,i0,ir1,ir1)p.r3'
    System::Call 'user32::SetWindowRgn(pr0,pr3,i1)i.r4'
    ${If} $4 == 0
      System::Call 'gdi32::DeleteObject(pr3)'
    ${EndIf}
  ${EndIf}
!macroend

!macro DC_WizardVisuals
Function DC_InitFonts
  ${If} $DC_FontTitle == ""
    CreateFont $DC_FontTitle "Microsoft YaHei" 15 600
    CreateFont $DC_FontSmall "Microsoft YaHei" 9 400
    CreateFont $DC_FontCheck "Segoe UI Symbol" 19 600
  ${EndIf}
FunctionEnd

Function DC_SkipWelcomeForFailureBack
  ${If} $DC_InstallMode == "fresh"
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/YOTOOFAILUREBACK" $1
    ${IfNot} ${Errors}
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function DC_BrandWelcome
  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:YOTOO 部署中心 安装程序"
  Call DC_StyleWizardFrame
  !insertmacro DC_WizardPage $mui.WelcomePage
  ShowWindow $mui.WelcomePage.Image ${SW_HIDE}
  ShowWindow $mui.WelcomePage.Title ${SW_HIDE}
  ShowWindow $mui.WelcomePage.Text ${SW_HIDE}
  Call DC_InitFonts
  ; 标题和图标按本机对话框单位与 DPI 布局。
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.r0'
  IntOp $1 $0 * 40
  IntOp $1 $1 / 96
  ${NSD_CreateIcon} 12u 13u $1 $1 ""
  Pop $3
  ${If} $DC_LogoHandle == ""
    System::Call 'user32::LoadImageW(p0,w "$PLUGINSDIR\dc-brand.ico",i1,ir1,ir1,i0x10)p.r2'
    StrCpy $DC_LogoHandle $2
  ${EndIf}
  SendMessage $3 ${STM_SETIMAGE} ${IMAGE_ICON} $DC_LogoHandle
  !insertmacro DC_WizardColors $3 "" "FFFFFF" "" "1C1C1E"
  StrCpy $R1 "${DC_WELCOME_TITLE}"
  StrCpy $R2 ""
  StrCpy $R3 ""
  ${Switch} $DC_InstallMode
    ${Case} "upgrade"
      StrCpy $R1 "升级 YOTOO 部署中心"
      StrCpy $R2 "检测到已安装 v$DC_PreviousVersion，将升级到 v${VERSION}。"
      StrCpy $R3 "配置、部署历史和日志会保留。安装位置和快捷方式不变。"
      ${Break}
    ${Case} "repair"
      StrCpy $R1 "修复安装 YOTOO 部署中心"
      StrCpy $R2 "当前已安装同一版本，将重新安装程序文件。"
      StrCpy $R3 "配置、部署历史和日志会保留。安装位置和快捷方式不变。"
      ${Break}
    ${Case} "downgrade"
      StrCpy $R1 "降级安装 YOTOO 部署中心"
      StrCpy $R2 "将从 v$DC_PreviousVersion 降级到 v${VERSION}。"
      StrCpy $R3 "旧版可能无法读取新版本写入的数据。现有数据会保留。"
      ${Break}
    ${Case} "existing"
      StrCpy $R1 "覆盖安装 YOTOO 部署中心"
      StrCpy $R2 "检测到已安装程序，无法确认现有版本。"
      StrCpy $R3 "配置、部署历史和日志会保留。"
      ${Break}
  ${EndSwitch}
  !insertmacro DC_WelcomeLabel 41u 12u 238u 16u "$R1" $DC_FontTitle "${DC_BRAND_INK}"
  ${If} $DC_InstallMode == "fresh"
    !insertmacro DC_WelcomeLabel 41u 25u 238u 12u "v${VERSION} · Windows x64 · 全新安装" $DC_FontSmall "${DC_BRAND_MUTED}"
    !insertmacro DC_WelcomeLabel 12u 39u 278u 26u "在本机管理 Java 服务的构建、部署与回滚。安装过程不会改动已有用户数据。" $DC_FontSmall "${DC_BRAND_MUTED}"
    !insertmacro DC_WelcomeLabel 12u 72u 278u 16u "可选择安装位置 · 为当前用户安装" $DC_FontSmall "${DC_BRAND_MUTED}"
    !insertmacro DC_WizardColors $0 "52525B" "EFEFF2" "ABABB3" "26262A"
  ${Else}
    !insertmacro DC_WelcomeLabel 41u 25u 238u 12u "Windows x64" $DC_FontSmall "${DC_BRAND_MUTED}"
    ${If} $DC_InstallMode != "downgrade"
      !insertmacro DC_WelcomeLabel 12u 39u 278u 16u "本向导会先备份当前版本，再替换程序文件。" $DC_FontSmall "${DC_BRAND_MUTED}"
    ${EndIf}
    !insertmacro DC_WelcomeLabel 12u 57u 278u 29u "$R2$\r$\n$R3" $DC_FontSmall "${DC_BRAND_INK}"
    ${If} $DC_InstallMode == "downgrade"
      !insertmacro DC_WizardColors $0 "991B1B" "FEE2E2" "FCA5A5" "3A1414"
    ${Else}
      !insertmacro DC_WizardColors $0 "18181B" "EFEFF2" "E4E4E7" "26262A"
    ${EndIf}
    !insertmacro DC_WelcomeLabel 12u 92u 278u 19u "安装目录：$DC_WizardDir" $DC_FontSmall "${DC_BRAND_MUTED}"
    !insertmacro DC_WizardColors $0 "52525B" "EFEFF2" "ABABB3" "26262A"
  ${EndIf}
  ${If} $DC_InstallMode == "downgrade"
    ${NSD_CreateCheckbox} 12u 115u 278u 16u "我了解降级的影响，仍然继续。"
    Pop $DC_DowngradeConfirm
    ${If} $DC_WizardDark == 1
      System::Call 'uxtheme::SetWindowTheme(p $DC_DowngradeConfirm,w "",w "")'
    ${EndIf}
    !insertmacro DC_WizardColors $DC_DowngradeConfirm "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
    ${NSD_OnClick} $DC_DowngradeConfirm DC_UpdateDowngradeConfirm
    Push $DC_DowngradeConfirm
    Call DC_UpdateDowngradeConfirm
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:下一步"
  Call DC_StyleWizardPrimary
FunctionEnd

Function DC_UpdateDowngradeConfirm
  Pop $0
  ${NSD_GetState} $0 $1
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 $1
  Call DC_StyleWizardPrimary
FunctionEnd

Function DC_LeaveWelcome
  ${If} $DC_InstallMode == "downgrade"
    ${NSD_GetState} $DC_DowngradeConfirm $0
    ${If} $0 != ${BST_CHECKED}
      Abort
    ${EndIf}
  ${EndIf}
  ${If} $DC_InstallMode != "fresh"
  ${AndIf} $DC_WizardDir == $DC_PreviousDir
    StrCpy $INSTDIR $DC_WizardDir
    Call DC_ValidateDirectory
    StrCpy $DC_ChosenDir $INSTDIR
  ${EndIf}
FunctionEnd

Function DC_BrandFinish
  ; 重启提示页仍由 MUI 处理。
  ${If} $mui.FinishPage.Run == ""
    Return
  ${EndIf}
  Call DC_StyleWizardFrame
  !insertmacro DC_WizardPage $mui.FinishPage
  !insertmacro DC_WizardHide 2
  !insertmacro DC_WizardHide 3
  ShowWindow $mui.FinishPage.Image ${SW_HIDE}
  ShowWindow $mui.FinishPage.Title ${SW_HIDE}
  ShowWindow $mui.FinishPage.Text ${SW_HIDE}
  ShowWindow $mui.FinishPage.Run ${SW_HIDE}
  Call DC_InitFonts
  StrCpy $R1 "安装完成"
  StrCpy $R2 "YOTOO 部署中心 v${VERSION} 已安装。"
  ${Switch} $DC_InstallMode
    ${Case} "upgrade"
      StrCpy $R1 "升级完成"
      StrCpy $R2 "已从 v$DC_PreviousVersion 升级到 v${VERSION}。"
      ${Break}
    ${Case} "repair"
      StrCpy $R1 "修复安装完成"
      StrCpy $R2 "已重新安装 v${VERSION}。"
      ${Break}
    ${Case} "downgrade"
      StrCpy $R1 "降级完成"
      StrCpy $R2 "已从 v$DC_PreviousVersion 降级到 v${VERSION}。"
      ${Break}
  ${EndSwitch}
  !insertmacro DC_FinishBadge $DC_FontCheck
  !insertmacro DC_CenteredLabel 73u 14u "$R1" $DC_FontTitle "${DC_BRAND_INK}"
  !insertmacro DC_CenteredLabel 87u 12u "$R2 配置、部署历史和日志已保留。" $DC_FontSmall "${DC_BRAND_MUTED}"
  !insertmacro DC_WizardColors $0 "52525B" "FFFFFF" "ABABB3" "1C1C1E"
  ${NSD_CreateCheckbox} 104u 100u 150u 16u "立即打开 YOTOO 部署中心"
  Pop $mui.FinishPage.Run
  ${If} $DC_WizardDark == 1
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run,w "",w "")'
  ${EndIf}
  !insertmacro DC_WizardColors $mui.FinishPage.Run "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
  ${NSD_SetState} $mui.FinishPage.Run ${BST_CHECKED}
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  Call DC_StyleWizardPrimary
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
  !insertmacro DC_ElectronWizardFunctions ""
  !insertmacro DC_WizardStyleFunctions ""
  !insertmacro DC_ProgressFunctions
!else
  !insertmacro DC_ElectronWizardFunctions "un."
  !insertmacro DC_WizardStyleFunctions "un."
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
!insertmacro DC_InstallClassification

Function DC_StageElectronRuntime
  ${If} $DC_ElectronReady == 1
    Return
  ${EndIf}
  InitPluginsDir
  !ifdef COMPRESS
    SetCompress off
  !endif
  File /oname=$PLUGINSDIR\electron.7z "$%YOTOO_INSTALLER_RUNTIME_ARCHIVE%"
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif
  SetOutPath "$PLUGINSDIR\7z-out"
  Nsis7z::Extract "$PLUGINSDIR\electron.7z"
  SetOutPath "$PLUGINSDIR"
  Delete "$PLUGINSDIR\electron.7z"
  IfFileExists "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}" 0 +2
  StrCpy $DC_ElectronReady 1
FunctionEnd

Function DC_StartElectronInstall
  Call DC_StageElectronRuntime
  ${If} $DC_ElectronReady != 1
    MessageBox MB_OK|MB_ICONSTOP "无法解压安装向导。请检查安装包和临时目录可用空间。" /SD IDOK
    SetErrorLevel 1603
    Quit
  ${EndIf}
  StrCpy $R0 0
  ${If} $DC_InstallMode == "fresh"
  ${OrIf} $DC_WizardDir != $DC_PreviousDir
    StrCpy $R0 1
  ${EndIf}
  StrCpy $R1 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/YOTOOFAILUREBACK" $1
  ${IfNot} ${Errors}
  ${AndIf} $DC_InstallMode == "fresh"
    StrCpy $R1 1
  ${EndIf}
  !insertmacro DC_OpenElectronWizard "" "$DC_InstallMode" "$DC_PreviousVersion" "$DC_WizardDir" "$DC_RequiredMB" "$DC_DesktopChoice" "$R0" "$R1" "$DC_InstallerLogs"
  ${If} $DC_WizardProcess == 0
    MessageBox MB_OK|MB_ICONSTOP "无法启动安装向导。请检查临时目录写入权限后重试。" /SD IDOK
    SetErrorLevel 1603
    Quit
  ${EndIf}
  ${Do}
    Call DC_WaitWizardCommand
    ${If} $DC_WizardAction == "cancel"
      Call DC_CloseWizardProcess
      SetErrorLevel 1602
      Quit
    ${EndIf}
    ${If} $DC_WizardAction != "start"
      ${Continue}
    ${EndIf}
    ${If} $DC_InstallMode == "downgrade"
    ${AndIf} $DC_WizardDowngrade != 1
      !insertmacro DC_WriteWizardStatus "invalid" "0" "继续前请确认降级风险。" "" "0"
      ${Continue}
    ${EndIf}
    !insertmacro DC_CheckRunning $0
    ${If} $0 == 0
      !insertmacro DC_WriteWizardStatus "running-check" "0" "" "" "0"
      ${Continue}
    ${EndIf}
    StrCpy $INSTDIR $DC_WizardValue
    Call DC_CheckDirectory
    ${If} $DC_PathError != ""
      !insertmacro DC_WriteWizardStatus "invalid" "0" "$DC_PathError" "" "0"
      ${Continue}
    ${EndIf}
    StrCpy $DC_ChosenDir $INSTDIR
    ${If} $DC_InstallMode == "fresh"
    ${OrIf} $INSTDIR != $DC_PreviousDir
      StrCpy $DC_DesktopChoice $DC_WizardDesktop
    ${EndIf}
    ${ExitDo}
  ${Loop}
  ; 交互步骤已由 Electron 处理，安装段沿用 NSIS 的静默执行路径。
  SetSilent silent
  SetOutPath "$INSTDIR"
  !insertmacro DC_InstallStage 1 "正在检查安装条件"
FunctionEnd

Function DC_CheckDirectory
  StrCpy $DC_PathError ""
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
  StrCpy $DC_PathError $0
FunctionEnd

Function DC_ValidateDirectory
  Call DC_CheckDirectory
  ${If} $DC_PathError != ""
    MessageBox MB_OK|MB_ICONSTOP "$DC_PathError$\r$\n$INSTDIR" /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
FunctionEnd

Function DC_RefreshSpace
  Pop $0
  ${NSD_GetText} $DC_PathInput $1
  StrCpy $DC_WizardDir $1
  StrCpy $2 $1 3
  System::Call 'kernel32::GetDiskFreeSpaceExW(w r2,*l .r3,p0,p0)i.r4'
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  ${If} $4 != 0
    System::Int64Op $3 / 1048576
    Pop $3
    StrCpy $2 $2 2
    StrCpy $5 "$3 MB"
    ${If} $3 >= 1024
      IntOp $5 $3 / 1024
      IntOp $6 $3 % 1024
      IntOp $6 $6 * 10
      IntOp $6 $6 / 1024
      StrCpy $5 "$5.$6 GB"
    ${EndIf}
    ${If} $3 < $DC_RequiredMB
      ${NSD_SetText} $DC_SpaceLabel "需要 $DC_RequiredMB MB · $2 盘可用 $5 · 空间不足"
      EnableWindow $0 0
    ${Else}
      ${NSD_SetText} $DC_SpaceLabel "需要 $DC_RequiredMB MB · $2 盘可用 $5"
    ${EndIf}
  ${Else}
    ${NSD_SetText} $DC_SpaceLabel "需要 $DC_RequiredMB MB · 安装前检查可用空间"
  ${EndIf}
  Call DC_StyleWizardPrimary
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

Function DC_SaveDesktopChoice
  Pop $0
  ${NSD_GetState} $0 $DC_DesktopChoice
FunctionEnd

Function DC_OptionsCreate
  ${If} $DC_InstallMode != "fresh"
  ${AndIf} $DC_WizardDir == $DC_PreviousDir
    ; 显式指定其他目录时保留位置页和既有校验。
    StrCpy $INSTDIR $DC_WizardDir
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "选择安装位置" "程序文件和用户数据存放在不同目录"
  nsDialogs::Create 1018
  Pop $DC_Dialog
  ${If} $DC_Dialog == error
    Abort
  ${EndIf}
  Call DC_StyleWizardFrame
  !insertmacro DC_WizardPage $DC_Dialog
  Call DC_InitFonts
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装"
  !insertmacro DC_WelcomeLabel 12u 12u 278u 15u "选择安装位置" $DC_FontTitle "${DC_BRAND_INK}"
  !insertmacro DC_WelcomeLabel 12u 25u 278u 14u "程序文件和用户数据存放在不同目录。" $DC_FontSmall "${DC_BRAND_MUTED}"
  !insertmacro DC_WelcomeLabel 12u 42u 278u 12u "安装目录" $DC_FontSmall "${DC_BRAND_INK}"
  ; 交互式安装模式页即使跳过，也会重算 $INSTDIR。使用向导自己的路径，并保留用户编辑。
  ${NSD_CreateDirRequest} 12u 53u 244u 15u "$DC_WizardDir"
  Pop $DC_PathInput
  !insertmacro DC_WizardColors $DC_PathInput "18181B" "FFFFFF" "E4E4E7" "26262A"
  ${NSD_CreateBrowseButton} 260u 53u 32u 15u "浏览"
  Pop $0
  ${NSD_OnClick} $0 DC_BrowseDirectory
  ${NSD_CreateLabel} 12u 71u 278u 14u ""
  Pop $DC_SpaceLabel
  !insertmacro DC_WizardColors $DC_SpaceLabel "52525B" "FFFFFF" "ABABB3" "1C1C1E"
  ${NSD_OnChange} $DC_PathInput DC_RefreshSpace
  Push $DC_PathInput
  Call DC_RefreshSpace
  ${NSD_CreateCheckbox} 12u 83u 278u 14u "创建桌面快捷方式"
  Pop $DC_Checkbox
  ${If} $DC_WizardDark == 1
    System::Call 'uxtheme::SetWindowTheme(p $DC_Checkbox,w "",w "")'
  ${EndIf}
  !insertmacro DC_WizardColors $DC_Checkbox "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
  ${NSD_SetState} $DC_Checkbox $DC_DesktopChoice
  ${NSD_OnClick} $DC_Checkbox DC_SaveDesktopChoice
  !insertmacro DC_WelcomeLabel 26u 95u 266u 14u "开始菜单入口会自动创建。" $DC_FontSmall "${DC_BRAND_MUTED}"
  ${NSD_CreateLabel} 12u 109u 278u 24u "配置、部署历史和日志保存在独立的数据目录，安装时会保留。"
  Pop $0
  !insertmacro DC_WizardColors $0 "52525B" "FFFFFF" "ABABB3" "1C1C1E"
  nsDialogs::Show
FunctionEnd

Function DC_OptionsLeave
  ${NSD_GetState} $DC_Checkbox $DC_DesktopChoice
  ${NSD_GetText} $DC_PathInput $INSTDIR
  Call DC_ValidateDirectory
  StrCpy $DC_ChosenDir $INSTDIR
FunctionEnd

Function DC_RecoverFailedInstall
  StrCpy $DC_RecoveryNote "安装流程已停止。"
  ${If} $DC_ProgramPublished == "1"
  ${AndIf} $DC_InstallMode != "fresh"
    Delete "$appExe"
  ${EndIf}
  ${If} $DC_FreshStage != ""
    ; 首装失败只清理本次创建的暂存目录，用户选择的目录可能已被其他程序写入。
    SetOutPath "$PLUGINSDIR"
    RMDir /r "$DC_FreshStage"
    ${If} ${FileExists} "$DC_FreshStage\*"
      StrCpy $DC_RecoveryNote "本次安装暂存文件未能移除，请查看日志。原安装目录仍可重试。"
      StrCpy $DC_InstallError "$DC_InstallError$\r$\n安装暂存文件保留在：$DC_FreshStage"
    ${EndIf}
  ${ElseIf} $DC_InstallMode == "fresh"
  ${AndIf} $DC_ProgramPublished == "1"
    ; 文件已经完整发布，由后续同版本修复补齐失败的系统集成。
    StrCpy $DC_RecoveryNote "程序文件已写入，可重试修复未完成的安装。"
  ${EndIf}
  ${If} $DC_ProgramWithdrawn == "1"
    CreateDirectory "$DC_BackupSource"
    ; 不改动备份内的文件名。先补齐依赖，再恢复快捷方式指向的 EXE。
    StrCpy $4 "$PLUGINSDIR\no-helper-exclusion"
    ${If} ${FileExists} "$DC_BackupSource\resources\update-helper.exe"
    ${AndIf} ${FileExists} "$DC_Rollback\resources\update-helper.exe"
      ${StdUtils.HashFile} $0 "SHA2-256" "$DC_BackupSource\resources\update-helper.exe"
      ${StdUtils.HashFile} $1 "SHA2-256" "$DC_Rollback\resources\update-helper.exe"
      StrLen $2 $0
      ${If} $2 == 64
      ${AndIf} $0 == $1
        ; 兼容从资源目录启动更新助手的旧版。校验原件与备份一致后跳过占用文件。
        StrCpy $4 "$DC_Rollback\resources\update-helper.exe"
      ${EndIf}
    ${EndIf}
    !insertmacro DC_CopyProgramTree "$DC_Rollback" "$DC_BackupSource" '/XF "$DC_OldExecutable" "${DC_PENDING_EXE}" "$4"'
    ${IfNot} ${Errors}
      System::Call 'kernel32::CopyFileW(w "$DC_Rollback\$DC_OldExecutable", w "$DC_BackupSource\${DC_PENDING_EXE}", i 0)i.r0'
      ${If} $0 == 0
        SetErrors
      ${Else}
        ClearErrors
        Rename "$DC_BackupSource\${DC_PENDING_EXE}" "$DC_BackupSource\$DC_OldExecutable"
      ${EndIf}
    ${EndIf}
    ${IfNot} ${Errors}
      StrCpy $DC_RecoveryNote "旧版程序文件和启动入口已恢复。"
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$DC_BackupSource"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName "$DC_OldName"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "$DC_OldVersion"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" Publisher "$DC_OldPublisher"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$DC_BackupSource"
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString '$\"$DC_BackupSource\$DC_OldUninstaller$\"'
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '$\"$DC_BackupSource\$DC_OldUninstaller$\" /S'
      WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayIcon "$DC_BackupSource\$DC_OldExecutable,0"
      WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoModify 1
      WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoRepair 1
      StrCpy $2 "$DC_BackupSource\deploy-center.ico"
      IfFileExists "$2" +2 0
      StrCpy $2 "$DC_BackupSource\$DC_OldExecutable"
      CreateShortCut "$SMPROGRAMS\$DC_OldShortcut.lnk" "$DC_BackupSource\$DC_OldExecutable" "" "$2" 0
      WinShell::SetLnkAUMI "$SMPROGRAMS\$DC_OldShortcut.lnk" "${APP_ID}"
      ${If} $DC_OldDesktop == 1
        CreateShortCut "$DESKTOP\$DC_OldShortcut.lnk" "$DC_BackupSource\$DC_OldExecutable" "" "$2" 0
        WinShell::SetLnkAUMI "$DESKTOP\$DC_OldShortcut.lnk" "${APP_ID}"
      ${EndIf}
    ${Else}
      StrCpy $DC_RecoveryNote "旧版未能自动恢复。备份已保留，请查看日志核实。"
      StrCpy $DC_InstallError "$DC_InstallError$\r$\n旧版未能自动恢复，完整备份保留在：$DC_Rollback"
    ${EndIf}
  ${ElseIf} $DC_InstallMode != "fresh"
    StrCpy $DC_RecoveryNote "旧版程序未被下线。"
  ${EndIf}
  CreateDirectory "$DC_InstallerLogs"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileSeek $DC_Log 0 END
  FileWrite $DC_Log "安装未完成，目录：$INSTDIR。请核对目录权限、空间和应用运行状态。$\r$\n"
  FileWrite $DC_Log "$DC_InstallError$\r$\n"
  FileClose $DC_Log
FunctionEnd

Function .onInstFailed
  Call DC_CloseInstallProgress
  Call DC_RecoverFailedInstall
  ${If} $DC_WizardProcess != 0
  ${AndIf} $DC_WizardProcess != ""
    StrCpy $0 "无法完成安装，请查看日志核对原因。"
    ${If} $DC_Stage == 2
      StrCpy $0 "无法解压程序文件，请检查安装包和可用空间。"
    ${ElseIf} $DC_Stage == 3
      StrCpy $0 "无法校验新版程序，请检查安装包和目录权限。"
    ${ElseIf} $DC_Stage == 4
      StrCpy $0 "无法备份当前版本，请检查可用空间和文件占用。"
    ${ElseIf} $DC_Stage == 5
      StrCpy $0 "无法写入程序文件或快捷方式。"
    ${EndIf}
    !insertmacro DC_WriteWizardStatus "failed" "0" "$0" "$DC_RecoveryNote" "0"
    Call DC_WaitWizardCommand
    Call DC_CloseWizardProcess
  ${EndIf}
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
  !insertmacro DC_InstallStage 4 "正在备份当前版本"
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
  !insertmacro DC_CopyProgramTree "$DC_BackupSource" "$DC_Rollback" '/XF "${DC_PENDING_EXE}"'
  ${If} ${Errors}
    StrCpy $DC_Rollback ""
    Push "无法备份旧版程序，已停止升级。请检查磁盘空间与目录权限。"
    Call DC_AbortProgramInstall
  ${EndIf}
  DC_NoPreviousProgram:
FunctionEnd

Function .onInstSuccess
  ${If} $DC_Rollback != ""
    ; 仅标记本次成功升级的备份。应用启动后在后台清理，保留未确认的备份。
    Rename "$DC_Rollback" "$DC_InstallerBackups\completed-$DC_BackupId"
  ${EndIf}
  ${If} $DC_WizardProcess != 0
  ${AndIf} $DC_WizardProcess != ""
    !insertmacro DC_WriteWizardStatus "done" "100" "" "" "0"
    Call DC_WaitWizardCommand
    Call DC_CloseWizardProcess
    ${If} $DC_WizardAction == "finish"
    ${AndIf} $DC_WizardValue == 1
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
  ${EndIf}
  SetErrorLevel 0
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

Function DC_VerifyPreparedProgram
  ; 从暂存目录加载启动依赖，校验失败时旧程序仍在原位。
  File /oname=$PLUGINSDIR\dc-verify.cjs "${PROJECT_DIR}\installer\verify-installed.cjs"
  ReadEnvStr $2 "ELECTRON_RUN_AS_NODE"
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
  !ifdef YOTOO_QA_INJECT_INSTALL_FAILURE
    ${GetParameters} $3
    ClearErrors
    ${GetOptions} $3 "/YOTOOQAFAILVERIFY" $4
    ${IfNot} ${Errors}
      nsExec::ExecToStack /TIMEOUT=1 '"$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\dc-verify.cjs" "${VERSION}"'
    ${Else}
  !endif
  nsExec::ExecToStack /TIMEOUT=60000 '"$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\dc-verify.cjs" "${VERSION}"'
  !ifdef YOTOO_QA_INJECT_INSTALL_FAILURE
    ${EndIf}
  !endif
  Pop $0
  Pop $1
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
FunctionEnd

Function DC_CopyPreparedProgram
  ; 安装期间只写程序依赖，最后再开放旧快捷方式指向的入口。
  !insertmacro DC_InstallStage 5 "正在写入程序文件"
  !insertmacro DC_CopyProgramTree "$PLUGINSDIR\7z-out" "$DC_ProgramDestination" '/XF "${APP_EXECUTABLE_FILENAME}" "YOTOO Installer UI.exe" /XD "$PLUGINSDIR\7z-out\resources\app"'
  ${If} ${Errors}
    Push "无法写入新版程序文件：$0 $1"
    Call DC_AbortProgramInstall
  ${EndIf}
  System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}", w "$DC_ProgramDestination\${DC_PENDING_EXE}", i 0)i.r0'
  ${If} $0 == 0
    Push "无法暂存新版主程序"
    Call DC_AbortProgramInstall
  ${EndIf}
FunctionEnd

Function DC_PrepareProgramDestination
  StrCpy $DC_ProgramDestination $INSTDIR
  ${If} $DC_InstallMode == "fresh"
    ; 用同盘目录完成整套文件。发布失败时，目标目录不会残留半套程序。
    ${GetParent} "$INSTDIR" $0
    ClearErrors
    GetTempFileName $1 "$0\"
    ${IfNot} ${Errors}
      Delete "$1"
      System::Call 'kernel32::CreateDirectoryW(w r1,p0)i.r0'
      ${If} $0 != 0
        StrCpy $DC_FreshStage $1
        StrCpy $DC_ProgramDestination $1
      ${EndIf}
    ${EndIf}
    ${If} $DC_FreshStage == ""
      Push "无法在安装目录旁建立暂存目录，请检查上级目录的写入权限。"
      Call DC_AbortProgramInstall
    ${EndIf}
  ${EndIf}
  SetOutPath "$DC_ProgramDestination"
FunctionEnd

Function DC_PublishFreshDirectory
  SetOutPath "$PLUGINSDIR"
  StrCpy $4 0
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR")i.r0'
    IntOp $2 $0 & 0x400
    ${If} $0 != -1
    ${AndIf} $2 != 0
      Push "安装目录已变为链接或目录联接，请重新选择位置。"
      Call DC_AbortProgramInstall
    ${EndIf}
    ; 只移除空目录。刚解除占用时 Windows 仍可能暂时拒绝删除或重命名。
    System::Call 'kernel32::RemoveDirectoryW(w "$INSTDIR")i.r0 ?e'
    Pop $1
    ${If} $0 != 0
    ${OrIf} $1 == 2
    ${OrIf} $1 == 3
      System::Call 'kernel32::MoveFileW(w "$DC_FreshStage",w "$INSTDIR")i.r0 ?e'
      Pop $1
      ${If} $0 != 0
        StrCpy $DC_FreshStage ""
        SetOutPath "$INSTDIR"
        Return
      ${EndIf}
    ${EndIf}
    ${If} $1 != 5
    ${AndIf} $1 != 32
    ${AndIf} $1 != 80
    ${AndIf} $1 != 183
      ${ExitDo}
    ${EndIf}
    IntOp $4 $4 + 1
    ${If} $4 < 8
      Sleep 400
    ${EndIf}
  ${LoopWhile} $4 < 8
  Push "无法发布程序目录，请确认所选位置为空且可写入。Windows 错误码：$1"
  Call DC_AbortProgramInstall
FunctionEnd

Function DC_PublishProgram
  ClearErrors
  File /oname=deploy-center.ico "${PROJECT_DIR}\assets\icon.ico"
  ${If} ${Errors}
  ${OrIfNot} ${FileExists} "$DC_ProgramDestination\${UNINSTALL_FILENAME}"
    Push "无法写入程序图标或卸载程序。"
    Call DC_AbortProgramInstall
  ${EndIf}
  !ifdef YOTOO_QA_INJECT_INSTALL_FAILURE
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/YOTOOQAFAILPUBLISH" $1
    ${IfNot} ${Errors}
      Push "隔离验收 QAFAILPUBLISH：模拟安装写入后失败"
      Call DC_AbortProgramInstall
    ${EndIf}
  !endif
  StrCpy $3 0
  ${Do}
    ClearErrors
    Rename "$DC_ProgramDestination\${DC_PENDING_EXE}" "$DC_ProgramDestination\${APP_EXECUTABLE_FILENAME}"
    ${IfNot} ${Errors}
      ${If} $DC_FreshStage != ""
        Call DC_PublishFreshDirectory
      ${EndIf}
      StrCpy $DC_ProgramPublished "1"
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
  ; 先写独立快捷方式，再替换旧文件，避免 Windows 继续解析已有快捷方式的坏目标。
  !insertmacro DC_ReplaceShortcut "$newStartMenuLink"
  ${If} $DC_DesktopChoice == ${BST_UNCHECKED}
    Delete "$newDesktopLink"
  ${Else}
    !insertmacro DC_ReplaceShortcut "$newDesktopLink"
  ${EndIf}
  !insertmacro DC_MarkTutorial
  CreateDirectory "$DC_InstallerLogs"
  FileOpen $DC_Log "$DC_InstallerLogs\last-install.log" a
  FileWrite $DC_Log "安装成功 ${VERSION}，目录：$INSTDIR$\r$\n"
  FileClose $DC_Log
  !insertmacro DC_InstallStage 6 "程序文件与快捷方式已安装完成"
!macroend

!macro DC_MarkTutorial
  ; 每次成功安装都生成新标记，包括同版本覆盖和静默更新。
  StrCpy $3 "$DC_DataRoot\Control"
  CreateDirectory "$3"
  System::Call 'kernel32::GetFileAttributesW(w r3)i.r0'
  IntOp $1 $0 & 0x400
  ${If} $0 == -1
  ${OrIf} $1 != 0
    Push "无法写入安装后教学向导标记：$3"
    Call DC_AbortProgramInstall
  ${EndIf}
  ClearErrors
  GetTempFileName $4 "$3"
  ${IfNot} ${Errors}
    FileOpen $DC_Log "$4" w
    ${IfNot} ${Errors}
      System::Call 'kernel32::GetSystemTimeAsFileTime(*l .r0)'
      System::Call 'kernel32::GetCurrentProcessId() i .r1'
      FileWrite $DC_Log "$0-$1"
      ${IfNot} ${Errors}
        FileClose $DC_Log
        StrCpy $1 "$3\install-tutorial.id"
        System::Call 'kernel32::MoveFileExW(w r4, w r1, i 9)i.r2'
      ${Else}
        FileClose $DC_Log
        StrCpy $2 0
      ${EndIf}
    ${Else}
      StrCpy $2 0
    ${EndIf}
    ${If} $2 == 0
      Delete "$4"
      SetErrors
    ${EndIf}
  ${EndIf}
  ${If} ${Errors}
    Push "无法写入安装后教学向导标记：$3"
    Call DC_AbortProgramInstall
  ${EndIf}
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

; 卸载默认不勾选数据清理。升级时即使被传入该选项，也不执行删除。
!macro customUnInit
  Call un.DC_SetDataPaths
  Call un.DC_ParsePurgeOptions
  ${IfNot} ${Silent}
    Call un.DC_StartElectronUninstall
  ${EndIf}
!macroend

!macro customUninstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.DC_ShowUninstallFinish
!macroend

!macro customUnInstall
  ; 和实际删除放在同一段，覆盖向导、原生回退及静默入口。
  Call un.checkAppRunning
  !insertmacro DC_WriteWizardStatus "progress" "12?" "" "" "0"
!macroend

!macro customUnInstallSection
  !insertmacro DC_DataCleanupFunctions "un."
  Section /o "un.彻底清理当前用户的配置、部署历史和日志（可选）" DC_PurgeData
    ${IfNot} ${isUpdated}
      Call un.DC_LoadPurgeLocations
      ${If} $DC_WizardProcess != 0
      ${AndIf} $DC_WizardProcess != ""
        !insertmacro DC_WriteWizardStatus "progress" "70?" "" "" "0"
        ; 确认之后位置记录变化时，保留数据供用户重新确认。
        ${If} $DC_DataActive != $DC_ConfirmedDataActive
        ${OrIf} $DC_DataPending != $DC_ConfirmedDataPending
        ${OrIf} $DC_DataPrevious != $DC_ConfirmedDataPrevious
          StrCpy $DC_PurgeError "数据目录已变化，未清理用户数据。"
        ${EndIf}
      ${EndIf}
      ${If} $DC_PurgeError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$DC_PurgeError$\r$\n程序卸载继续，未清理用户数据。" /SD IDOK
        Goto DC_PurgeDone
      ${EndIf}
      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "将永久删除以下数据目录中的配置、历史、凭据、日志及本地产物：$\r$\n当前：$DC_DataActive$\r$\n待切换：$DC_DataPending$\r$\n旧副本：$DC_DataPrevious$\r$\n位置记录：$DC_ControlDirectory$\r$\n$\r$\n服务器文件不受影响。确定彻底清理吗？" /SD IDNO IDYES +2
        Goto DC_PurgeDone
      ${EndIf}
      Call un.checkAppRunning
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
        StrCpy $DC_UninstallPurge "deleted"
      ${EndIf}
      ${If} $DC_PurgeError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$DC_PurgeError$\r$\n未清理的内容与位置记录已保留，请手动核实。" /SD IDOK
      ${EndIf}
      DC_PurgeDone:
    ${EndIf}
  SectionEnd

  Function un.DC_LoadPurgeLocations
    StrCpy $DC_PurgeError ""
    StrCpy $DC_DataActive "$DC_DataRoot"
    StrCpy $DC_DataPending ""
    StrCpy $DC_DataPrevious ""
    IfFileExists "$DC_ControlDirectory\data-location.ini" dc_read_locations 0
    IfFileExists "$DC_ControlDirectory\data-location.json" 0 dc_validate_locations
    StrCpy $DC_PurgeError "数据位置记录不完整，所有用户数据及位置记录已保留。"
    Return
    dc_read_locations:
    ReadINIStr $DC_DataActive "$DC_ControlDirectory\data-location.ini" "location" "active"
    ReadINIStr $DC_DataPending "$DC_ControlDirectory\data-location.ini" "location" "pending"
    ReadINIStr $DC_DataPrevious "$DC_ControlDirectory\data-location.ini" "location" "previous"
    ${If} $DC_DataActive == ""
      StrCpy $DC_PurgeError "数据位置记录无法读取，所有用户数据已保留。"
      Return
    ${EndIf}
    dc_validate_locations:
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
  FunctionEnd

  Function un.DC_StartElectronUninstall
    InitPluginsDir
    CreateDirectory "$PLUGINSDIR\7z-out"
    !insertmacro DC_CopyElectronForUninstall
    !insertmacro DC_OpenElectronWizard "un." "uninstall" "" "$INSTDIR" "0" "0" "0" "0" "$DC_InstallerLogs"
    ${If} $DC_WizardProcess == 0
      ; 安装目录损坏时，仍可通过原生向导安全卸载剩余文件。
      Return
    ${EndIf}
    ${Do}
      Call un.DC_WaitWizardCommand
      ${If} $DC_WizardAction == "cancel"
        Call un.DC_CloseWizardProcess
        SetErrorLevel 1602
        Quit
      ${EndIf}
      ${If} $DC_WizardAction != "start"
        ${Continue}
      ${EndIf}
      !insertmacro DC_CheckRunning $0
      ${If} $0 == 0
        !insertmacro DC_WriteWizardStatus "running-check" "0" "" "" "0"
        ${Continue}
      ${EndIf}
      !insertmacro UnselectSection ${DC_PurgeData}
      ${If} $DC_WizardPurge == 1
        Call un.DC_LoadPurgeLocations
        ${If} $DC_PurgeError != ""
          !insertmacro DC_WriteWizardStatus "invalid" "0" "$DC_PurgeError" "" "0"
          ${Continue}
        ${EndIf}
        ClearErrors
        FileOpen $0 "$DC_WizardChannel\purge.txt" w
        FileWriteUTF16LE $0 "$DC_DataActive$\r$\n"
        FileWriteUTF16LE $0 "$DC_DataPending$\r$\n"
        FileWriteUTF16LE $0 "$DC_DataPrevious$\r$\n"
        FileWriteUTF16LE $0 "$DC_ControlDirectory$\r$\n"
        FileClose $0
        ${If} ${Errors}
          !insertmacro DC_WriteWizardStatus "invalid" "0" "无法列出需要确认的数据目录。" "" "0"
          ${Continue}
        ${EndIf}
        !insertmacro DC_WriteWizardStatus "confirm-purge" "0" "" "" "0"
        Call un.DC_WaitWizardCommand
        ${If} $DC_WizardAction == "cancel"
          Call un.DC_CloseWizardProcess
          SetErrorLevel 1602
          Quit
        ${EndIf}
        ${If} $DC_WizardAction != "confirm-purge"
          !insertmacro DC_WriteWizardStatus "welcome" "0" "" "" "0"
          ${Continue}
        ${EndIf}
        ; 确认窗口打开期间应用仍可能被重新启动，重新确认前不得选择清理段。
        !insertmacro DC_CheckRunning $0
        ${If} $0 == 0
          !insertmacro DC_WriteWizardStatus "running-check" "0" "" "" "0"
          ${Continue}
        ${EndIf}
        StrCpy $DC_ConfirmedDataActive $DC_DataActive
        StrCpy $DC_ConfirmedDataPending $DC_DataPending
        StrCpy $DC_ConfirmedDataPrevious $DC_DataPrevious
        !insertmacro SelectSection ${DC_PurgeData}
      ${EndIf}
      ${ExitDo}
    ${Loop}
    SetSilent silent
    SetOutPath "$INSTDIR"
    !insertmacro DC_WriteWizardStatus "progress" "0?" "" "" "0"
  FunctionEnd

  Function un.DC_EndElectronUninstallFailure
    !insertmacro DC_WriteWizardStatus "failed" "0" "请退出应用，并检查程序文件是否仍被占用。" "卸载未完成。" "0"
    Call un.DC_WaitWizardCommand
    Call un.DC_CloseWizardProcess
  FunctionEnd

  Function un.DC_CheckProgramRemoval
    ${If} ${isUpdated}
      Return
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR")i.r0 ?e'
    Pop $1
    ${If} $0 == -1
      ${If} $1 == 2
      ${OrIf} $1 == 3
        Return
      ${EndIf}
    ${EndIf}
    ${If} $EXEPATH == "$INSTDIR\${UNINSTALL_FILENAME}"
      ; 使用 _?= 从原目录运行时只能剩下正在执行的卸载器本身。
      ClearErrors
      FindFirst $0 $1 "$INSTDIR\*"
      ${IfNot} ${Errors}
        ${While} $1 != ""
          ${If} $1 != "."
          ${AndIf} $1 != ".."
          ${AndIf} $1 != "${UNINSTALL_FILENAME}"
            FindClose $0
            Goto dc_program_remains
          ${EndIf}
          FindNext $0 $1
        ${EndWhile}
        FindClose $0
        Return
      ${EndIf}
    ${EndIf}
    dc_program_remains:
    ; 保留 Windows 卸载入口，文件解除占用后可以再次卸载。
    ${IfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      System::Call 'kernel32::CopyFileW(w "$EXEPATH",w "$INSTDIR\${UNINSTALL_FILENAME}",i 1)i.r0'
    ${EndIf}
    CreateDirectory "$DC_InstallerLogs"
    FileOpen $0 "$DC_InstallerLogs\last-uninstall.log" a
    FileWriteUTF16LE $0 "卸载未完成，程序目录仍可访问：$INSTDIR$\r$\n"
    FileClose $0
    ${If} $DC_WizardProcess == 0
    ${OrIf} $DC_WizardProcess == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "部分程序文件仍被占用或无法删除。请关闭占用文件的程序，再重新卸载。" /SD IDOK
    ${EndIf}
    SetErrorLevel 1603
    Abort
  FunctionEnd

  Function un.onUninstSuccess
    ${If} $DC_WizardProcess == 0
    ${OrIf} $DC_WizardProcess == ""
      Return
    ${EndIf}
    StrCpy $0 0
    ${If} $DC_UninstallPurge == "deleted"
      StrCpy $0 1
    ${EndIf}
    !insertmacro DC_WriteWizardStatus "done" "100" "$DC_PurgeError" "" "$0"
    Call un.DC_WaitWizardCommand
    Call un.DC_CloseWizardProcess
  FunctionEnd

  Function un.onUninstFailed
    ${If} $DC_WizardProcess != 0
    ${AndIf} $DC_WizardProcess != ""
      Call un.DC_EndElectronUninstallFailure
    ${EndIf}
  FunctionEnd
  Function un.DC_ParsePurgeOptions
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/PURGEDATA" $1
    ${IfNot} ${Errors}
    ${AndIfNot} ${isUpdated}
      !insertmacro SelectSection ${DC_PurgeData}
    ${EndIf}
  FunctionEnd

  Function un.DC_ShowUninstallConfirm
    nsDialogs::Create 1018
    Pop $5
    ${If} $5 == error
      ; 自定义对话框不可用时停止，避免跳过卸载确认。
      SetErrorLevel 1602
      Quit
    ${EndIf}
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:YOTOO 部署中心 卸载程序"
    Call un.DC_StyleWizardFrame
    !insertmacro DC_WizardPage $5
    CreateFont $R1 "Microsoft YaHei" 15 600
    CreateFont $R2 "Microsoft YaHei" 9 400
    !insertmacro DC_LoadBrandIcon
    !insertmacro DC_WizardScale $1 40
    ${NSD_CreateIcon} 12u 13u $1 $1 ""
    Pop $3
    System::Call 'user32::LoadImageW(p0,w "$PLUGINSDIR\dc-brand.ico",i1,ir1,ir1,i0x10)p.r2'
    SendMessage $3 ${STM_SETIMAGE} ${IMAGE_ICON} $2
    !insertmacro DC_WizardColors $3 "" "FFFFFF" "" "1C1C1E"
    !insertmacro DC_WelcomeLabel 41u 12u 246u 16u "卸载 YOTOO 部署中心" $R1 "${DC_BRAND_INK}"
    !insertmacro DC_WelcomeLabel 41u 25u 246u 21u "v${VERSION} · $INSTDIR" $R2 "${DC_BRAND_MUTED}"
    !insertmacro DC_WelcomeLabel 12u 49u 278u 22u "将移除程序文件和快捷方式。请先正常退出应用。" $R2 "${DC_BRAND_MUTED}"
    ${NSD_CreateCheckbox} 12u 75u 278u 15u "同时删除配置、部署历史和日志"
    Pop $DC_UninstallPurge
    ${If} $DC_WizardDark == 1
      System::Call 'uxtheme::SetWindowTheme(p $DC_UninstallPurge,w "",w "")'
    ${EndIf}
    !insertmacro DC_WizardColors $DC_UninstallPurge "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
    SectionGetFlags ${DC_PurgeData} $1
    IntOp $1 $1 & ${SF_SELECTED}
    ${NSD_SetState} $DC_UninstallPurge $1
    !insertmacro DC_WelcomeLabel 26u 91u 260u 17u "默认保留，重新安装后可继续使用。" $R2 "${DC_BRAND_MUTED}"
    !insertmacro DC_WelcomeLabel 12u 107u 278u 17u "选择删除后，会列出数据目录并再次确认。" $R2 "${DC_BRAND_MUTED}"
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:卸载"
    Call un.DC_StyleWizardPrimary
    Push $2
    Push $R1
    Push $R2
    nsDialogs::Show
    Pop $R2
    Pop $R1
    Pop $2
    System::Call 'user32::DestroyIcon(pr2)'
    System::Call 'gdi32::DeleteObject(p R1)'
    System::Call 'gdi32::DeleteObject(p R2)'
  FunctionEnd

  Function un.DC_LeaveUninstallConfirm
    ${NSD_GetState} $DC_UninstallPurge $0
    ${If} $0 == ${BST_CHECKED}
    ${AndIfNot} ${isUpdated}
      !insertmacro SelectSection ${DC_PurgeData}
    ${Else}
      !insertmacro UnselectSection ${DC_PurgeData}
    ${EndIf}
    StrCpy $DC_UninstallPurge ""
  FunctionEnd

  Function un.DC_ShowUninstallProgress
    GetDlgItem $0 $HWNDPARENT 2
    EnableWindow $0 0
    System::Call 'user32::GetSystemMenu(p $HWNDPARENT,i0)p.r0'
    System::Call 'user32::EnableMenuItem(pr0,i0xF060,i1)i.s'
    Pop $DC_UninstallCloseState
    System::Call 'user32::DrawMenuBar(p $HWNDPARENT)'
    Call un.DC_StyleWizardFrame
    !insertmacro DC_WizardHide 1
    !insertmacro DC_WizardHide 3
    !insertmacro DC_WizardPage $mui.InstFilesPage
    !insertmacro DC_WizardColors $mui.InstFilesPage.Text "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
    !insertmacro DC_WizardScale $1 24
    !insertmacro DC_WizardScale $2 20
    !insertmacro DC_WizardScale $3 32
    IntOp $4 $1 * 2
    IntOp $4 $DC_WizardWidth - $4
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:正在卸载 YOTOO 部署中心"
    System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.Text,p0,ir1,ir2,ir4,ir3,i0x14)'
    !insertmacro DC_WizardScale $2 58
    !insertmacro DC_WizardScale $3 8
    System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.ProgressBar,p0,ir1,ir2,ir4,ir3,i0x14)'
    ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
    ${If} $DC_WizardDark != -1
      System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar,w "",w "")'
      ${If} $DC_WizardDark == 1
        SendMessage $mui.InstFilesPage.ProgressBar 0x409 0 0x0C58EA
        SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 0x2A2626
      ${Else}
        SendMessage $mui.InstFilesPage.ProgressBar 0x409 0 0x1673F9
        SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 0xF2EFEF
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function un.DC_LeaveUninstallProgress
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 ${SW_SHOW}
    ${If} $DC_UninstallCloseState != -1
      System::Call 'user32::GetSystemMenu(p $HWNDPARENT,i0)p.r0'
      System::Call 'user32::EnableMenuItem(pr0,i0xF060,i $DC_UninstallCloseState)'
      System::Call 'user32::DrawMenuBar(p $HWNDPARENT)'
    ${EndIf}
  FunctionEnd

  Function un.DC_ShowUninstallFinish
    Call un.DC_StyleWizardFrame
    !insertmacro DC_WizardPage $mui.FinishPage
    !insertmacro DC_WizardHide 2
    !insertmacro DC_WizardHide 3
    ShowWindow $mui.FinishPage.Image ${SW_HIDE}
    ShowWindow $mui.FinishPage.Title ${SW_HIDE}
    ShowWindow $mui.FinishPage.Text ${SW_HIDE}
    CreateFont $R1 "Microsoft YaHei" 15 600
    CreateFont $R2 "Microsoft YaHei" 9 400
    CreateFont $R3 "Segoe UI Symbol" 19 600
    !insertmacro DC_FinishBadge $R3
    !insertmacro DC_CenteredLabel 73u 14u "卸载完成" $R1 "${DC_BRAND_INK}"
    StrCpy $R4 "程序文件和快捷方式已移除，用户数据已保留。"
    ${If} $DC_UninstallPurge == "deleted"
      StrCpy $R4 "程序文件、快捷方式和用户数据已移除。"
    ${ElseIf} $DC_PurgeError != ""
      StrCpy $R4 "程序文件和快捷方式已移除，请核实未能清理的数据。"
    ${EndIf}
    !insertmacro DC_CenteredLabel 87u 22u "$R4" $R2 "${DC_BRAND_MUTED}"
    !insertmacro DC_WizardColors $0 "52525B" "FFFFFF" "ABABB3" "1C1C1E"
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
    Call un.DC_StyleWizardPrimary
  FunctionEnd
!macroend

; 解压及写入程序文件已经完成后，进入系统注册和快捷方式阶段。
!macro customFiles_x64
  !insertmacro DC_InstallStage 5 "正在注册程序并创建快捷方式"
!macroend
!macro customFiles_ia32
  !insertmacro DC_InstallStage 5 "正在注册程序并创建快捷方式"
!macroend
!macro customFiles_arm64
  !insertmacro DC_InstallStage 5 "正在注册程序并创建快捷方式"
!macroend
