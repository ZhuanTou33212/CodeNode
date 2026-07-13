param(
    [string]$ProjectDirectory = (Join-Path $PSScriptRoot '..\..\..\java-node-demo'),
    [string]$JdkHome = '',
    [string]$MavenUserHome = ''
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectDirectory).Path
if (-not $JdkHome) {
    $workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
    $jdk = Get-ChildItem -LiteralPath (Join-Path $workspaceRoot 'tools') -Directory |
        Where-Object { $_.Name -match '^jdk-21' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($jdk) { $JdkHome = $jdk.FullName }
}
if (-not $JdkHome -or -not (Test-Path (Join-Path $JdkHome 'bin\java.exe'))) { throw 'JDK 21 was not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $project 'mvnw.cmd'))) { throw "Maven Wrapper was not found in $project." }

$env:JAVA_HOME = (Resolve-Path -LiteralPath $JdkHome).Path
if ($MavenUserHome) {
    $resolvedMavenUserHome = Resolve-Path -LiteralPath $MavenUserHome -ErrorAction SilentlyContinue
    $env:MAVEN_USER_HOME = if ($resolvedMavenUserHome) { $resolvedMavenUserHome.Path } else { $MavenUserHome }
}
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$versionInfo = New-Object System.Diagnostics.ProcessStartInfo
$versionInfo.FileName = (Join-Path $env:JAVA_HOME 'bin\java.exe')
$versionInfo.Arguments = '-version'
$versionInfo.UseShellExecute = $false
$versionInfo.RedirectStandardError = $true
$versionProcess = [System.Diagnostics.Process]::Start($versionInfo)
$versionText = $versionProcess.StandardError.ReadToEnd()
$versionProcess.WaitForExit()
Write-Output ((($versionText -split "`r?`n" | Where-Object { $_ }) | Select-Object -First 1).Trim())
Push-Location $project
try {
    & cmd.exe /d /c 'mvnw.cmd -B test'
    if ($LASTEXITCODE -ne 0) { throw "Maven Wrapper tests failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}
