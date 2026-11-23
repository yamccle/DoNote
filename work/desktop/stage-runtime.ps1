<#
[INPUT]: 读取发布锁定文件和已保存的 Windows 运行依赖包。
[OUTPUT]: 将固定版本的运行依赖提取到干净的发布目录。
[POS]: 桌面构建准备步骤，只从旧包读取依赖。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
param(
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../../docs/releases/runtime-lock.json') | ConvertFrom-Json
$digest = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne $lock.sha256) { throw "运行依赖包的 SHA-256 不匹配，要求版本 $($lock.version)。" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Output).TrimEnd([IO.Path]::DirectorySeparatorChar)
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$required = @(
    'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll',
    'docs/licenses/LICENSE.txt', 'docs/licenses/NOTICE.txt', 'docs/licenses/MINERU-LICENSE.md',
    'ai-bridge/node.exe', 'ai-bridge/Node-LICENSE.txt'
)
$code = '^(video-runtime/(workers|pdfmathtranslate-src|bilingual-book-maker-src)/)'
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try {
    foreach ($path in $required) {
        if ($null -eq $zip.GetEntry($path)) { throw "运行依赖包缺少 $path。" }
    }
    foreach ($entry in $zip.Entries) {
        $relative = $entry.FullName
        if (!$entry.Name -or ($relative -notin $required -and
            ($relative -notlike 'video-runtime/*' -or $relative -match $code -or $relative -match '/__pycache__/'))) { continue }
        $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $relative.Contains(':')) {
            throw "运行依赖包路径无效 $relative。"
        }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
    }
} finally {
    $zip.Dispose()
}
if (!(Test-Path -LiteralPath (Join-Path $root 'video-runtime/python.exe') -PathType Leaf)) {
    throw '运行依赖包缺少 Python。'
}
$digest
