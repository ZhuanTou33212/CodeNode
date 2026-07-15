param(
  [string]$Source = "E:\CodeNode\CodeNode\codenode",
  [string]$Target = "C:\Users\1\plugins\codenode"
)
$ErrorActionPreference = "Stop"
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$targetPath = (Resolve-Path -LiteralPath $Target).Path
if ($sourcePath -ne "E:\CodeNode\CodeNode\codenode" -or $targetPath -ne "C:\Users\1\plugins\codenode") { throw "Plugin path verification failed" }
Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $targetPath -Recurse -Force
$obsolete = @((Join-Path $targetPath ".mcp.json"), (Join-Path $targetPath "mcp\server.mjs"))
foreach ($file in $obsolete) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
Get-Content -Raw -Encoding UTF8 (Join-Path $targetPath ".codex-plugin\plugin.json")
$obsolete | ForEach-Object { [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ } }
