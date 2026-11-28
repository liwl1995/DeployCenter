!include TextFunc.nsh
!include "$%YOTOO_INSTALLER_RUNTIME_INCLUDE%"

!ifndef BUILD_UNINSTALLER
Var DC_ElectronReady
!endif
Var DC_WizardChannel
Var DC_WizardProcess
Var DC_WizardAction
Var DC_WizardValue
Var DC_WizardDesktop
Var DC_WizardDowngrade
Var DC_WizardPurge
Var DC_WizardSequence
Var DC_WizardStatusResult

!macro DC_WriteWizardStatus PHASE PROGRESS REASON RECOVERY PURGED
  ${If} $DC_WizardProcess != 0
  ${AndIf} $DC_WizardProcess != ""
    Push $R8
    Push $R9
    ClearErrors
    StrCpy $DC_WizardStatusResult "failed"
    FileOpen $R8 "$DC_WizardChannel\status.tmp" w
    ${IfNot} ${Errors}
      FileWriteUTF16LE $R8 "${PHASE}$\r$\n${PROGRESS}$\r$\n${REASON}$\r$\n${RECOVERY}$\r$\n${PURGED}$\r$\n"
      FileClose $R8
      ${IfNot} ${Errors}
        ; 状态文件发布后保持不变，避免覆盖向导正在读取的进度。
        IntOp $R8 $DC_WizardSequence + 1
        StrCpy $R9 0
        ${Do}
          System::Call 'kernel32::MoveFileExW(w "$DC_WizardChannel\status.tmp",w "$DC_WizardChannel\status.$R8.txt",i8)i.s'
          Pop $DC_WizardStatusResult
          ${If} $DC_WizardStatusResult != 0
            StrCpy $DC_WizardSequence $R8
            ${ExitDo}
          ${EndIf}
          Sleep 40
          IntOp $R9 $R9 + 1
        ${LoopWhile} $R9 < 8
        ${If} $DC_WizardStatusResult == 0
          StrCpy $DC_WizardStatusResult "failed"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $R9
    Pop $R8
  ${EndIf}
!macroend

!macro DC_OpenElectronWizard PREFIX MODE FROM DIR SPACE DESKTOP CHOOSE BACK LOGS
  InitPluginsDir
  StrCpy $DC_WizardChannel "$PLUGINSDIR\wizard"
  StrCpy $DC_WizardSequence 0
  StrCpy $DC_WizardStatusResult ""
  CreateDirectory "$DC_WizardChannel"
  SetOutPath "$PLUGINSDIR\7z-out\resources\app"
  File "${PROJECT_DIR}\installer\ui\package.json"
  File "${PROJECT_DIR}\installer\ui\index.html"
  File "${PROJECT_DIR}\installer\ui\wizard.css"
  File "${PROJECT_DIR}\installer\ui\renderer.js"
  File "${PROJECT_DIR}\installer\ui\host.cjs"
  File "${PROJECT_DIR}\installer\ui\preload.cjs"
  File /oname=icon.svg "${PROJECT_DIR}\assets\icon.svg"
  SetOutPath "$PLUGINSDIR"
  System::Call 'kernel32::GetCurrentProcessId()i.r6'
  FileOpen $7 "$DC_WizardChannel\session.txt" w
  FileWriteUTF16LE $7 "${MODE}$\r$\n${FROM}$\r$\n${VERSION}$\r$\n${DIR}$\r$\n${SPACE}$\r$\n${DESKTOP}$\r$\n${CHOOSE}$\r$\n${BACK}$\r$\n"
  FileWriteUTF16LE $7 "${LOGS}$\r$\n$EXEPATH$\r$\n$6$\r$\n${DC_INSTALLER_PAYLOAD_BYTES}$\r$\n"
  FileClose $7
  Call ${PREFIX}DC_LaunchElectronWizard
!macroend

!macro DC_WizardReadLine PREFIX HANDLE VALUE
  FileReadUTF16LE ${HANDLE} ${VALUE}
  ${${PREFIX}TrimNewLines} ${VALUE} ${VALUE}
!macroend

!macro DC_ElectronWizardFunctions PREFIX
Function ${PREFIX}DC_LaunchElectronWizard
  StrCpy $DC_WizardProcess 0
  ; 进程名与正式应用不同，照常识别安装期间启动的旧程序。
  System::Call 'kernel32::CreateHardLinkW(w "$PLUGINSDIR\7z-out\YOTOO Installer UI.exe",w "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}",p0)i.r0'
  ${If} $0 == 0
    System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}",w "$PLUGINSDIR\7z-out\YOTOO Installer UI.exe",i1)i.r0'
  ${EndIf}
  ${If} $0 == 0
    Return
  ${EndIf}
  ClearErrors
  ReadEnvStr $3 "ELECTRON_RUN_AS_NODE"
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE",p0)'
  ClearErrors
  Exec '"$PLUGINSDIR\7z-out\YOTOO Installer UI.exe" "--yotoo-installer-ui=$DC_WizardChannel"'
  ${If} $3 != ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE",wr3)'
  ${EndIf}
  ${If} ${Errors}
    Return
  ${EndIf}
  StrCpy $0 0
  ${Do}
    IfFileExists "$DC_WizardChannel\startup-error.txt" 0 +2
      Return
    IfFileExists "$DC_WizardChannel\ready.txt" 0 dc_wait_ready
    FileOpen $1 "$DC_WizardChannel\ready.txt" r
    !insertmacro DC_WizardReadLine "${PREFIX}" $1 $2
    FileClose $1
    System::Call 'kernel32::OpenProcess(i0x100000,i0,ir2)p.s'
    Pop $DC_WizardProcess
    Return
    dc_wait_ready:
    Sleep 100
    IntOp $0 $0 + 1
  ${LoopWhile} $0 < 150
FunctionEnd

Function ${PREFIX}DC_WaitWizardCommand
  StrCpy $DC_WizardAction "cancel"
  ${If} $DC_WizardStatusResult == "failed"
    ; 未送达的页面不会产生用户操作。退出等待，由向导处理引擎退出。
    Return
  ${EndIf}
  ${Do}
    IfFileExists "$DC_WizardChannel\command.txt" 0 dc_wait_command
    FileOpen $0 "$DC_WizardChannel\command.txt" r
    !insertmacro DC_WizardReadLine "${PREFIX}" $0 $DC_WizardAction
    !insertmacro DC_WizardReadLine "${PREFIX}" $0 $DC_WizardValue
    ${If} $DC_WizardAction == "start"
      !insertmacro DC_WizardReadLine "${PREFIX}" $0 $DC_WizardDesktop
      !insertmacro DC_WizardReadLine "${PREFIX}" $0 $DC_WizardDowngrade
      !insertmacro DC_WizardReadLine "${PREFIX}" $0 $DC_WizardPurge
    ${EndIf}
    FileClose $0
    Delete "$DC_WizardChannel\command.txt"
    Return
    dc_wait_command:
    System::Call 'kernel32::WaitForSingleObject(p $DC_WizardProcess,i100)i.r0'
  ${LoopWhile} $0 == 258
FunctionEnd

Function ${PREFIX}DC_CloseWizardProcess
  ; 向导退出后，NSIS 才能清理私有目录中的 Electron 运行时。
  System::Call 'kernel32::WaitForSingleObject(p $DC_WizardProcess,i15000)'
  System::Call 'kernel32::CloseHandle(p $DC_WizardProcess)'
  StrCpy $DC_WizardProcess 0
FunctionEnd
!macroend

!macro DC_CheckRunning RESULT
  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop ${RESULT}
  ${If} ${RESULT} != 0
    nsProcess::_FindProcess /NOUNLOAD "Deploy Center.exe"
    Pop ${RESULT}
  ${EndIf}
!macroend
