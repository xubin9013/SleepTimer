@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   SleepTimer 一键构建脚本
echo   （Rust 编译 + 前端嵌入 + NSIS 安装包）
echo ============================================================
echo.

:: 0) 工具链检查
where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 cargo，请先安装 Rust 工具链（https://rustup.rs）
  goto :fail
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 node，前端构建需要 Node.js
  goto :fail
)

:: 1) 强制更新 build.rs 时间戳，使 Cargo 每次都重跑构建脚本
::    -> 否则 Cargo 会缓存 build 脚本，当天构建次数永远不递增
echo [1/4] 触发 build.rs 重跑（递增当天构建次数）...
powershell -NoProfile -Command "(Get-Item 'src-tauri\build.rs').LastWriteTime = Get-Date" 2>nul

:: 2) 清理前端产物
echo [2/4] 清理 dist...
if exist dist rmdir /s /q dist 2>nul

:: 3) 编译 Rust 并嵌入前端
echo [3/4] cargo tauri build --no-bundle ...
cargo tauri build --no-bundle
if errorlevel 1 (
  echo [ERROR] cargo 构建失败
  goto :fail
)

:: 4) 打包安装程序（NSIS）
echo [4/4] 打包安装程序...
set "MAKENSIS=nsis-tools\tools\makensis.exe"
if not exist "%MAKENSIS%" set "MAKENSIS=makensis.exe"

set "OUTNAME=SleepTimer-Setup.exe"
if exist "SleepTimer-Setup.exe" (
  del /F /Q "SleepTimer-Setup.exe" 2>nul
  if exist "SleepTimer-Setup.exe" (
    set "HH=%TIME:~0,2%"
    set "HH=!HH: =0!"
    set "STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~6,2%-!HH!%TIME:~3,2%"
    set "OUTNAME=SleepTimer-Setup-!STAMP!.exe"
    echo [4/4] 旧安装包被占用，改用输出名：!OUTNAME!
  )
)

if "!OUTNAME!"=="SleepTimer-Setup.exe" (
  "%MAKENSIS%" installer.nsi
) else (
  "%MAKENSIS%" /DINSTALLER_NAME=!OUTNAME! installer.nsi
)
if errorlevel 1 (
  echo [ERROR] 安装包打包失败（若提示文件被占用，请关闭占用进程后重试）
  goto :fail
)

echo.
echo ============================================================
echo   构建完成！
echo   输出文件：!OUTNAME!
if exist "src-tauri\target\.build_count" (
  set /p BC=<src-tauri\target\.build_count
  echo   构建计数：!BC!
)
echo ============================================================
goto :done

:fail
echo.
echo 构建失败，请检查上方错误信息。
pause
exit /b 1

:done
pause
