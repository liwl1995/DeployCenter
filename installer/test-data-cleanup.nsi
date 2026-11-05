Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "YOTOO 数据清理隔离验收"
OutFile "${OUTPUT_FILE}"
!include LogicLib.nsh
!include FileFunc.nsh
!include "${PROJECT_DIR}\installer\data-cleanup.nsh"
!insertmacro DC_DataCleanupFunctions ""
Section
  StrCpy $DC_PurgeError ""
  Push "${CASE_DIR}"
  Call DC_ValidateDataRoot
  !ifdef REMOVE_FIXTURE
    Push "${CASE_DIR}"
    Call DC_RemoveDataRoot
  !endif
  FileOpen $0 "${RESULT_FILE}" w
  ${If} $DC_PurgeError == ""
    FileWrite $0 "ok"
    SetErrorLevel 0
  ${Else}
    FileWrite $0 "blocked"
    SetErrorLevel 2
  ${EndIf}
  FileClose $0
SectionEnd
