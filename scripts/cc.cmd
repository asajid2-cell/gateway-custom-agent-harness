@echo off
setlocal
set "CC_SCRIPT=Z:\328\CMPUT328-A2\codexworks\301\workrepo\claudex\scripts\cc.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CC_SCRIPT%" %*
exit /b %ERRORLEVEL%
