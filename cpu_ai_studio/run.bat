@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python не найден — устанавливаю автоматически через winget...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  echo.
  echo Python установлен. Закройте это окно и запустите run.bat ещё раз.
  pause
  exit /b
)
python launcher.py
if errorlevel 1 pause
