@echo off
setlocal
title AI Canvas - local preview
cd /d "%~dp0"

set "PORT=8777"

echo.
echo  ================================================
echo    AI Canvas   -   local preview server
echo  ================================================
echo.

rem ---- find a free port, starting from 8777 ----
:findport
netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  set /a PORT=%PORT%+1
  goto findport
)

rem ---- pick a python ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
  where py >nul 2>nul && set "PY=py"
)

if not defined PY goto :fileonly

echo   Folder : %CD%
echo   URL    : http://127.0.0.1:%PORT%/
echo.
echo   Your browser will open in 2 seconds.
echo   Keep this window open while you work.
echo   Close it, or press Ctrl+C, to stop the server.
echo.

start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:%PORT%/"
%PY% -m http.server %PORT% --bind 127.0.0.1
goto :done

:fileonly
echo   Python was not found, so the page will be opened directly.
echo   Note: over file:// the browser console hides real error
echo   messages, and saved data shares space with other local pages.
echo.
start "" "%~dp0index.html"
timeout /t 3 /nobreak >nul
goto :done

:done
echo.
echo   Server stopped.
pause