Unicode true

!include "FileFunc.nsh"

Name "数模工坊"
OutFile "${LAUNCHER_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
CRCCheck on
Icon "${ICON_FILE}"

VIProductVersion "${PRODUCT_VERSION_QUAD}"
VIAddVersionKey /LANG=2052 "ProductName" "数模工坊"
VIAddVersionKey /LANG=2052 "FileDescription" "数模工坊启动入口"
VIAddVersionKey /LANG=2052 "CompanyName" "kstt"
VIAddVersionKey /LANG=2052 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${PRODUCT_VERSION}"

Section
  IfFileExists "$EXEDIR\MathModelingWorkbench.runtime.exe" runtime_exists runtime_missing
  runtime_missing:
    MessageBox MB_ICONSTOP|MB_OK "核心程序文件缺失，请重新运行安装程序进行修复。"
    SetErrorLevel 2
    Quit
  runtime_exists:
    ${GetParameters} $0
    Exec '"$EXEDIR\MathModelingWorkbench.runtime.exe" $0'
SectionEnd
