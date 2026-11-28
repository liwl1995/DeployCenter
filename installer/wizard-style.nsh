!ifndef DC_WIZARD_STYLE_INCLUDED
!define DC_WIZARD_STYLE_INCLUDED

Var DC_WizardDark
Var DC_WizardDpi
Var DC_WizardWidth
Var DC_WizardBodyHeight
Var DC_WizardFooterLine

; 原型尺寸按 96 DPI 设计，原生窗口按当前显示缩放换算。
!macro DC_WizardScale REGISTER VALUE
  IntOp ${REGISTER} $DC_WizardDpi * ${VALUE}
  IntOp ${REGISTER} ${REGISTER} / 96
!macroend

!macro DC_WizardColors CONTROL LIGHT_TEXT LIGHT_BG DARK_TEXT DARK_BG
  ${If} $DC_WizardDark == 1
    SetCtlColors ${CONTROL} "${DARK_TEXT}" "${DARK_BG}"
  ${ElseIf} $DC_WizardDark == 0
    SetCtlColors ${CONTROL} "${LIGHT_TEXT}" "${LIGHT_BG}"
  ${EndIf}
!macroend

!macro DC_WizardAnchor CONTROL
  GetDlgItem $0 $HWNDPARENT ${CONTROL}
  ${If} $0 != 0
    System::Call 'user32::SetWindowPos(pr0,p0,i0,i0,i $DC_WizardWidth,i $DC_WizardBodyHeight,i0x14)'
  ${EndIf}
!macroend

!macro DC_WizardHide CONTROL
  GetDlgItem $0 $HWNDPARENT ${CONTROL}
  ShowWindow $0 ${SW_HIDE}
!macroend

!macro DC_WizardPage CONTROL
  System::Call 'user32::SetWindowPos(p ${CONTROL},p0,i0,i0,i $DC_WizardWidth,i $DC_WizardBodyHeight,i0x14)'
  !insertmacro DC_WizardColors ${CONTROL} "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
!macroend

!macro DC_WizardStyleFunctions PREFIX
Function ${PREFIX}DC_InitializeWizardStyle
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  StrCpy $DC_WizardDark 0
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
  ${IfNot} ${Errors}
  ${AndIf} $0 == 0
    StrCpy $DC_WizardDark 1
  ${EndIf}
  ; 高对比度模式继续使用 Windows 的系统画法。
  System::Call '*(i12,i0,p0)p.r0'
  System::Call 'user32::SystemParametersInfoW(i0x42,i12,pr0,i0)i.r1'
  System::Call '*$0(i,i.r2,p)'
  System::Free $0
  IntOp $2 $2 & 1
  ${If} $1 != 0
  ${AndIf} $2 != 0
    StrCpy $DC_WizardDark -1
  ${EndIf}
  ${If} $DC_WizardDark == 1
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i20,*i1,i4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i34,*i0x463E3E,i4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i35,*i0x181616,i4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i36,*i0xB3ABAB,i4)'
  ${ElseIf} $DC_WizardDark == 0
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i34,*i0xE9E3E3,i4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i35,*i0xF7F5F5,i4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i36,*i0x5B5252,i4)'
  ${EndIf}
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.s'
  Pop $DC_WizardDpi
  ${If} $DC_WizardDpi == 0
    StrCpy $DC_WizardDpi 96
  ${EndIf}
  !insertmacro DC_WizardScale $6 540
  !insertmacro DC_WizardScale $7 400
  System::Call '*(i0,i0,i0,i0)p.r5'
  System::Call 'user32::GetWindowRect(p $HWNDPARENT,pr5)'
  System::Call '*$5(i.r1,i.r2,i.r3,i.r4)'
  IntOp $1 $1 + $3
  IntOp $1 $1 - $6
  IntOp $1 $1 / 2
  IntOp $2 $2 + $4
  IntOp $2 $2 - $7
  IntOp $2 $2 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT,p0,ir1,ir2,ir6,ir7,i0x14)'
  System::Call 'user32::GetClientRect(p $HWNDPARENT,pr5)'
  System::Call '*$5(i,i,i.r6,i.r7)'
  System::Free $5
  StrCpy $DC_WizardWidth $6
  !insertmacro DC_WizardScale $0 56
  IntOp $DC_WizardBodyHeight $7 - $0
  !insertmacro DC_WizardAnchor 1018
  !insertmacro DC_WizardAnchor 1044
  Call ${PREFIX}DC_StyleWizardFrame
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}DC_StyleWizardFrame
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  !insertmacro DC_WizardHide 1028
  !insertmacro DC_WizardHide 1034
  !insertmacro DC_WizardHide 1035
  !insertmacro DC_WizardHide 1036
  !insertmacro DC_WizardHide 1037
  !insertmacro DC_WizardHide 1038
  !insertmacro DC_WizardHide 1039
  !insertmacro DC_WizardHide 1045
  !insertmacro DC_WizardHide 1256
  ${If} $DC_WizardDark != -1
    !insertmacro DC_WizardColors $HWNDPARENT "18181B" "FFFFFF" "E4E4E7" "1C1C1E"
  ${EndIf}
  ${If} $DC_WizardFooterLine == ""
    System::Call 'user32::CreateWindowExW(i0,w "STATIC",w "",i0x50000000,i0,i $DC_WizardBodyHeight,i $DC_WizardWidth,i1,p $HWNDPARENT,p1993,p0,p0)p.s'
    Pop $DC_WizardFooterLine
    !insertmacro DC_WizardColors $DC_WizardFooterLine "E3E3E9" "E3E3E9" "3E3E46" "3E3E46"
  ${EndIf}
  !insertmacro DC_WizardScale $1 16
  !insertmacro DC_WizardScale $2 13
  IntOp $2 $DC_WizardBodyHeight + $2
  !insertmacro DC_WizardScale $3 68
  !insertmacro DC_WizardScale $4 36
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:取消"
  System::Call 'user32::SetWindowPos(pr0,p0,ir1,ir2,ir3,ir4,i0x14)'
  !insertmacro DC_WizardScale $3 88
  IntOp $5 $DC_WizardWidth - $1
  IntOp $5 $5 - $3
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::SetWindowPos(pr0,p0,ir5,ir2,ir3,ir4,i0x14)'
  !insertmacro DC_WizardScale $6 4
  IntOp $5 $5 - $6
  !insertmacro DC_WizardScale $3 80
  IntOp $5 $5 - $3
  GetDlgItem $0 $HWNDPARENT 3
  SendMessage $0 ${WM_SETTEXT} 0 "STR:上一步"
  System::Call 'user32::SetWindowPos(pr0,p0,ir5,ir2,ir3,ir4,i0x14)'
  Push 2
  Call ${PREFIX}DC_StyleWizardButton
  Push 3
  Call ${PREFIX}DC_StyleWizardButton
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${PREFIX}DC_StyleWizardPrimary
  Push 1
  Call ${PREFIX}DC_StyleWizardButton
FunctionEnd

Function ${PREFIX}DC_StyleWizardButton
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrCpy $R4 $0
  ${If} $DC_WizardDark == -1
    Goto dc_wizard_button_done
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT $R4
  ${If} $0 == 0
    Goto dc_wizard_button_done
  ${EndIf}
  System::Call 'user32::GetWindowTextW(pr0,w .r1,i128)'
  StrCpy $R0 0x1673F9
  StrCpy $R1 0x1B1818
  StrCpy $R2 0xFFFFFF
  ${If} $DC_WizardDark == 1
    StrCpy $R0 0x0C58EA
    StrCpy $R1 0xFFFFFF
    StrCpy $R2 0x1E1C1C
  ${EndIf}
  ${If} $R4 != 1
    ${If} $DC_WizardDark == 1
      StrCpy $R0 0x332E2E
      StrCpy $R1 0xE7E4E4
    ${Else}
      StrCpy $R0 0xFFFFFF
      StrCpy $R1 0x1B1818
    ${EndIf}
  ${EndIf}
  System::Call 'user32::IsWindowEnabled(pr0)i.r2'
  ${If} $2 == 0
    ${If} $DC_WizardDark == 1
      StrCpy $R0 0x2A2626
      StrCpy $R1 0xA29A9A
    ${Else}
      StrCpy $R0 0xF2EFEF
      StrCpy $R1 0x6E6565
    ${EndIf}
  ${EndIf}
  ; 只替换可见图像，保留原生按钮句柄、文字、焦点、命令和可用状态。
  System::Call 'user32::GetDC(pr0)p.r2'
  System::Call 'gdi32::CreateCompatibleDC(pr2)p.r3'
  !insertmacro DC_WizardScale $4 84
  ${If} $R4 == 2
    !insertmacro DC_WizardScale $4 64
  ${ElseIf} $R4 == 3
    !insertmacro DC_WizardScale $4 76
  ${EndIf}
  !insertmacro DC_WizardScale $5 32
  System::Call 'gdi32::CreateCompatibleBitmap(pr2,ir4,ir5)p.r6'
  ${If} $3 != 0
  ${AndIf} $6 != 0
    System::Call 'gdi32::SelectObject(pr3,pr6)p.r7'
    System::Call '*(i0,i0,ir4,ir5)p.r8'
    System::Call 'gdi32::CreateSolidBrush(i $R2)p.r9'
    System::Call 'user32::FillRect(pr3,pr8,pr9)'
    System::Call 'gdi32::DeleteObject(pr9)'
    System::Call 'gdi32::CreateSolidBrush(i $R0)p.r9'
    System::Call 'gdi32::SelectObject(pr3,pr9)p.R3'
    StrCpy $R5 0
    ${If} $R4 == 1
      System::Call 'gdi32::GetStockObject(i8)p.R0'
    ${Else}
      StrCpy $R0 0xD6CFCF
      ${If} $DC_WizardDark == 1
        StrCpy $R0 0x524A4A
      ${EndIf}
      System::Call 'gdi32::CreatePen(i0,i1,i R0)p.R0'
      StrCpy $R5 $R0
    ${EndIf}
    System::Call 'gdi32::SelectObject(pr3,p R0)p.R2'
    !insertmacro DC_WizardScale $R0 12
    System::Call 'gdi32::RoundRect(pr3,i0,i0,ir4,ir5,i R0,i R0)'
    System::Call 'gdi32::SelectObject(pr3,p R2)'
    System::Call 'gdi32::SelectObject(pr3,p R3)'
    ${If} $R5 != 0
      System::Call 'gdi32::DeleteObject(p R5)'
    ${EndIf}
    System::Call 'gdi32::DeleteObject(pr9)'
    SendMessage $0 ${WM_GETFONT} 0 0 $R3
    ${If} $R3 != 0
      System::Call 'gdi32::SelectObject(pr3,p R3)'
    ${EndIf}
    System::Call 'gdi32::SetBkMode(pr3,i1)'
    System::Call 'gdi32::SetTextColor(pr3,i R1)'
    System::Call 'user32::DrawTextW(pr3,wr1,i-1,pr8,i0x25)'
    System::Free $8
    System::Call 'gdi32::SelectObject(pr3,pr7)'
    ; 通过窗口样式切换到位图模式。BM_SETSTYLE 会让部分主题同时绘制原按钮文字。
    System::Call 'user32::GetWindowLongW(pr0,i-16)i.R5'
    IntOp $R5 $R5 & 0xFFFFFFBF
    IntOp $R5 $R5 | 0x80
    System::Call 'user32::SetWindowLongW(pr0,i-16,i R5)'
    SendMessage $0 0xF7 0 $6 $R4
    ; 位图覆盖实际可见区域，裁去系统按钮在位图外侧绘制的边框。
    !insertmacro DC_WizardScale $R0 2
    IntOp $4 $4 + $R0
    IntOp $5 $5 + $R0
    !insertmacro DC_WizardScale $R1 12
    System::Call 'gdi32::CreateRoundRectRgn(i R0,i R0,ir4,ir5,i R1,i R1)p.R2'
    ${If} $R2 != 0
      System::Call 'user32::SetWindowRgn(pr0,p R2,i1)i.R3'
      ${If} $R3 == 0
        System::Call 'gdi32::DeleteObject(p R2)'
      ${EndIf}
    ${EndIf}
    System::Call 'user32::InvalidateRect(pr0,p0,i1)'
    ${If} $R4 != 0
      System::Call 'gdi32::DeleteObject(p R4)'
    ${EndIf}
  ${ElseIf} $6 != 0
    System::Call 'gdi32::DeleteObject(pr6)'
  ${EndIf}
  ${If} $3 != 0
    System::Call 'gdi32::DeleteDC(pr3)'
  ${EndIf}
  ${If} $2 != 0
    System::Call 'user32::ReleaseDC(pr0,pr2)'
  ${EndIf}
  dc_wizard_button_done:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!endif
