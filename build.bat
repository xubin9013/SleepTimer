@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ============================================================
echo   SleepTimer build script
echo   (Rust compile + frontend embed + NSIS installer)
echo ============================================================
echo.

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] cargo not found. Install Rust toolchain from https://rustup.rs
  goto fail
)
where node >nul 2>&1
if not errorlevel 1 goto node_ok

echo [WARN] node not found on PATH, probing common install dirs...
set "FOUND_NODE="
for %%D in (
  "C:\Program Files\nodejs"
  "C:\Program Files (x86)\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
  "%ProgramFiles%\nodejs"
  "C:\ProgramData\chocolatey\bin"
  "%LOCALAPPDATA%\Volta\bin"
  "%APPDATA%\nvm"
) do (
  if not defined FOUND_NODE if exist "%%~D\node.exe" set "FOUND_NODE=%%~D"
)
if defined FOUND_NODE (
  echo [OK] node found at %FOUND_NODE%, adding to PATH for this session.
  set "PATH=%FOUND_NODE%;%PATH%"
  goto node_ok
)
echo [ERROR] node not found. Install Node.js (https://nodejs.org) or add its dir to PATH.
goto fail
:node_ok

echo [1/4] Touch build.rs to force Cargo rerun (bumps same-day build counter)...
copy /b "src-tauri\build.rs" +,, >nul 2>&1

echo [2/4] Clean dist...
if exist dist rmdir /s /q dist >nul 2>&1

echo [3/4] cargo tauri build --no-bundle ...
cargo tauri build --no-bundle > build.log 2>&1
if errorlevel 1 (
  echo [ERROR] cargo build failed. See build.log for details.
  goto fail
)

echo [4/4] Package installer with NSIS...
set "MAKENSIS=makensis.exe"
if exist "nsis-tools\tools\makensis.exe" set "MAKENSIS=nsis-tools\tools\makensis.exe"

"%MAKENSIS%" installer.nsi >> build.log 2>&1
if errorlevel 1 (
  echo [WARN] Default output name locked, retrying with a timestamped name...
  "%MAKENSIS%" /DINSTALLER_NAME=SleepTimer-Setup-%RANDOM%.exe installer.nsi >> build.log 2>&1
  if errorlevel 1 (
    echo [ERROR] Packaging failed. See build.log.
    goto fail
  )
)

echo.
echo ============================================================
echo   Build complete.
echo   Output: SleepTimer-Setup.exe (or a timestamped variant)
echo ============================================================
goto done

:fail
echo.
echo Build failed. Check build.log for the full error output.
pause
exit /b 1

:done
pause
