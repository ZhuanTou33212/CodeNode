@echo off
setlocal
cd /d "%~dp0"
set "TARGET=%~dp0启动项目.bat"
set "LINK=%USERPROFILE%\Desktop\CodeNode.lnk"
set "WORKDIR=%~dp0"
set "ICON=%~dp0build\icon.ico"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($env:LINK); $s.TargetPath = $env:TARGET; $s.WorkingDirectory = $env:WORKDIR; $s.Description = 'CodeNode'; if (Test-Path -LiteralPath $env:ICON) { $s.IconLocation = $env:ICON + ',0' }; $s.Save()"

if exist "%LINK%" (
    echo 已创建桌面快捷方式：CodeNode.lnk
) else (
    echo 创建失败，请直接双击“启动项目.bat”。
)
pause
endlocal
