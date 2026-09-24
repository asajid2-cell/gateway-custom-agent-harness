@echo off
rem Optional convenience alias; plain cc is the canonical command.
setlocal
set "MODEL_GATEWAY_DEFAULT=gpt-6-luna"
call "%USERPROFILE%\.local\bin\cc.cmd" %*
exit /b %ERRORLEVEL%
