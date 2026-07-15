param(
    [string]$ProjectDirectory = (Get-Location).Path,
    [string]$JdkHome = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$result = [ordered]@{
    projectDirectory = (Resolve-Path -LiteralPath $ProjectDirectory).Path
    java = $null
    javaHome = $null
    javaVersion = $null
    java21 = $false
    javac = $null
    mavenWrapper = $false
    maven = $null
    git = $null
    status = 'PASS'
    issues = @()
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $JdkHome) {
    $localJdk = Get-ChildItem -LiteralPath (Join-Path $workspaceRoot 'tools') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^jdk-21' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($localJdk) { $JdkHome = $localJdk.FullName }
}

$javaExe = if ($JdkHome -and (Test-Path (Join-Path $JdkHome 'bin\java.exe'))) { Join-Path $JdkHome 'bin\java.exe' } else { (Get-Command java -ErrorAction SilentlyContinue).Source }
$javacExe = if ($JdkHome -and (Test-Path (Join-Path $JdkHome 'bin\javac.exe'))) { Join-Path $JdkHome 'bin\javac.exe' } else { (Get-Command javac -ErrorAction SilentlyContinue).Source }
if ($javaExe) {
    $result.java = $javaExe
    $result.javaHome = Split-Path (Split-Path $javaExe -Parent) -Parent
    $versionInfo = New-Object System.Diagnostics.ProcessStartInfo
    $versionInfo.FileName = $javaExe
    $versionInfo.Arguments = '-version'
    $versionInfo.UseShellExecute = $false
    $versionInfo.RedirectStandardError = $true
    $versionProcess = [System.Diagnostics.Process]::Start($versionInfo)
    $versionText = $versionProcess.StandardError.ReadToEnd()
    $versionProcess.WaitForExit()
    $result.javaVersion = (($versionText -split "`r?`n" | Where-Object { $_ }) | Select-Object -First 1).Trim()
    $result.java21 = $result.javaVersion -match 'version "21'
    if (-not $result.java21) { $result.issues += 'Java 21 was not selected; configure JdkHome or install JDK 21.' }
} else {
    $result.issues += 'java was not found; install JDK 21 LTS.'
}

if (-not $javacExe) {
    $result.issues += 'javac was not found; a full JDK is required.'
} else {
    $result.javac = $javacExe
}

$wrapper = Join-Path $result.projectDirectory 'mvnw.cmd'
$result.mavenWrapper = Test-Path -LiteralPath $wrapper
if (-not $result.mavenWrapper) {
    $result.issues += 'mvnw.cmd was not found; use Maven Wrapper for a pinned build.'
}

$mavenCommand = Get-Command mvn -ErrorAction SilentlyContinue
if ($mavenCommand) {
    $result.maven = $mavenCommand.Source
} else {
    $localMaven = Get-ChildItem -LiteralPath (Join-Path $workspaceRoot 'tools') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^apache-maven-' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($localMaven -and (Test-Path (Join-Path $localMaven.FullName 'bin\mvn.cmd'))) { $result.maven = Join-Path $localMaven.FullName 'bin\mvn.cmd' }
}
if (-not $result.maven -and $result.mavenWrapper) { $result.maven = $wrapper }
if (-not $result.maven) { $result.issues += 'Maven and Maven Wrapper were not found.' }

if (Get-Command git) {
    $result.git = (Get-Command git).Source
} else {
    $result.issues += 'Git was not found; version control checks are limited.'
}

if ($result.issues.Count -gt 0) { $result.status = 'WARN' }
$result | ConvertTo-Json -Depth 4
if ($result.status -eq 'WARN') { exit 2 }
