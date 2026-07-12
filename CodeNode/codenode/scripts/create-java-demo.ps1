param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) {
    $existing = @(Get-ChildItem -Force -LiteralPath $target)
    if ($existing.Count -gt 0) { throw "Target directory is not empty: $target" }
} else {
    New-Item -ItemType Directory -Path $target | Out-Null
}

$src = Join-Path $target 'src\main\java\codenode\demo'
$test = Join-Path $target 'src\test\java\codenode\demo'
New-Item -ItemType Directory -Force -Path $src, $test | Out-Null

$pom = @(
'<?xml version="1.0" encoding="UTF-8"?>'
'<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">'
'  <modelVersion>4.0.0</modelVersion>'
'  <groupId>codenode.demo</groupId>'
'  <artifactId>java-node-demo</artifactId>'
'  <version>0.1.0</version>'
'  <properties>'
'    <maven.compiler.release>21</maven.compiler.release>'
'    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>'
'    <junit.version>5.10.2</junit.version>'
'  </properties>'
'  <dependencies>'
'    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>${junit.version}</version><scope>test</scope></dependency>'
'  </dependencies>'
'  <build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build>'
'</project>'
)
$pom | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $target 'pom.xml')

$main = @(
'package codenode.demo;'
''
'public final class AddIntegers {'
'    private AddIntegers() {}'
''
'    public static int execute(int left, int right) {'
'        return left + right;'
'    }'
'}'
)
$main | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $src 'AddIntegers.java')

$testCode = @(
'package codenode.demo;'
''
'import static org.junit.jupiter.api.Assertions.assertEquals;'
'import org.junit.jupiter.api.Test;'
''
'class AddIntegersTest {'
'    @Test'
'    void addsTwoInputs() {'
'        assertEquals(7, AddIntegers.execute(3, 4));'
'    }'
'}'
)
$testCode | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $test 'AddIntegersTest.java')

$readme = @(
'# CodeNode Java demo'
''
'This is the first-stage Java node example: left and right inputs connect to AddIntegers and produce result.'
''
'Run in an environment with Maven installed:'
''
'    mvn test'
''
'The plugin does not embed Maven Wrapper binaries. In a real project, commit an audited mvnw, .mvn/wrapper, and pinned Maven version.'
)
$readme | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $target 'README.md')

Write-Output "Created Java demo at $target"
