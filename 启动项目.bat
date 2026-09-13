@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title 启动项目 - %~nx0

if exist package.json goto node_project
if exist requirements.txt goto python_project
if exist pyproject.toml goto python_project
if exist main.py goto python_main
if exist app.py goto python_app
if exist index.html goto static_project

echo 未能自动识别项目入口。
echo 请确认项目目录中存在 package.json、main.py、app.py 或 index.html。
pause
exit /b 1

:node_project
where npm >nul 2>nul
if errorlevel 1 (
    echo 未找到 Node.js/npm，请先安装 Node.js。
    pause
    exit /b 1
)
if not exist node_modules (
    echo 正在安装项目依赖，请稍候...
    call npm install
    if errorlevel 1 goto failed
)
echo 正在启动 Node.js 项目...
call npm run dev
if errorlevel 1 (
    echo dev 命令不存在或启动失败，尝试 npm start...
    call npm start
)
goto end

:python_project
where py >nul 2>nul
if errorlevel 1 goto python_check
if exist .venv\Scripts\python.exe goto python_venv
echo 正在创建 Python 虚拟环境...
py -m venv .venv
if errorlevel 1 goto failed
goto python_install

:python_check
where python >nul 2>nul
if errorlevel 1 (
    echo 未找到 Python，请先安装 Python。
    pause
    exit /b 1
)
if exist .venv\Scripts\python.exe goto python_venv
echo 正在创建 Python 虚拟环境...
python -m venv .venv
if errorlevel 1 goto failed

:python_install
call .venv\Scripts\activate.bat
if exist requirements.txt pip install -r requirements.txt
if exist pyproject.toml pip install -e .
if errorlevel 1 goto failed
goto python_run

:python_venv
call .venv\Scripts\activate.bat
goto python_run

:python_run
if exist main.py goto python_main
if exist app.py goto python_app
echo 已安装依赖，但没有找到 main.py 或 app.py。
pause
exit /b 1

:python_main
where py >nul 2>nul
if not errorlevel 1 (py main.py) else (python main.py)
goto end

:python_app
where py >nul 2>nul
if not errorlevel 1 (py app.py) else (python app.py)
goto end

:static_project
start "" "%~dp0index.html"
goto end

:failed
echo 项目启动失败，请查看上面的错误信息。
pause
exit /b 1

:end
echo.
echo 项目已退出。
pause
endlocal
