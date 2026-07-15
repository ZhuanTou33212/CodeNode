$ErrorActionPreference = "Stop"
$exe = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\dist\CodeNodeDesktop\CodeNodeDesktop.exe")).Path
$process = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
if ($process.HasExited) { throw "CodeNodeDesktop exited early with code $($process.ExitCode)" }
Stop-Process -Id $process.Id -Force
Write-Host "CodeNodeDesktop launch smoke test passed (PID $($process.Id))"
