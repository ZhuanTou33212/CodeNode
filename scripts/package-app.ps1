param([string]$JavaHome = "", [string]$Destination = "")
$ErrorActionPreference = "Stop"
if ($JavaHome) { $env:JAVA_HOME = $JavaHome }
$jpackage = Join-Path $env:JAVA_HOME "bin\jpackage.exe"
if (-not (Test-Path -LiteralPath $jpackage)) { throw "Java 21 jpackage not found: $jpackage" }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dist = if ($Destination) { [IO.Path]::GetFullPath($Destination) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot "dist")) }
if (-not $dist.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe dist path: $dist" }
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
# Stage only the app jar into a temp dir so jpackage does not sweep the whole target/ (classes, surefire-reports, ...) into the image.
$staging = Join-Path $env:TEMP "codenode-package-input"
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "target\codenode-desktop.jar") -Destination $staging
& $jpackage --type app-image --name CodeNodeDesktop --dest $dist --input $staging --main-jar codenode-desktop.jar --main-class local.codenode.CodeNodeApp --app-version 0.1.5 --vendor CodeNode
Remove-Item -LiteralPath $staging -Recurse -Force
if ($LASTEXITCODE -ne 0) { throw "jpackage failed: $LASTEXITCODE" }
Write-Host (Join-Path $dist "CodeNodeDesktop\CodeNodeDesktop.exe")
