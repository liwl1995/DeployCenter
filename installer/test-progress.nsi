Unicode true
Name "YOTOO 安装进度验收"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
ShowInstDetails show
AutoCloseWindow true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh
!include "${PROJECT_DIR}\installer\progress.nsh"
Var DC_InstallerLogs
!define MUI_PAGE_CUSTOMFUNCTION_SHOW DC_ShowInstallProgress
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DC_CloseInstallProgress
!insertmacro MUI_PAGE_INSTFILES
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
Section
  !insertmacro Check 1
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
  FileOpen $0 "${CASE_DIR}\passed.txt" w
  FileWrite $0 "阶段单调；插件重置隔离；详情可折叠"
  FileClose $0
  SetErrorLevel 0
SectionEnd
