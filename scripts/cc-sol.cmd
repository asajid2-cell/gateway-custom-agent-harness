@echo off
rem Open the consolidated model gateway defaulting to gateway-gpt-6-sol (Codex).
setlocal
set "MODEL_GATEWAY_DEFAULT=gateway-gpt-6-sol"
call "%USERPROFILE%\.local\bin\cc.cmd" %*
exit /b %ERRORLEVEL%
