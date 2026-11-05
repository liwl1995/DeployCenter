; 两阶段校验：先核对数据位置和归属，再拒绝路径祖先及目录树内的所有重解析点。
; 供卸载器和隔离验收程序复用；只使用 Win32/NSIS 原生能力，不启动 PowerShell。
!macro DC_DataCleanupFunctions PREFIX
Var DC_PurgeError
Function ${PREFIX}DC_CheckDataTree
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r3'
  ${If} $3 == -1
    StrCpy $DC_PurgeError "无法读取路径，已保留：$0"
    Goto DC_CheckTreeDone
  ${EndIf}
  IntOp $2 $3 & 0x400
  ${If} $2 != 0
    StrCpy $DC_PurgeError "目录包含链接或联接，已保留：$0"
    Goto DC_CheckTreeDone
  ${EndIf}
  IntOp $2 $3 & 0x10
  ${If} $2 != 0
    FindFirst $1 $2 "$0\*.*"
    DC_CheckTreeLoop:
      ${If} $2 == ""
        Goto DC_CheckTreeClose
      ${EndIf}
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        Push "$0\$2"
        Call ${PREFIX}DC_CheckDataTree
        ${If} $DC_PurgeError != ""
          Goto DC_CheckTreeClose
        ${EndIf}
      ${EndIf}
      FindNext $1 $2
      Goto DC_CheckTreeLoop
    DC_CheckTreeClose:
    FindClose $1
  ${EndIf}
  DC_CheckTreeDone:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}DC_ValidateDataRoot
  Exch $0
  Push $1
  Push $2
  Push $3
  ${If} $0 == ""
    Goto DC_ValidateRootDone
  ${EndIf}
  GetFullPathName $1 "$0"
  ${If} $1 != $0
    StrCpy $DC_PurgeError "目录路径不是完整规范路径，已保留：$0"
    Goto DC_ValidateRootDone
  ${EndIf}
  ${GetRoot} "$0" $1
  ${If} $1 == $0
  ${OrIf} "$1\" == $0
  ${OrIf} $0 == $PROFILE
  ${OrIf} $0 == $DESKTOP
  ${OrIf} $0 == $DOCUMENTS
  ${OrIf} $0 == $APPDATA
  ${OrIf} $0 == $LOCALAPPDATA
  ${OrIf} $0 == $INSTDIR
    StrCpy $DC_PurgeError "拒绝清理系统或用户根目录：$0"
    Goto DC_ValidateRootDone
  ${EndIf}
  StrLen $1 "$WINDIR"
  StrCpy $2 $0 $1
  ${If} $2 == $WINDIR
    StrCpy $DC_PurgeError "拒绝清理 Windows 目录：$0"
    Goto DC_ValidateRootDone
  ${EndIf}
  StrLen $1 "$PROGRAMFILES"
  StrCpy $2 $0 $1
  ${If} $2 == $PROGRAMFILES
    StrCpy $DC_PurgeError "拒绝清理程序目录：$0"
    Goto DC_ValidateRootDone
  ${EndIf}
  StrLen $1 "$PROGRAMFILES64"
  StrCpy $2 $0 $1
  ${If} $2 == $PROGRAMFILES64
    StrCpy $DC_PurgeError "拒绝清理程序目录：$0"
    Goto DC_ValidateRootDone
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
  ${If} $1 == -1
    Goto DC_ValidateRootDone
  ${EndIf}
  ${If} $0 != "$APPDATA\DeployCenter"
  ${AndIf} $0 != "$LOCALAPPDATA\DeployCenter\Settings"
    ReadINIStr $1 "$0\.yotoo-data-owner.ini" "application" "id"
    ${If} $1 != "local.deploycenter.desktop"
      StrCpy $DC_PurgeError "无法确认数据目录归属，已保留：$0"
      Goto DC_ValidateRootDone
    ${EndIf}
  ${EndIf}
  StrCpy $1 $0
  DC_ValidateAncestor:
    System::Call 'kernel32::GetFileAttributesW(w r1)i.r2'
    IntOp $3 $2 & 0x400
    ${If} $2 == -1
    ${OrIf} $3 != 0
      StrCpy $DC_PurgeError "目录祖先不可读或包含链接，已保留：$0"
      Goto DC_ValidateRootDone
    ${EndIf}
    ${GetParent} "$1" $2
    ${If} $2 != ""
    ${AndIf} $2 != $1
      StrCpy $1 $2
      Goto DC_ValidateAncestor
    ${EndIf}
  Push $0
  Call ${PREFIX}DC_CheckDataTree
  DC_ValidateRootDone:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}DC_RemoveDataRoot
  Exch $0
  Push $1
  ${If} $DC_PurgeError == ""
  ${AndIf} $0 != ""
    Push $0
    Call ${PREFIX}DC_ValidateDataRoot
    ${If} $DC_PurgeError == ""
      ClearErrors
      RMDir /r "$0"
      IfFileExists "$0\*.*" 0 +2
      StrCpy $DC_PurgeError "部分文件被占用或权限不足，已保留：$0"
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd
!macroend
