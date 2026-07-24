Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrStr}
!include "${PAYLOAD_DEFINES}"

Name "数模工坊 ${PRODUCT_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\MathModelingWorkbench"
InstallDirRegKey HKCU "Software\MathModelingWorkbench" "InstallLocation"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"

VIProductVersion "${PRODUCT_VERSION_QUAD}"
VIAddVersionKey /LANG=2052 "ProductName" "数模工坊"
VIAddVersionKey /LANG=2052 "FileDescription" "数模工坊模块化安装程序"
VIAddVersionKey /LANG=2052 "CompanyName" "kstt"
VIAddVersionKey /LANG=2052 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${PRODUCT_VERSION}"

!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\app\数模工坊.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动数模工坊"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "!核心程序（必选）" SEC_CORE
  SectionIn RO
  AddSize ${CORE_SIZE_KB}

  nsExec::ExecToStack '"$SYSDIR\certutil.exe" -hashfile "$EXEDIR\packages\${CORE_FILE}" SHA256'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 core_hash_failed
  ${StrStr} $2 $1 "${CORE_SHA256}"
  StrCmp $2 "" core_hash_failed core_hash_ok

  core_hash_failed:
    FileOpen $3 "$TEMP\MathModelingWorkbench-Installer.log" w
    FileWrite $3 "stage=core-hash$\r$\nexit=$0$\r$\nexpected=${CORE_SHA256}$\r$\noutput=$1$\r$\n"
    FileClose $3
    MessageBox MB_ICONSTOP|MB_OK "核心程序包校验失败，安装已停止。"
    SetErrorLevel 2
    Quit

  core_hash_ok:
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "数模工坊.exe" /T /F'
    Pop $0
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "MathModelingWorkbench.runtime.exe" /T /F'
    Pop $0
    RMDir /r "$INSTDIR\app"
    CreateDirectory "$INSTDIR\app"

    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=7za.exe "${SEVEN_ZIP_EXE}"
    SetOutPath "$INSTDIR"
    File /oname=payload-manifest.json "${PAYLOAD_MANIFEST}"

    nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -aoa -o"$INSTDIR\app" "$EXEDIR\packages\${CORE_FILE}"'
    Pop $0
    StrCmp $0 "0" core_extract_ok
    MessageBox MB_ICONSTOP|MB_OK "核心程序安装失败，错误代码：$0"
    SetErrorLevel 2
    Quit

  core_extract_ok:
    FileOpen $0 "$INSTDIR\components.ini" w
    FileWrite $0 "[components]$\r$\ncore=1$\r$\n"
    FileClose $0
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "Software\MathModelingWorkbench" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "DisplayName" "数模工坊"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "DisplayVersion" "${PRODUCT_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "Publisher" "kstt"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "DisplayIcon" "$INSTDIR\app\数模工坊.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench" "NoRepair" 1
SectionEnd

SectionGroup "可选运行组件" SEC_RUNTIME_GROUP
  Section "科学计算组件（推荐）" SEC_PYTHON
    AddSize ${PYTHON_SIZE_KB}
    nsExec::ExecToStack '"$SYSDIR\certutil.exe" -hashfile "$EXEDIR\packages\${PYTHON_FILE}" SHA256'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 python_hash_failed
    ${StrStr} $2 $1 "${PYTHON_SHA256}"
    StrCmp $2 "" python_hash_failed python_hash_ok
    python_hash_failed:
      MessageBox MB_ICONSTOP|MB_OK "科学计算组件校验失败，安装已停止。"
      SetErrorLevel 2
      Quit
    python_hash_ok:
      CreateDirectory "$INSTDIR\app\resources\runtime"
      nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -aoa -o"$INSTDIR\app\resources\runtime" "$EXEDIR\packages\${PYTHON_FILE}"'
      Pop $0
      StrCmp $0 "0" python_extract_ok
      MessageBox MB_ICONSTOP|MB_OK "科学计算组件安装失败，错误代码：$0"
      SetErrorLevel 2
      Quit
    python_extract_ok:
      FileOpen $0 "$INSTDIR\components.ini" a
      FileWrite $0 "python=1$\r$\n"
      FileClose $0
  SectionEnd

  Section "论文编译组件（推荐）" SEC_TECTONIC
    AddSize ${TECTONIC_SIZE_KB}
    nsExec::ExecToStack '"$SYSDIR\certutil.exe" -hashfile "$EXEDIR\packages\${TECTONIC_FILE}" SHA256'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 tectonic_hash_failed
    ${StrStr} $2 $1 "${TECTONIC_SHA256}"
    StrCmp $2 "" tectonic_hash_failed tectonic_hash_ok
    tectonic_hash_failed:
      MessageBox MB_ICONSTOP|MB_OK "论文编译组件校验失败，安装已停止。"
      SetErrorLevel 2
      Quit
    tectonic_hash_ok:
      CreateDirectory "$INSTDIR\app\resources\runtime"
      nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -aoa -o"$INSTDIR\app\resources\runtime" "$EXEDIR\packages\${TECTONIC_FILE}"'
      Pop $0
      StrCmp $0 "0" tectonic_extract_ok
      MessageBox MB_ICONSTOP|MB_OK "论文编译组件安装失败，错误代码：$0"
      SetErrorLevel 2
      Quit
    tectonic_extract_ok:
      FileOpen $0 "$INSTDIR\components.ini" a
      FileWrite $0 "tectonic=1$\r$\n"
      FileClose $0
  SectionEnd
SectionGroupEnd

Section "桌面与开始菜单快捷方式" SEC_SHORTCUTS
  CreateDirectory "$SMPROGRAMS\数模工坊"
  CreateShortcut "$SMPROGRAMS\数模工坊\数模工坊.lnk" "$INSTDIR\app\数模工坊.exe" "" "$INSTDIR\app\数模工坊.exe"
  CreateShortcut "$SMPROGRAMS\数模工坊\卸载数模工坊.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\数模工坊.lnk" "$INSTDIR\app\数模工坊.exe" "" "$INSTDIR\app\数模工坊.exe"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "数模工坊.exe" /T /F'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "MathModelingWorkbench.runtime.exe" /T /F'
  Pop $0
  Delete "$DESKTOP\数模工坊.lnk"
  RMDir /r "$SMPROGRAMS\数模工坊"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\components.ini"
  Delete "$INSTDIR\payload-manifest.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\MathModelingWorkbench"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MathModelingWorkbench"
SectionEnd

Function .onInit
  FileOpen $9 "$TEMP\MathModelingWorkbench-Installer.log" w
  FileWrite $9 "stage=init$\r$\n"
  IfFileExists "$EXEDIR\packages\${CORE_FILE}" core_exists core_missing
  core_missing:
    FileWrite $9 "missing=core$\r$\n"
    FileClose $9
    MessageBox MB_ICONSTOP|MB_OK "安装套件不完整：缺少核心程序包。"
    SetErrorLevel 2
    Quit
  core_exists:
  IfFileExists "$EXEDIR\packages\${PYTHON_FILE}" python_exists python_missing
  python_missing:
    FileWrite $9 "missing=python$\r$\n"
    FileClose $9
    MessageBox MB_ICONSTOP|MB_OK "安装套件不完整：缺少科学计算组件。"
    SetErrorLevel 2
    Quit
  python_exists:
  IfFileExists "$EXEDIR\packages\${TECTONIC_FILE}" tectonic_exists tectonic_missing
  tectonic_missing:
    FileWrite $9 "missing=tectonic$\r$\n"
    FileClose $9
    MessageBox MB_ICONSTOP|MB_OK "安装套件不完整：缺少论文编译组件。"
    SetErrorLevel 2
    Quit

  tectonic_exists:
  FileWrite $9 "packages=complete$\r$\n"
  FileClose $9
  Delete "$TEMP\MathModelingWorkbench-Installer.log"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/COREONLY" $R1
  IfErrors core_only_done
    SectionSetFlags ${SEC_PYTHON} 0
    SectionSetFlags ${SEC_TECTONIC} 0
  core_only_done:
  ${GetOptions} $R0 "/NOSHORTCUTS" $R1
  IfErrors no_shortcuts_done
    SectionSetFlags ${SEC_SHORTCUTS} 0
  no_shortcuts_done:
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "桌面界面、项目工作区与受保护的任务执行核心。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PYTHON} "提供数据处理、优化、绘图和表格处理能力。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_TECTONIC} "提供离线 LaTeX 编译、中文字体与资源缓存。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHORTCUTS} "创建桌面和开始菜单入口。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END
