param([string]$JavaHome = "")
$ErrorActionPreference = "Stop"
if ($JavaHome) { $env:JAVA_HOME = $JavaHome }
$jpackage = Join-Path $env:JAVA_HOME "bin\jpackage.exe"
if (-not (Test-Path -LiteralPath $jpackage)) { throw "Java 21 jpackage not found: $jpackage" }
if (-not (Get-Command candle.exe -ErrorAction SilentlyContinue)) { throw "WiX Toolset 3 is required to build the Windows installer" }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installer = [IO.Path]::GetFullPath((Join-Path $projectRoot "installer"))
if (-not $installer.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe installer path: $installer" }
if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Recurse -Force }
& $jpackage --type exe --name CodeNodeDesktop --dest $installer --input (Join-Path $projectRoot "target") --main-jar codenode-desktop.jar --main-class local.codenode.CodeNodeApp --app-version 0.1.5 --vendor CodeNode --file-associations (Join-Path $PSScriptRoot "cnode-associations.properties")
if ($LASTEXITCODE -ne 0) { throw "jpackage installer failed: $LASTEXITCODE" }
