; 安装日志与升级备份跟随应用配置的数据目录。旧版用户目录仅作为一次兼容读取来源。
!ifndef YOTOO_LOCATION_KEY
  !define YOTOO_LOCATION_KEY "Software\YOTOO\DeployCenter"
!endif
Var DC_DataRoot
Var DC_ControlDirectory
Var DC_InstallerLogs
Var DC_InstallerBackups
!macro DC_DataPathFunctions PREFIX
Function ${PREFIX}DC_SetDataPaths
  ReadRegStr $DC_DataRoot HKCU "${YOTOO_LOCATION_KEY}" "DataDirectory"
  StrCpy $DC_ControlDirectory "$DC_DataRoot\Control"
  ${If} $DC_DataRoot == ""
    StrCpy $DC_DataRoot "$APPDATA\DeployCenter"
    StrCpy $DC_ControlDirectory "$DC_DataRoot\Control"
    IfFileExists "$LOCALAPPDATA\DeployCenter\Settings\data-location.ini" 0 DC_LocationReadDone
    ReadINIStr $DC_DataRoot "$LOCALAPPDATA\DeployCenter\Settings\data-location.ini" "location" "active"
    StrCpy $DC_ControlDirectory "$LOCALAPPDATA\DeployCenter\Settings"
  ${EndIf}
  DC_LocationReadDone:
  GetFullPathName $0 "$DC_DataRoot"
  ${If} $0 != $DC_DataRoot
    Goto DC_LocationInvalid
  ${EndIf}
  ${GetRoot} "$DC_DataRoot" $0
  ${If} $DC_DataRoot == ""
  ${OrIf} $DC_DataRoot == $0
  ${OrIf} "$0\" == $DC_DataRoot
  ${OrIf} $DC_DataRoot == $PROFILE
  ${OrIf} $DC_DataRoot == $APPDATA
  ${OrIf} $DC_DataRoot == $LOCALAPPDATA
  ${OrIf} $DC_DataRoot == $INSTDIR
    Goto DC_LocationInvalid
  ${EndIf}
  StrCpy $0 $DC_DataRoot
  DC_LocationAncestor:
    ${If} $0 == $WINDIR
    ${OrIf} $0 == $PROGRAMFILES
    ${OrIf} $0 == $PROGRAMFILES64
    ${OrIf} $0 == $INSTDIR
      Goto DC_LocationInvalid
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
    ${If} $1 != -1
      IntOp $1 $1 & 0x400
      ${If} $1 != 0
        Goto DC_LocationInvalid
      ${EndIf}
    ${EndIf}
    ${GetParent} "$0" $1
    ${If} $1 != ""
    ${AndIf} $1 != $0
      StrCpy $0 $1
      Goto DC_LocationAncestor
    ${EndIf}
  StrCpy $DC_PurgeError ""
  Push $DC_DataRoot
  Call ${PREFIX}DC_ValidateDataRoot
  ${If} $DC_PurgeError != ""
    Goto DC_LocationInvalid
  ${EndIf}
  StrCpy $DC_InstallerLogs "$DC_DataRoot\logs\installer"
  StrCpy $DC_InstallerBackups "$DC_DataRoot\installer-backups"
  Return
  DC_LocationInvalid:
  MessageBox MB_OK|MB_ICONSTOP "配置的数据目录不可用或包含链接：$DC_DataRoot$\r$\n已停止操作，不会把数据写回默认目录。" /SD IDOK
  SetErrorLevel 1603
  Abort
FunctionEnd
!macroend
