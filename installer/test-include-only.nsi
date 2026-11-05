Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "YOTOO 清理模块安装阶段编译验收"
OutFile "${OUTPUT_FILE}"
!include LogicLib.nsh
!include FileFunc.nsh
!include "${PROJECT_DIR}\installer\data-cleanup.nsh"
Section
  SetErrorLevel 0
SectionEnd
