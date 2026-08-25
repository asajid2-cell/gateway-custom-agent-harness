@echo off
rem Open the consolidated model gateway defaulting to deepseek-v4-pro.
setlocal
set "MODEL_GATEWAY_DEFAULT=deepseek-v4-pro"
call "%USERPROFILE%\.local\bin\cc.cmd" %*
exit /b %ERRORLEVEL%
