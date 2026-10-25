@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Установите Python 3.10+ с python.org и поставьте галочку "Add to PATH" & pause & exit /b 1)
if not exist .venv (
  echo Первый запуск: создаю окружение и ставлю библиотеки, это займёт несколько минут...
  python -m venv .venv || (pause & exit /b 1)
  call .venv\Scripts\activate.bat
  python -m pip install --upgrade pip
  pip install torch --index-url https://download.pytorch.org/whl/cpu || (pause & exit /b 1)
  pip install -r requirements.txt || (pause & exit /b 1)
) else (
  call .venv\Scripts\activate.bat
)
python app.py
if errorlevel 1 pause
