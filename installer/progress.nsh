; 安装阶段单独显示，不让解压插件对原生进度条的重置影响总体进度。
!ifndef BUILD_UNINSTALLER
!include "${PROJECT_DIR}\installer\wizard-style.nsh"
!include Win\WinUser.nsh
Var DC_StageBar
Var DC_IndeterminateBar
Var DC_StageList
Var DC_StageStates
Var DC_StageFont
Var DC_ProgressHasPrevious
Var DC_ProgressCloseState
Var DC_Stage
Var DC_NextStage
Var DC_StageText
Var DC_NextStageText
!macro DC_InstallStage VALUE TEXT
  StrCpy $DC_NextStage ${VALUE}
  StrCpy $DC_NextStageText "${TEXT}"
  Call DC_UpdateInstallStage
!macroend

!macro DC_StageLine NUMBER TEXT
  ${If} $DC_Stage > ${NUMBER}
  ${OrIf} $DC_Stage == 6
    StrCpy $2 "已完成"
    StrCpy $3 "✓"
  ${ElseIf} $DC_Stage == ${NUMBER}
    StrCpy $2 "进行中"
    StrCpy $3 "●"
  ${Else}
    StrCpy $2 "等待"
    StrCpy $3 "○"
  ${EndIf}
  StrCpy $0 "$0$3   ${TEXT}$\r$\n$\r$\n"
  StrCpy $1 "$1$2$\r$\n$\r$\n"
!macroend

!macro DC_ProgressFunctions
Function DC_UpdateInstallStage
  Push $0
  ; 只接受真实阶段的推进；重试或插件的局部进度不得使总体阶段倒退。
  ${If} $DC_NextStage >= $DC_Stage
    StrCpy $DC_Stage $DC_NextStage
    StrCpy $DC_StageText $DC_NextStageText
    SetDetailsPrint listonly
    DetailPrint "$DC_StageText"
    FileOpen $0 "$DC_InstallerLogs\last-install.log" a
    FileWrite $0 "$DC_StageText$\r$\n"
    FileClose $0
    !ifdef DC_ELECTRON_UI
      ${Switch} $DC_Stage
        ${Case} 1
          StrCpy $0 "0?"
          ${Break}
        ${Case} 2
          StrCpy $0 "8?"
          ${Break}
        ${Case} 3
          StrCpy $0 "68?"
          ${Break}
        ${Case} 4
          StrCpy $0 "76?"
          ${Break}
        ${Case} 5
          StrCpy $0 "76?"
          ${If} $DC_ProgressHasPrevious == 1
            StrCpy $0 "82?"
          ${EndIf}
          ${Break}
        ${Default}
          StrCpy $0 "94?"
      ${EndSwitch}
      !insertmacro DC_WriteWizardStatus "progress" "$0" "" "" "0"
    !endif
    ${If} $DC_StageBar != ""
      SendMessage $DC_StageBar 0x402 $DC_Stage 0
      System::Call 'user32::RedrawWindow(p $DC_StageBar,p0,p0,i0x101)'
      SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:$DC_StageText"
      Call DC_PaintInstallStages
      ; 解包与复制由原生插件执行，无法可靠量化时只显示正在处理。
      ${If} $DC_IndeterminateBar != 0
        ${If} $DC_Stage == 2
        ${OrIf} $DC_Stage == 3
        ${OrIf} $DC_Stage == 4
        ${OrIf} $DC_Stage == 5
          ShowWindow $DC_StageBar ${SW_HIDE}
          ShowWindow $DC_IndeterminateBar ${SW_SHOW}
          SendMessage $DC_IndeterminateBar 0x40A 1 45
        ${Else}
          SendMessage $DC_IndeterminateBar 0x40A 0 0
          ShowWindow $DC_IndeterminateBar ${SW_HIDE}
          ShowWindow $DC_StageBar ${SW_SHOW}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

Function DC_PaintInstallStages
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 ""
  StrCpy $1 ""
  !insertmacro DC_StageLine 1 "检查安装条件"
  !insertmacro DC_StageLine 2 "解压程序文件"
  !insertmacro DC_StageLine 3 "校验新版程序"
  ${If} $DC_ProgressHasPrevious == 1
    !insertmacro DC_StageLine 4 "备份当前版本"
  ${EndIf}
  !insertmacro DC_StageLine 5 "写入程序与快捷方式"
  !insertmacro DC_StageLine 6 "核验安装结果"
  SendMessage $DC_StageList ${WM_SETTEXT} 0 "STR:$0"
  SendMessage $DC_StageStates ${WM_SETTEXT} 0 "STR:$1"
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function DC_ShowInstallProgress
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  ; 同时封住标题栏和 Alt+F4 的系统关闭入口。NSIS 自身也会禁用安装页上的取消按钮。
  GetDlgItem $5 $HWNDPARENT 2
  EnableWindow $5 0
  System::Call 'user32::GetSystemMenu(p $HWNDPARENT,i 0)p.r5'
  System::Call 'user32::EnableMenuItem(p r5,i 0xF060,i 1)i.s'
  Pop $DC_ProgressCloseState
  System::Call 'user32::DrawMenuBar(p $HWNDPARENT)'
  Call DC_StyleWizardFrame
  !insertmacro DC_WizardHide 1
  !insertmacro DC_WizardHide 3
  !insertmacro DC_WizardPage $mui.InstFilesPage
  !insertmacro DC_WizardColors $mui.InstFilesPage.Text "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
  ; 进度页沿用原型的留白和两列阶段清单，控件位置按 DPI 换算。
  !insertmacro DC_WizardScale $1 24
  !insertmacro DC_WizardScale $2 20
  IntOp $3 $1 * 2
  IntOp $3 $DC_WizardWidth - $3
  !insertmacro DC_WizardScale $4 24
  System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.Text,p0,ir1,ir2,ir3,ir4,i0x14)'
  ${If} $DC_StageFont == ""
    CreateFont $DC_StageFont "Microsoft YaHei" 11 600
  ${EndIf}
  SendMessage $mui.InstFilesPage.Text ${WM_SETFONT} $DC_StageFont 1
  !insertmacro DC_WizardScale $2 58
  !insertmacro DC_WizardScale $4 8
  System::Call 'user32::CreateWindowExW(i0,w "msctls_progress32",w "安装阶段进度",i0x50000001,ir1,ir2,ir3,ir4,p $mui.InstFilesPage,p1990,p0,p0)p.s'
  Pop $DC_StageBar
  ; PBS_MARQUEE 与普通进度分开，保留最新阶段值和完成时的满进度。
  System::Call 'user32::CreateWindowExW(i0,w "msctls_progress32",w "正在处理",i0x40000008,ir1,ir2,ir3,ir4,p $mui.InstFilesPage,p1992,p0,p0)p.s'
  Pop $DC_IndeterminateBar
  ; 真实阶段由安装回调推进，完成时立即显示满进度。
  System::Call 'uxtheme::SetWindowTheme(p $DC_StageBar,w "",w "")'
  System::Call 'uxtheme::SetWindowTheme(p $DC_IndeterminateBar,w "",w "")'
  ; COLORREF 使用 BGR 顺序，对应原型的橙色和轨道颜色。
  ${If} $DC_WizardDark == 1
    SendMessage $DC_StageBar 0x409 0 0x0C58EA
    SendMessage $DC_StageBar 0x2001 0 0x2A2626
    SendMessage $DC_IndeterminateBar 0x409 0 0x0C58EA
    SendMessage $DC_IndeterminateBar 0x2001 0 0x2A2626
  ${ElseIf} $DC_WizardDark == 0
    SendMessage $DC_StageBar 0x409 0 0x1673F9
    SendMessage $DC_StageBar 0x2001 0 0xF2EFEF
    SendMessage $DC_IndeterminateBar 0x409 0 0x1673F9
    SendMessage $DC_IndeterminateBar 0x2001 0 0xF2EFEF
  ${EndIf}
  SendMessage $DC_StageBar 0x406 0 6
  ShowWindow $mui.InstFilesPage.ProgressBar ${SW_HIDE}
  ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
  ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
  ; 日志依旧写入原有文件。界面独立显示阶段名和右对齐状态。
  !insertmacro DC_WizardScale $2 92
  !insertmacro DC_WizardScale $4 210
  !insertmacro DC_WizardScale $5 96
  IntOp $3 $3 - $5
  System::Call 'user32::CreateWindowExW(i0,w "STATIC",w "",i0x50000000,ir1,ir2,ir3,ir4,p $mui.InstFilesPage,p1991,p0,p0)p.s'
  Pop $DC_StageList
  !insertmacro DC_WizardColors $DC_StageList "52525B" "FFFFFF" "ABABB3" "1C1C1E"
  !insertmacro DC_WizardScale $5 84
  IntOp $1 $DC_WizardWidth - $1
  IntOp $1 $1 - $5
  System::Call 'user32::CreateWindowExW(i0,w "STATIC",w "",i0x50000002,ir1,ir2,ir5,ir4,p $mui.InstFilesPage,p1994,p0,p0)p.s'
  Pop $DC_StageStates
  !insertmacro DC_WizardColors $DC_StageStates "65656E" "FFFFFF" "9A9AA2" "1C1C1E"
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $5
  SendMessage $DC_StageList ${WM_SETFONT} $5 1
  SendMessage $DC_StageStates ${WM_SETFONT} $5 1
  !insertmacro DC_InstallStage 1 "正在检查安装条件"
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function DC_CloseInstallProgress
  Push $0
  ; 安装页不展示下一步。离开后交还给完成页或失败控制流程。
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  ${If} $DC_ProgressCloseState != ""
  ${AndIf} $DC_ProgressCloseState != -1
    System::Call 'user32::GetSystemMenu(p $HWNDPARENT,i 0)p.r0'
    System::Call 'user32::EnableMenuItem(p r0,i 0xF060,i $DC_ProgressCloseState)'
    System::Call 'user32::DrawMenuBar(p $HWNDPARENT)'
  ${EndIf}
  StrCpy $DC_ProgressCloseState ""
  StrCpy $DC_StageBar ""
  StrCpy $DC_IndeterminateBar ""
  StrCpy $DC_StageList ""
  StrCpy $DC_StageStates ""
  Pop $0
FunctionEnd
!macroend
!endif
