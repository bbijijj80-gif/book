@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv call run.bat
call .venv\Scripts\activate.bat
pip install pyinstaller
pyinstaller --noconfirm --windowed --name CPU_AI_Studio --collect-all customtkinter --collect-all datasets --collect-all tokenizers app.py
echo Готово: dist\CPU_AI_Studio\CPU_AI_Studio.exe
pause
