@echo off
setlocal
set "CC_SCRIPT=%~dp0cc.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CC_SCRIPT%" %*
exit /b %ERRORLEVEL%
