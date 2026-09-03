@echo off
setlocal
set "MINUTES="
set /p "MINUTES=Shared camera minutes (1-10080, default 30; 10080 = 7 days): "
if not defined MINUTES set "MINUTES=30"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-SharedCamera.ps1" -Minutes "%MINUTES%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
