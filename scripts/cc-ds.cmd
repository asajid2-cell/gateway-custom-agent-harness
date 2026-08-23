@echo off
rem Open the consolidated model gateway defaulting to deepseek-v4-flash.
setlocal
set "MODEL_GATEWAY_DEFAULT=deepseek-v4-flash"
call "%USERPROFILE%\.local\bin\cc.cmd" %*
exit /b %ERRORLEVEL%
