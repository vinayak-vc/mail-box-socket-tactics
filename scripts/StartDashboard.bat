@echo off
cd /d "%~dp0\.."
echo ===================================================================
echo   MailSocketTactics Control Center - Real-Time AI Team Dashboard
echo ===================================================================
echo Address: http://127.0.0.1:8766/
echo WebSocket: ws://127.0.0.1:8765/
echo.

start http://127.0.0.1:8766/
node src\service\ServiceRunner.js --all
pause
