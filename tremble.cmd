@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tremble.ps1" %*
exit /b %ERRORLEVEL%
