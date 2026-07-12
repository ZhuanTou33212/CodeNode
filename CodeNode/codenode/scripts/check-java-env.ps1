param(
    [string]$ProjectDirectory = (Get-Location).Path
)

$ErrorActionPreference = 'SilentlyContinue'
$result = [ordered]@{
    projectDirectory = (Resolve-Path -LiteralPath $ProjectDirectory).Path
    java = $null
    javaVersion = $null
    javac = $null
    mavenWrapper = $false
    git = $null
    status = 'PASS'
    issues = @()
}

$javaCommand = Get-Command java
if ($javaCommand) {
    $result.java = $javaCommand.Source
    $result.javaVersion = (& java -version 2>&1 | Select-Object -First 1).ToString()
} else {
    $result.issues += 'java was not found; install JDK 21 LTS.'
}

if (-not (Get-Command javac)) {
    $result.issues += 'javac was not found; a full JDK is required.'
} else {
    $result.javac = (Get-Command javac).Source
}

$wrapper = Join-Path $result.projectDirectory 'mvnw.cmd'
$result.mavenWrapper = Test-Path -LiteralPath $wrapper
if (-not $result.mavenWrapper) {
    $result.issues += 'mvnw.cmd was not found; use Maven Wrapper for a pinned build.'
}

if (Get-Command git) {
    $result.git = (Get-Command git).Source
} else {
    $result.issues += 'Git was not found; version control checks are limited.'
}

if ($result.issues.Count -gt 0) { $result.status = 'WARN' }
$result | ConvertTo-Json -Depth 4
if ($result.status -eq 'WARN') { exit 2 }
