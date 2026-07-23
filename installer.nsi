!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"

Name "SleepTimer"
OutFile "SleepTimer-Setup.exe"
InstallDir "D:\Program Files\SleepTimer"
RequestExecutionLevel admin
; ★ 默认走 GUI 向导；仅当带上 /S 参数（程序内"立即更新"自动安装）才静默安装
SilentInstall normal

Var chkDesktop
Var chkAuto
Var createDesktop
Var autoStart

; 运行检测：安装启动弹窗提示（见 .onInit -> CheckRunningAtStart）

; 卸载模式：0=保留配置，1=完全卸载
Var uninstMode
Var radioKeep
Var radioFull

!define MUI_FINISHPAGE_RUN "$INSTDIR\SleepTimer.exe"
!define MUI_FINISHPAGE_RUN_CHECKED
!define MUI_FINISHPAGE_RUN_TEXT "安装完成后立即运行 SleepTimer"

Function .onInit
  StrCpy $createDesktop 1
  StrCpy $autoStart 1
  Call CheckRunningAtStart
  ; ★ 静默更新（/S）：沿用上一次的安装目录，避免装到默认路径产生重复副本
  ${If} ${Silent}
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer" "InstallLocation"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---- 检测 SleepTimer 是否在运行，结果写入 $R0 (1=运行中) ----
; 方案：tasklist /FI 精确匹配映像名（避免子串误匹配其他进程），再经 find /I /C 统计行数。
; nsExec::ExecToStack 先压 stdout 再压退出码，故首个 Pop 是退出码、第二个 Pop 是输出计数。
; 仅当匹配到真正的 SleepTimer.exe 进程（计数>0）才判定为运行中。
Function IsRunning
  StrCpy $R0 0
  StrCpy $R9 ""  ; 命中进程的详细信息（含 PID），供弹窗展示让用户核对
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq SleepTimer.exe" /NH | find /I /C "SleepTimer.exe"'
  Pop $1  ; 退出码（find: 0=找到, 1=未找到）
  Pop $2  ; stdout：匹配到的 SleepTimer.exe 进程行数（如 "0" 或 "1"）
  ${If} $2 != "0"
    StrCpy $R0 1
    ; 抓取实际进程信息（CSV 格式，第二列为 PID）用于提示
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq SleepTimer.exe" /NH /FO CSV'
    Pop $3
    Pop $4
    StrCpy $R9 $4
  ${EndIf}
FunctionEnd

; ---- 强制结束运行中的 SleepTimer（三管齐下：taskkill + WMIC + 窗口标题匹配）----
Var killRetryCount
Function KillRunning
  ; 方法 1: taskkill 强杀（覆盖两种命名，/T 杀子进程树）
  nsExec::ExecToStack 'taskkill /F /T /IM SleepTimer.exe'
  nsExec::ExecToStack 'taskkill /F /T /IM sleeptimer.exe'
  Sleep 800
  ; 方法 2: WMIC terminate（绕过某些 taskkill 无法结束的情况）
  nsExec::ExecToStack 'wmic process where "name=''SleepTimer.exe'' or name=''sleeptimer.exe''" call terminate >nul 2>&1'
  Sleep 500
  ; 方法 3: 按窗口标题兜底（防止 exe 名被混淆）
  nsExec::ExecToStack 'taskkill /F /T /FI "WINDOWTITLE eq SleepTimer*" >nul 2>&1'
  Sleep 300
FunctionEnd

; ---- 安装启动：检测 → 提示 → 强制杀 → 重试/强制继续/取消 ----
Function CheckRunningAtStart
  ${If} ${Silent}
    Call KillRunning
    Return
  ${EndIf}
  StrCpy $killRetryCount 0
  Call IsRunning
  ${If} $R0 == 1
    retry_run:
    IntOp $killRetryCount $killRetryCount + 1
    ; 三按钮：中止=退出 | 重试=再杀 | 忽略=强制继续(默认穿透)
    MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION "检测到 SleepTimer 正在运行：$\n$R9$\n$\n请在任务管理器「详细信息」中按上述 PID 核对（右键托盘图标可退出）。$\n$\n「中止」退出安装 / 「重试」再尝试结束进程 / 「忽略」强制继续安装。" IDABORT do_abort IDRETRY do_kill
    ; ★ IDIGNORE（忽略）→ 穿透到此行：用户选择强制继续，最后尝试杀一次但不阻塞
    Goto do_force
    do_kill:
      Call KillRunning
      Sleep 500
      Call IsRunning
      ${If} $R0 == 1
        Goto retry_run
      ${EndIf}
      Return
    do_force:
      ; 用户选择强制继续：再尝试杀一次但不阻塞
      Call KillRunning
      Return
    do_abort:
      Abort
  ${EndIf}
FunctionEnd

; ---- 自定义选项页（在目录选择页之前）----
Function OptionsPage
  !insertmacro MUI_HEADER_TEXT "安装选项" "选择快捷方式与开机启动设置"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "请选择以下安装选项："
  Pop $0

  ${NSD_CreateCheckBox} 0 44u 100% 16u "创建桌面快捷方式"
  Pop $chkDesktop
  ${If} $createDesktop == 1
    ${NSD_Check} $chkDesktop
  ${EndIf}

  ${NSD_CreateCheckBox} 0 68u 100% 16u "随系统启动（开机自动运行 SleepTimer）"
  Pop $chkAuto
  ${If} $autoStart == 1
    ${NSD_Check} $chkAuto
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function OptionsLeave
  ${NSD_GetState} $chkDesktop $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $createDesktop 1
  ${Else}
    StrCpy $createDesktop 0
  ${EndIf}
  ${NSD_GetState} $chkAuto $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $autoStart 1
  ${Else}
    StrCpy $autoStart 0
  ${EndIf}
FunctionEnd

Page custom OptionsPage OptionsLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.UninstChoicePage
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ---- 卸载方式选择页 ----
Function un.onInit
  StrCpy $uninstMode 0
FunctionEnd

Function un.UninstChoicePage
  !insertmacro MUI_HEADER_TEXT "选择卸载方式" "保留配置或完全卸载"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "请选择卸载方式："
  Pop $0

  ${NSD_CreateRadioButton} 0 40u 100% 16u "保留配置卸载（保留设置与方案，删除程序）"
  Pop $radioKeep
  ${NSD_CreateRadioButton} 0 64u 100% 16u "完全卸载（删除所有文件、配置和注册表项）"
  Pop $radioFull

  ${If} $uninstMode == 1
    ${NSD_Check} $radioFull
  ${Else}
    ${NSD_Check} $radioKeep
  ${EndIf}

  ${NSD_OnClick} $radioKeep un.KeepSel
  ${NSD_OnClick} $radioFull un.FullSel
  nsDialogs::Show
FunctionEnd

Function un.KeepSel
  StrCpy $uninstMode 0
  ${NSD_Uncheck} $radioFull
FunctionEnd

Function un.FullSel
  StrCpy $uninstMode 1
  ${NSD_Uncheck} $radioKeep
FunctionEnd

Section "Install"
  ; 兜底：安装前再次确保没有运行中的实例占用文件
  Call KillRunning
  Sleep 1000   ; 等待 OS 释放被结束进程的 exe 文件锁，确保后续可直接替换
  SetOutPath "$INSTDIR"

  ClearErrors
  ; ★ 先探测目标文件是否可写：进程已结束（文件未锁）时可直接覆盖，
  ;   不创建临时文件、不重启；仅当确实写不进去（被占用）才走临时名+重启替换。
  FileOpen $0 "$INSTDIR\SleepTimer.exe" "a"
  ${If} ${Errors}
    ; 目标被占用，无法直接替换 → 才创建临时文件并登记重启后替换
    File /oname=SleepTimer.new.exe "src-tauri\target\release\sleeptimer.exe"
    Rename /REBOOTOK "$INSTDIR\SleepTimer.new.exe" "$INSTDIR\SleepTimer.exe"
  ${Else}
    FileClose $0
    ; 可直接替换 → 原样覆盖，干净利落（无 sleeptimer.new.exe、无重启）
    File /oname=SleepTimer.exe "src-tauri\target\release\sleeptimer.exe"
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\SleepTimer"
  CreateShortcut "$SMPROGRAMS\SleepTimer\SleepTimer.lnk" "$INSTDIR\SleepTimer.exe"
  CreateShortcut "$SMPROGRAMS\SleepTimer\卸载 SleepTimer.lnk" "$INSTDIR\Uninstall.exe"

  ${If} $createDesktop == 1
    CreateShortcut "$DESKTOP\SleepTimer.lnk" "$INSTDIR\SleepTimer.exe"
  ${EndIf}
  ${If} $autoStart == 1
    ; ★ 开机静默启动：附带 --silent 参数，仅驻留托盘、不显示主界面
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SleepTimer" '"$INSTDIR\SleepTimer.exe" --silent'
  ${EndIf}

  ; ★ 静默更新（/S）：安装完成后自动重启程序，使"立即更新"流程闭环
  ${If} ${Silent}
    Exec '"$INSTDIR\SleepTimer.exe"'
  ${EndIf}

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer" "DisplayName" "SleepTimer"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer" "DisplayIcon" "$INSTDIR\SleepTimer.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer" "Publisher" "Senior Developer"

  ; 若因文件被占用触发了"重启后替换"，提示用户（避免误以为装坏）
  IfRebootFlag 0 +2
    MessageBox MB_OK|MB_ICONINFORMATION "部分文件此前被占用，将在本次安装完成后于下次重启电脑时自动替换为新版本。如安装后程序异常，请重启一次即可。"

  ; ★ 仅“立即更新”自动安装（/S 静默）成功后清理下载包（update 文件夹）；
  ;   手动运行安装包（GUI）不删除，保留 update 目录交由用户自行处理。
  ;   安装程序自身已解压到临时目录运行，静默删除源 update 目录不会误删正在运行的安装程序。
  ${If} ${Silent}
    RMDir /r "$INSTDIR\update"
  ${EndIf}

SectionEnd

Section "Uninstall"
  ; 三管齐下强制结束运行中的进程，确保文件可删除
  nsExec::ExecToStack 'taskkill /F /T /IM SleepTimer.exe'
  nsExec::ExecToStack 'taskkill /F /T /IM sleeptimer.exe'
  nsExec::ExecToStack 'wmic process where "name=''SleepTimer.exe'' or name=''sleeptimer.exe''" call terminate >nul 2>&1'

  ${If} $uninstMode == 1
    ; 完全卸载：删除安装目录与本地数据
    RMDir /r "$INSTDIR"
    RMDir /r "$LOCALAPPDATA\SleepTimer"
  ${Else}
    ; 保留配置：仅删除程序与日志，保留 app.json
    ${If} ${FileExists} "$INSTDIR\config\app.json"
      Delete "$INSTDIR\SleepTimer.exe"
      Delete "$INSTDIR\Uninstall.exe"
      RMDir /r "$INSTDIR\log"
      RMDir "$INSTDIR"
    ${Else}
      RMDir /r "$INSTDIR"
    ${EndIf}
    ; 本地数据仅删日志，保留配置
    RMDir /r "$LOCALAPPDATA\SleepTimer\log"
  ${EndIf}

  Delete "$SMPROGRAMS\SleepTimer\SleepTimer.lnk"
  Delete "$SMPROGRAMS\SleepTimer\卸载 SleepTimer.lnk"
  RMDir "$SMPROGRAMS\SleepTimer"
  Delete "$DESKTOP\SleepTimer.lnk"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SleepTimer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SleepTimer"
SectionEnd
