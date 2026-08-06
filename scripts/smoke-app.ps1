param([string]$AppRoot = "", [switch]$GracefulClose)
$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $AppRoot) { $AppRoot = Join-Path $projectRoot "dist\CodeNodeDesktop" }
$resolvedRoot = [IO.Path]::GetFullPath($AppRoot)
if (-not $resolvedRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe app path: $resolvedRoot" }
$exe = (Resolve-Path -LiteralPath (Join-Path $resolvedRoot "CodeNodeDesktop.exe")).Path
$windowStyle = if ($GracefulClose) { "Normal" } else { "Hidden" }
$process = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle $windowStyle -PassThru
Start-Sleep -Seconds 2
if ($process.HasExited) { throw "CodeNodeDesktop exited early with code $($process.ExitCode)" }
if ($GracefulClose) {
    $process.WaitForInputIdle(5000) | Out-Null
    $process.Refresh()
    $windowProcess = Get-Process -Name CodeNodeDesktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -eq $windowProcess -or -not $windowProcess.CloseMainWindow()) { Get-Process -Name CodeNodeDesktop -ErrorAction SilentlyContinue | Where-Object Path -eq $exe | Stop-Process -Force; throw "CodeNodeDesktop did not accept a window-close request" }
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    do { Start-Sleep -Milliseconds 100; $remaining = Get-Process -Name CodeNodeDesktop -ErrorAction SilentlyContinue | Where-Object Path -eq $exe } while ($remaining -and [DateTime]::UtcNow -lt $deadline)
    if ($remaining) { $remaining | Stop-Process -Force; throw "CodeNodeDesktop remained in the background after its window closed" }
    Write-Host "CodeNodeDesktop graceful shutdown test passed (PID $($process.Id))"
} else {
    Stop-Process -Id $process.Id -Force
    Write-Host "CodeNodeDesktop launch smoke test passed (PID $($process.Id))"
}
