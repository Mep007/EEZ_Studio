@echo off
setlocal

cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "EEZ_DEV_ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
set "EEZ_DEV_USER_DATA=%LOCALAPPDATA%\EEZ Studio MEP Fork Dev"
set "EEZ_DEV_APP=%CD%"

if not exist "%EEZ_DEV_ELECTRON%" (
    echo Local Electron executable not found:
    echo %EEZ_DEV_ELECTRON%
    echo Run npm install first.
    pause
    exit /b 1
)

if not exist "%~dp0build\main\main.js" (
    echo Local EEZ Studio build not found.
    echo Run npm run build-src first.
    pause
    exit /b 1
)

"%EEZ_DEV_ELECTRON%" ^
    --user-data-dir="%EEZ_DEV_USER_DATA%" ^
    --trace-warnings ^
    --trace-deprecation ^
    "%EEZ_DEV_APP%"
