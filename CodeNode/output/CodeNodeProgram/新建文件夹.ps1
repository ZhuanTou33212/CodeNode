param(
    [string]$FolderName = 'CodeNodeFolder'
)

# Use USERPROFILE instead of a .NET static call for Windows PowerShell 5.1 compatibility.
$desktop = Join-Path $env:USERPROFILE 'Desktop'
if (-not (Test-Path -LiteralPath $desktop)) {
    throw 'Desktop folder was not found for the current user.'
}

$target = Join-Path $desktop $FolderName
New-Item -ItemType Directory -Path $target -Force | Out-Null
Write-Output "Created folder: $target"
