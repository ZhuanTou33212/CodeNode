param(
    [string]$FolderName = 'CodeNode新建文件夹'
)

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop)) {
    throw '无法确定当前用户的桌面路径。'
}

$target = Join-Path $desktop $FolderName
New-Item -ItemType Directory -Path $target -Force | Out-Null
Write-Output "已创建文件夹：$target"
