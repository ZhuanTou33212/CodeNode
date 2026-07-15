param([string]$JavaHome = "")
$ErrorActionPreference = "Stop"
if ($JavaHome) { $env:JAVA_HOME = $JavaHome }
$jpackage = Join-Path $env:JAVA_HOME "bin\jpackage.exe"
if (-not (Test-Path -LiteralPath $jpackage)) { throw "Java 21 jpackage not found: $jpackage" }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dist = [IO.Path]::GetFullPath((Join-Path $projectRoot "dist"))
if (-not $dist.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe dist path: $dist" }
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
& $jpackage --type app-image --name CodeNodeDesktop --dest $dist --input (Join-Path $PSScriptRoot "..\target") --main-jar codenode-desktop.jar --main-class local.codenode.CodeNodeApp --app-version 0.3.0 --vendor CodeNode
if ($LASTEXITCODE -ne 0) { throw "jpackage failed: $LASTEXITCODE" }
Write-Host (Join-Path $dist "CodeNodeDesktop\CodeNodeDesktop.exe")
