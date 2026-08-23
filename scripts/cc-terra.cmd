@echo off
rem Open the consolidated model gateway defaulting to gpt-5.6-terra.
setlocal
set "MODEL_GATEWAY_DEFAULT=gpt-5.6-terra"
call "%USERPROFILE%\.local\bin\cc.cmd" %*
exit /b %ERRORLEVEL%
