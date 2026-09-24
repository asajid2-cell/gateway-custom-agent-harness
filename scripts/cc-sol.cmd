@echo off
rem Open the consolidated model gateway defaulting to gpt-6-sol (Codex).
setlocal
set "MODEL_GATEWAY_DEFAULT=gpt-6-sol"
call "%USERPROFILE%\.local\bin\cc.cmd" %*
exit /b %ERRORLEVEL%
