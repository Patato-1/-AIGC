@echo off
setlocal
title AI Canvas - servers

rem ============================================================
rem  Only starts the servers. No browser, no prompts.
rem  Use this when you just want the canvas back up.
rem ============================================================

cd /d "%~dp0"

set "PORT=8777"
set "UPORT=8778"

rem ---- find free ports ----
:findport
netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  set /a PORT=%PORT%+1
  goto findport
)
:finduport
netstat -ano | findstr /c:":%UPORT% " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  set /a UPORT=%UPORT%+1
  goto finduport
)

rem ---- pick a python ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
  where py >nul 2>nul && set "PY=py"
)
if not defined PY (
  echo.
  echo   Python not found. Install Python first.
  echo.
  pause
  exit /b 1
)

echo.
echo  ================================================
echo    AI Canvas - servers
echo  ================================================
echo.
echo   Canvas : http://127.0.0.1:%PORT%/
echo   Upload : http://127.0.0.1:%UPORT%/api/health
echo.
echo   Close this window to stop both servers.
echo.

rem ---- canvas (foreground: closing this window stops everything) ----
if exist "%~dp0server.py" (
  start "AI Canvas upload" /min cmd /c %PY% "%~dp0upload_server.py" %UPORT%
  %PY% "%~dp0server.py" %PORT%
) else (
  start "AI Canvas upload" /min cmd /c %PY% "%~dp0upload_server.py" %UPORT%
  %PY% -m http.server %PORT% --bind 127.0.0.1
)

echo.
echo   Canvas server stopped.
pause