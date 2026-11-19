@echo off
REM ============================================================
REM  Inclusive Tech - Lanzador de servicios
REM  Doble clic para abrir el lanzador. Usa el python del venv
REM  de it_nav_system. Deja esta ventana abierta mientras lo uses.
REM ============================================================
cd /d "%~dp0"

set "PYTHON=..\backend\venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo No se encontro el entorno virtual del backend:
    echo   %PYTHON%
    echo Crea el venv de it_nav_system\backend antes de usar el lanzador.
    pause
    exit /b 1
)

"%PYTHON%" launcher.py
pause
