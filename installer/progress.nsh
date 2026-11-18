; 安装阶段单独显示，不让解压插件对原生进度条的重置影响总体进度。
!ifndef BUILD_UNINSTALLER
!include Win\WinUser.nsh
Var DC_TimerDialog
Var DC_StageBar
Var DC_DetailToggle
Var DC_DetailVisible
Var DC_Stage
Var DC_NextStage
Var DC_StageText
Var DC_NextStageText
!macro DC_InstallStage VALUE TEXT
  StrCpy $DC_NextStage ${VALUE}
  StrCpy $DC_NextStageText "${TEXT}"
  Call DC_UpdateInstallStage
!macroend

!macro DC_ProgressFunctions
Function DC_UpdateInstallStage
  Push $0
  ; 只接受真实阶段的推进；重试或插件的局部进度不得使总体阶段倒退。
  ${If} $DC_NextStage >= $DC_Stage
    StrCpy $DC_Stage $DC_NextStage
    StrCpy $DC_StageText $DC_NextStageText
    SetDetailsPrint listonly
    DetailPrint "阶段 $DC_Stage/4：$DC_StageText"
    FileOpen $0 "$DC_InstallerLogs\last-install.log" a
    FileWrite $0 "阶段 $DC_Stage/4：$DC_StageText$\r$\n"
    FileClose $0
    ${If} $DC_StageBar != ""
      SendMessage $DC_StageBar 0x402 $DC_Stage 0
      System::Call 'user32::RedrawWindow(p $DC_StageBar,p0,p0,i0x101)'
      !insertmacro MUI_HEADER_TEXT "正在安装" "第 3 步 / 共 4 步"
      SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:安装阶段 $DC_Stage / 4 · $DC_StageText"
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

Function DC_InstallDetailsTick
  Push $0
  SendMessage $DC_DetailToggle ${BM_GETCHECK} 0 0 $0
  ${If} $0 != $DC_DetailVisible
    StrCpy $DC_DetailVisible $0
    ${If} $0 == ${BST_CHECKED}
      ShowWindow $mui.InstFilesPage.Log ${SW_SHOW}
    ${Else}
      ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
    ${EndIf}
  ${EndIf}
  ; 标准按钮只能单向展开，用独立的可勾选控件提供收起能力。
  ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
  Pop $0
FunctionEnd

Function DC_ShowInstallProgress
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  ; 使用标准控件的物理位置与字体，跟随 Windows DPI，不拉伸文字位图。
  System::Call '*(i0,i0,i0,i0)p.r0'
  System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.ProgressBar,p r0)'
  System::Call 'user32::MapWindowPoints(p0,p $mui.InstFilesPage,p r0,i2)'
  System::Call '*$0(i.r1,i.r2,i.r3,i.r4)'
  IntOp $3 $3 - $1
  IntOp $4 $4 - $2
  System::Call 'user32::CreateWindowExW(i0,w "msctls_progress32",w "安装阶段进度",i0x50000001,ir1,ir2,ir3,ir4,p $mui.InstFilesPage,p1990,p0,p0)p.s'
  Pop $DC_StageBar
  ; 阶段只跳四次，禁用该控件的系统缓动，避免完成时画面仍落后于真实阶段。
  System::Call 'uxtheme::SetWindowTheme(p $DC_StageBar,w "",w "")'
  ; COLORREF 使用 BGR 顺序，对应品牌深橙和浅灰轨道。
  SendMessage $DC_StageBar 0x409 0 0x0C41C2
  SendMessage $DC_StageBar 0x2001 0 0xEEEFF1
  SendMessage $DC_StageBar 0x406 0 4
  ShowWindow $mui.InstFilesPage.ProgressBar ${SW_HIDE}
  System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.ShowLogButton,p r0)'
  System::Call 'user32::MapWindowPoints(p0,p $mui.InstFilesPage,p r0,i2)'
  System::Call '*$0(i.r1,i.r2,i.r3,i.r4)'
  IntOp $4 $4 - $2
  System::Call 'user32::GetClientRect(p $mui.InstFilesPage,p r0)'
  System::Call '*$0(i,i,i.r3,i)'
  IntOp $3 $3 - $1
  IntOp $3 $3 - $1
  System::Call 'user32::CreateWindowExW(i0,w "BUTTON",w "显示安装日志",i0x50010003,ir1,ir2,ir3,ir4,p $mui.InstFilesPage,p1991,p0,p0)p.s'
  Pop $DC_DetailToggle
  ; 标准展开按钮与日志原本共用同一行；为可反复切换的开关单独留出一行。
  IntOp $5 $2 + $4
  IntOp $4 $4 / 4
  IntOp $5 $5 + $4
  System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.Log,p r0)'
  System::Call 'user32::MapWindowPoints(p0,p $mui.InstFilesPage,p r0,i2)'
  System::Call '*$0(i.r1,i.r2,i.r3,i.r4)'
  IntOp $3 $3 - $1
  IntOp $4 $4 - $5
  System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.Log,p0,ir1,ir5,ir3,ir4,i0x14)'
  SendMessage $mui.InstFilesPage.ShowLogButton ${WM_GETFONT} 0 0 $5
  SendMessage $DC_DetailToggle ${WM_SETFONT} $5 1
  SendMessage $DC_DetailToggle ${BM_SETCHECK} ${BST_UNCHECKED} 0
  StrCpy $DC_DetailVisible -1
  Call DC_InstallDetailsTick
  ; 只借用隐藏窗口承载计时器，不把它当作向导页面。
  ; Create 会接管主窗口回调，而这里不调用 Show 来恢复它，必须立即还原。
  ; 否则下一张 nsDialogs 完成页会形成回调递归，安装完成后异常退出。
  System::Call 'user32::GetWindowLong(p $HWNDPARENT,i${DWLP_DLGPROC})p.r5'
  nsDialogs::Create 1018
  Pop $DC_TimerDialog
  System::Call 'user32::SetWindowLong(p $HWNDPARENT,i${DWLP_DLGPROC},pr5)'
  ${If} $DC_TimerDialog != "error"
    ${NSD_CreateTimer} DC_InstallDetailsTick 100
  ${Else}
    StrCpy $DC_TimerDialog ""
    ShowWindow $DC_DetailToggle ${SW_HIDE}
  ${EndIf}
  !insertmacro DC_InstallStage 1 "准备安装；覆盖升级会保留用户数据"
  System::Free $0
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function DC_CloseInstallProgress
  ${If} $DC_TimerDialog != ""
    ${NSD_KillTimer} DC_InstallDetailsTick
    System::Call 'user32::DestroyWindow(p $DC_TimerDialog)'
    StrCpy $DC_TimerDialog ""
  ${EndIf}
FunctionEnd
!macroend
!endif
