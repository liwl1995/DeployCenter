Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "YOTOO 安装数据路径隔离验收"
OutFile "${OUTPUT_FILE}"
!include LogicLib.nsh
!include FileFunc.nsh
!include "${PROJECT_DIR}\installer\data-cleanup.nsh"
!include "${PROJECT_DIR}\installer\data-paths.nsh"
!define DC_DATA_CHECK_ONLY
!insertmacro DC_DataCleanupFunctions ""
!undef DC_DATA_CHECK_ONLY
!insertmacro DC_DataPathFunctions ""
Section
  SetRegView 64
  !ifdef CASE_DIR
  WriteRegStr HKCU "${YOTOO_LOCATION_KEY}" "DataDirectory" "${CASE_DIR}"
  !endif
  Call DC_SetDataPaths
  FileOpen $0 "${RESULT_FILE}" w
  FileWriteUTF16LE $0 "$DC_DataRoot$\r$\n$DC_InstallerLogs$\r$\n$DC_InstallerBackups$\r$\n$DC_ControlDirectory"
  FileClose $0
  DeleteRegKey HKCU "${YOTOO_LOCATION_KEY}"
SectionEnd
