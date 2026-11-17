Unicode true
Name "YOTOO 安装进度验收"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
ShowInstDetails show
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include "${PROJECT_DIR}\installer\progress.nsh"
Var DC_InstallerLogs
Var DC_TestFinishTicks
Var DC_TestFinished
Var DC_TestPixel
Var DC_TestEmptyPixel
Page custom DC_TestOptions
!define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_TestProgressShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DC_CloseInstallProgress
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION DC_TestRun
!define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_TestFinishShow
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro DC_ProgressFunctions
Function .onInit
  StrCpy $DC_InstallerLogs "${CASE_DIR}"
FunctionEnd
!macro Check VALUE
  SendMessage $DC_StageBar 0x408 0 0 $0
  IntCmp $0 ${VALUE} +3
  SetErrorLevel 3
  Quit
!macroend
; 复现真实向导中选项页、安装页、完成页连续使用 nsDialogs 的情况。
Function DC_TestOptions
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0u 0u 100% 20u "只验证安装界面，不安装任何程序"
  Pop $0
  System::Call 'user32::PostMessageW(p $HWNDPARENT,i${WM_COMMAND},p1,p0)'
  nsDialogs::Show
FunctionEnd

Function DC_TestProgressShow
  System::Call 'user32::GetWindowLong(p $HWNDPARENT,i${DWLP_DLGPROC})p.r8'
  Call DC_ShowInstallProgress
  System::Call 'user32::GetWindowLong(p $HWNDPARENT,i${DWLP_DLGPROC})p.r7'
  IntCmp $7 $8 +3
  SetErrorLevel 8
  Quit
FunctionEnd

Function DC_TestFinishShow
  StrCpy $DC_TestFinishTicks 0
  ${NSD_CreateTimer} DC_TestFinishTick 100
FunctionEnd

Function DC_TestFinishTick
  IntOp $DC_TestFinishTicks $DC_TestFinishTicks + 1
  ; 完成页必须真正显示并持续等待，不能只在 SHOW 回调入口写一个通过标记。
  IntCmp $DC_TestFinishTicks 4 0 DC_TestFinishWait 0
  System::Call 'user32::IsWindowVisible(p $mui.FinishPage)i.r0'
  IntCmp $0 0 DC_TestFinishInvalid
  System::Call 'user32::IsWindowVisible(p $mui.FinishPage.Run)i.r0'
  IntCmp $0 0 DC_TestFinishInvalid
  SendMessage $mui.FinishPage.Run ${BM_GETCHECK} 0 0 $0
  IntCmp $0 ${BST_CHECKED} +2
  Goto DC_TestFinishInvalid
  FileOpen $0 "${CASE_DIR}\finish-ready.txt" w
  FileWriteUTF16LE $0 "完成页及立即运行选项持续可见；等待用户完成"
  FileClose $0
  SendMessage $mui.FinishPage.Run ${BM_SETCHECK} ${RUN_AFTER_FINISH} 0
  StrCpy $DC_TestFinished 1
  ${NSD_KillTimer} DC_TestFinishTick
  ; 仅向本夹具发送完成按钮事件，不控制任何正式安装窗口。
  System::Call 'user32::PostMessageW(p $HWNDPARENT,i${WM_COMMAND},p1,p0)'
  DC_TestFinishWait:
  Return
  DC_TestFinishInvalid:
  SetErrorLevel 7
  Quit
FunctionEnd

; 使用控件自身的打印接口检查实际绘制，避免只测 PBM_GETPOS 而漏掉画面仍未满。
Function DC_TestProgressPixel
  System::Call 'user32::GetDC(p $DC_StageBar)p.r0'
  System::Call 'gdi32::CreateCompatibleDC(pr0)p.r1'
  System::Call '*(i0,i0,i0,i0)p.r2'
  System::Call 'user32::GetClientRect(p $DC_StageBar,pr2)'
  System::Call '*$2(i,i,i.r3,i.r4)'
  System::Free $2
  System::Call 'gdi32::CreateCompatibleBitmap(pr0,ir3,ir4)p.r5'
  System::Call 'gdi32::SelectObject(pr1,pr5)p.r6'
  System::Call 'user32::PrintWindow(p $DC_StageBar,pr1,i1)i.r9'
  IntOp $7 $3 * 9
  IntOp $7 $7 / 10
  IntOp $8 $4 / 2
  System::Call 'gdi32::GetPixel(pr1,ir7,ir8)i.s'
  Pop $DC_TestPixel
  System::Call 'gdi32::SelectObject(pr1,pr6)'
  System::Call 'gdi32::DeleteObject(pr5)'
  System::Call 'gdi32::DeleteDC(pr1)'
  System::Call 'user32::ReleaseDC(p $DC_StageBar,pr0)'
  ${If} $9 == 0
  ${OrIf} $DC_TestPixel == -1
    SetErrorLevel 9
    Quit
  ${EndIf}
FunctionEnd

Function DC_TestRun
  FileOpen $0 "${CASE_DIR}\run-requested.txt" w
  FileWrite $0 "仅记录用户选择，不启动任何应用"
  FileClose $0
FunctionEnd

Function .onGUIEnd
  ${If} $DC_TestFinished == 1
    FileOpen $0 "${CASE_DIR}\finish-closed.txt" w
    FileWriteUTF16LE $0 "通过完成按钮正常退出"
    FileClose $0
  ${EndIf}
FunctionEnd

Section
  !insertmacro Check 1
  Call DC_TestProgressPixel
  StrCpy $DC_TestEmptyPixel $DC_TestPixel
  System::Call '*(i0,i0,i0,i0)p.r1'
  System::Call 'user32::GetWindowRect(p $DC_DetailToggle,p r1)'
  System::Call '*$1(i,i,i,i.r4)'
  System::Call 'user32::GetWindowRect(p $mui.InstFilesPage.Log,p r1)'
  System::Call '*$1(i,i.r3,i,i)'
  System::Free $1
  IntCmp $3 $4 +3 0 +3
  SetErrorLevel 6
  Quit
  SendMessage $mui.InstFilesPage.ProgressBar 0x402 90 0
  !insertmacro DC_InstallStage 2 "正在安装测试文件（不安装任何真实程序）"
  DetailPrint "校验测试产物"
  DetailPrint "解压程序文件"
  !insertmacro Check 2
  !ifdef OBSERVE
    Sleep 90000
  !endif
  ; 模拟解压插件把原生进度从接近完成重置到零，独立的总体进度必须保持不变。
  SendMessage $mui.InstFilesPage.ProgressBar 0x402 0 0
  !insertmacro Check 2
  SendMessage $DC_DetailToggle ${BM_SETCHECK} 0 0
  Sleep 300
  System::Call 'user32::IsWindowVisible(p $mui.InstFilesPage.Log)i.r0'
  IntCmp $0 0 +3
  SetErrorLevel 4
  Quit
  SendMessage $DC_DetailToggle ${BM_SETCHECK} 1 0
  Sleep 300
  System::Call 'user32::IsWindowVisible(p $mui.InstFilesPage.Log)i.r0'
  IntCmp $0 0 0 +3 +3
  SetErrorLevel 5
  Quit
  Sleep 1000
  !insertmacro DC_InstallStage 3 "注册测试入口"
  !insertmacro Check 3
  !insertmacro DC_InstallStage 2 "禁止阶段回退"
  !insertmacro Check 3
  Sleep 1000
  !insertmacro DC_InstallStage 4 "验收完成"
  !insertmacro Check 4
  Call DC_TestProgressPixel
  ${If} $DC_TestPixel == $DC_TestEmptyPixel
    SetErrorLevel 10
    Quit
  ${EndIf}
  FileOpen $0 "${CASE_DIR}\passed.txt" w
  FileWrite $0 "阶段单调；插件重置隔离；详情可折叠"
  FileClose $0
  SetErrorLevel 0
SectionEnd
