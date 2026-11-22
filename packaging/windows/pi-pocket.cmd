@echo off
rem Starts the Pi Pocket launcher with the Node.js and the npm prefix that the installer put beside this file.
rem The Start menu and the sign-in shortcuts run it; arguments go to pi-pocket (pi-pocket --help lists them).
setlocal
set "NPM_CONFIG_PREFIX=%~dp0app"
set "NPM_CONFIG_CACHE=%~dp0npm-cache"
set "NPM_CONFIG_UPDATE_NOTIFIER=false"
set "PATH=%~dp0node;%~dp0app;%PATH%"
title Pi Pocket
"%~dp0node\node.exe" "%~dp0app\node_modules\pi-pocket\bin\pi-pocket.js" %*
set "code=%errorlevel%"
if "%code%"=="0" exit /b 0
if "%code%"=="130" exit /b 130
echo.
echo Pi Pocket stopped with exit code %code%.
pause
exit /b %code%
