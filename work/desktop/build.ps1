<#
[INPUT]: 读取正式源码和桌面运行依赖。
[OUTPUT]: 构建桌面程序和带文件校验值的发布目录。
[POS]: 桌面构建入口，由发行脚本从干净的 Git 提交调用。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
[CmdletBinding(DefaultParameterSetName='Sdk')]
param(
    [Parameter(Mandatory=$true,ParameterSetName='Sdk')][string]$WebView2Sdk,
    [Parameter(Mandatory=$true,ParameterSetName='Archive')][string]$RuntimeArchive,
    [Parameter(Mandatory=$true)][string]$Output,
    [switch]$FreshStart,
    [switch]$DataMigration,
    [string]$ReleaseVersion = '26.1109.0003',
    [string]$SourceCommit
)
$ErrorActionPreference = 'Stop'
[void][Version]::Parse($ReleaseVersion)
$Output = [IO.Path]::GetFullPath($Output)
$project = Join-Path $PSScriptRoot '../analog-notes'
$assets = Join-Path $Output 'workspace'
$workspaceAssets = Join-Path $assets 'assets'
$docs = Join-Path $Output 'docs'
$legal = Join-Path $docs 'licenses'
$pythonWorkers = Join-Path $Output 'video-runtime\workers'
$bridgeWorkers = Join-Path $Output 'ai-bridge\workers'
$tools = Join-Path $Output 'tools'
$null = New-Item -ItemType Directory -Force $Output, $assets, $workspaceAssets, $docs, $legal, $pythonWorkers, $bridgeWorkers, $tools
$node = 'node'
if ($RuntimeArchive) {
    $runtimeSha256 = & (Join-Path $PSScriptRoot 'stage-runtime.ps1') -Archive $RuntimeArchive -Output $Output
    $sdkLib = $Output
    $node = Join-Path $Output 'ai-bridge/node.exe'
} else {
    $WebView2Sdk = (Resolve-Path -LiteralPath $WebView2Sdk).Path
    $sdkLib = Join-Path $WebView2Sdk 'lib/net462'
}
$freshMarker = Join-Path $Output 'fresh-start.marker'
if ($FreshStart) { [IO.File]::WriteAllText($freshMarker, 'DoNote fresh start') }
elseif (Test-Path -LiteralPath $freshMarker) { Remove-Item -LiteralPath $freshMarker }

Add-Type -AssemblyName System.Drawing
$logo = [Drawing.Image]::FromFile((Resolve-Path (Join-Path $project 'public/brand-logo.png')).Path)
$iconPath = Join-Path $Output 'DoNote.ico'
$stream = [IO.File]::Create($iconPath)
$writer = [IO.BinaryWriter]::new($stream)
try {
    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $images = foreach ($size in $sizes) {
        $canvas = [Drawing.Bitmap]::new($size, $size)
        $graphics = [Drawing.Graphics]::FromImage($canvas)
        $png = [IO.MemoryStream]::new()
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scale = $size / [Math]::Max($logo.Width, $logo.Height)
            $width = [int]($logo.Width * $scale)
            $height = [int]($logo.Height * $scale)
            $graphics.DrawImage($logo, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
            $canvas.Save($png, [Drawing.Imaging.ImageFormat]::Png)
            ,$png.ToArray()
        } finally {
            $png.Dispose()
            $graphics.Dispose()
            $canvas.Dispose()
        }
    }
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = [byte]($sizes[$i] % 256)
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$images[$i].Length)
        $writer.Write([UInt32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image) }
} finally {
    $writer.Dispose()
    $logo.Dispose()
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$core = Join-Path $sdkLib 'Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $sdkLib 'Microsoft.Web.WebView2.WinForms.dll'
$captionResources = @(
    "/resource:$PSScriptRoot\caption-wordmark.png,DoNote.CaptionWordmark.png"
    "/resource:$PSScriptRoot\caption-wordmark-dark.png,DoNote.CaptionWordmark.Dark.png"
)
& $csc /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$Output\DoNote.exe" "/win32icon:$iconPath" "/win32manifest:$PSScriptRoot\app.manifest" @captionResources /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Net.Http.dll /reference:System.Security.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/reference:$core" "/reference:$forms" "$PSScriptRoot\Program.cs" "$PSScriptRoot\VideoTranscribe.cs" "$PSScriptRoot\VideoSubtitleTranslation.cs" "$PSScriptRoot\AiCredentials.cs" "$PSScriptRoot\AiModelServices.cs" "$PSScriptRoot\AiCredentialStore.cs" "$PSScriptRoot\WindowChrome.cs" "$PSScriptRoot\WebPageWindow.cs" "$PSScriptRoot\TranslationProviders.cs" "$PSScriptRoot\LocalLlmTranslation.cs" "$PSScriptRoot\LargeBackup.cs" "$PSScriptRoot\MinerUReflow.cs" "$PSScriptRoot\DocumentTranslation.cs" "$PSScriptRoot\InstallationLayoutMigration.cs" "$PSScriptRoot\LocalUpdate.cs" "$PSScriptRoot\UpdatePackage.cs"
if ($LASTEXITCODE -ne 0) { throw 'Desktop compilation failed.' }
& $csc /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$Output\DoNoteUpdater.exe" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "$PSScriptRoot\UpdateHost.cs" "$PSScriptRoot\UpdatePackage.cs"
if ($LASTEXITCODE -ne 0) { throw 'Updater compilation failed.' }
Copy-Item -LiteralPath $iconPath -Destination $workspaceAssets
Remove-Item -LiteralPath $iconPath
if (!$RuntimeArchive) {
    Copy-Item -LiteralPath $core,$forms,(Join-Path $WebView2Sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $Output
    Copy-Item -LiteralPath (Join-Path $WebView2Sdk 'LICENSE.txt'),(Join-Path $WebView2Sdk 'NOTICE.txt') -Destination $legal
}
foreach ($file in 'JSZip-LICENSE.md','Marked-LICENSE.md','PDFJS-LICENSE.txt','ppt-preview-LICENSES.txt','Readability-LICENSE.md','pdf-lib-LICENSE.md','sha256-LICENSE.txt','MiniSearch-LICENSE.txt','CitationJS-LICENSES.txt') {
    Copy-Item -LiteralPath (Join-Path $project "public/$file") -Destination $legal
}
& $node (Join-Path $project 'scripts/build-desktop-workspace.mjs') $assets
if ($LASTEXITCODE -ne 0) { throw 'Offline workspace build failed.' }
$index = Join-Path $assets 'index.html'
$settings = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'desktop-settings.html')).Replace('{{DONOTE_VERSION}}',$ReleaseVersion)
$html = [IO.File]::ReadAllText($index)
$html = $html.Insert($html.IndexOf('</head>', [StringComparison]::Ordinal), '<link rel="stylesheet" href="startup-splash.css"><link rel="stylesheet" href="desktop-settings.css">')
$html = $html.Insert($html.LastIndexOf('</body>', [StringComparison]::Ordinal), $settings + '<script src="startup-wordmark.js"></script><script src="startup-splash.js"></script><script src="desktop-settings.js"></script><script src="desktop-translation.js"></script><script src="desktop-large-backup.js"></script>')
[IO.File]::WriteAllText($index, $html)
foreach ($file in 'startup-splash.css','startup-wordmark.js','startup-splash.js','desktop-settings.css','desktop-settings.js','desktop-translation.js','desktop-large-backup.js') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $assets
}
Copy-Item -LiteralPath (Join-Path $project 'public/NotoSansSC-OFL.txt') -Destination $legal
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'analog-flashcard.png') -Destination $assets
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ai-face.gif') -Destination $workspaceAssets
if (!$RuntimeArchive) {
    $videoRuntime = Join-Path $PSScriptRoot '../video-runtime-build/runtime'
    if (!(Test-Path -LiteralPath (Join-Path $videoRuntime 'python.exe'))) { throw 'Video Python runtime missing.' }
    $videoRuntimeTarget = Join-Path $Output 'video-runtime'
    $null = New-Item -ItemType Directory -Force $videoRuntimeTarget
    Get-ChildItem -LiteralPath $videoRuntime -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $videoRuntimeTarget -Recurse -Force
    }
    $videoDeps = Join-Path $PSScriptRoot '../video-runtime-build/dependencies'
    if (!(Test-Path -LiteralPath (Join-Path $videoDeps 'faster_whisper'))) { throw 'Offline video recognition dependencies missing.' }
    Copy-Item -LiteralPath $videoDeps -Destination (Join-Path $Output 'video-runtime/dependencies') -Recurse -Force
    foreach ($folder in 'translation-en-zh','translation-dependencies') {
        $source = Join-Path $PSScriptRoot "../video-runtime-build/$folder"
        Copy-Item -LiteralPath $source -Destination (Join-Path $Output "video-runtime/$folder") -Recurse -Force
    }
    $mineruDependencies = Join-Path $PSScriptRoot '../video-runtime-build/mineru-dependencies'
    if (!(Test-Path -LiteralPath (Join-Path $mineruDependencies 'mineru'))) { throw 'MinerU runtime missing.' }
    $mineruTarget = Join-Path $Output 'video-runtime\mineru-dependencies'
    $null = New-Item -ItemType Directory -Force $mineruTarget
    Get-ChildItem -LiteralPath $mineruDependencies -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $mineruTarget -Recurse -Force
    }
    foreach ($folder in 'pdfmathtranslate-dependencies','bbmd') {
        $source = Join-Path $PSScriptRoot "../video-runtime-build/$folder"
        if (!(Test-Path -LiteralPath $source)) { throw "Document translation runtime missing: $folder" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $Output "video-runtime/$folder") -Recurse -Force
    }
    $babeldocCache = Join-Path $PSScriptRoot '../video-runtime-build/babeldoc-cache'
    $fontSource = Join-Path $PSScriptRoot '../video-runtime-build/fonts'
    if (!(Test-Path -LiteralPath (Join-Path $babeldocCache 'models/doclayout_yolo_docstructbench_imgsz1024.onnx'))) {
        throw 'PDFMathTranslate layout model missing.'
    }
    if (!(Test-Path -LiteralPath (Join-Path $fontSource 'SourceHanSerifCN-Regular.ttf'))) {
        throw 'PDFMathTranslate Chinese font missing.'
    }
    Copy-Item -LiteralPath $babeldocCache -Destination (Join-Path $Output 'video-runtime/babeldoc-cache') -Recurse -Force
    Copy-Item -LiteralPath $fontSource -Destination (Join-Path $Output 'video-runtime/fonts') -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $mineruDependencies 'mineru-4.2.1.dist-info/licenses/LICENSE.md') -Destination (Join-Path $legal 'MINERU-LICENSE.md')
}
foreach ($folder in 'pdfmathtranslate-src','bilingual-book-maker-src') {
    $source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../video-runtime-build/$folder")).Path
    $destination = Join-Path $Output "video-runtime/$folder"
    foreach ($file in (Get-ChildItem -LiteralPath $source -Recurse -File | Where-Object { $_.Extension -ne '.pyc' })) {
        $target = Join-Path $destination $file.FullName.Substring($source.Length + 1)
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        Copy-Item -LiteralPath $file.FullName -Destination $target
    }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web-fetch.mjs') -Destination $bridgeWorkers
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'video-transcribe.py'),(Join-Path $PSScriptRoot 'video-translate.py'),(Join-Path $PSScriptRoot 'local-llm-translate.py'),(Join-Path $PSScriptRoot 'transcript_utils.py'),(Join-Path $PSScriptRoot 'mineru-reflow.py'),(Join-Path $PSScriptRoot 'pdfmathtranslate.py'),(Join-Path $PSScriptRoot 'bilingual-book-worker.py'),(Join-Path $PSScriptRoot 'pdf_gguf_translation.py'),(Join-Path $PSScriptRoot 'offline_en_zh.py') -Destination $pythonWorkers
$asrModels = Join-Path $Output 'models\asr'
$translationModels = Join-Path $Output 'models\translation'
$null = New-Item -ItemType Directory -Force $asrModels, $translationModels
[IO.File]::WriteAllText((Join-Path $asrModels '.keep'), '')
[IO.File]::WriteAllText((Join-Path $translationModels '.keep'), '')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QWEN3-LICENSE.txt') -Destination $legal
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../video-runtime-build/pdfmathtranslate-src/LICENSE') -Destination (Join-Path $legal 'PDFMATHTRANSLATE-AGPL-3.0.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../video-runtime-build/bilingual-book-maker-src/LICENSE') -Destination (Join-Path $legal 'BILINGUAL-BOOK-MAKER-MIT.txt')
& (Join-Path $PSScriptRoot '../ai-bridge/stage-desktop.ps1') -Output $Output -ReuseStagedRuntime:([bool]$RuntimeArchive)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $Output
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '开始使用.md'),(Join-Path $PSScriptRoot '视频字幕使用说明.md'),(Join-Path $PSScriptRoot '视频模型下载说明.md'),(Join-Path $PSScriptRoot '本地离线翻译模型说明.md'),(Join-Path $PSScriptRoot '模型目录说明.md'),(Join-Path $PSScriptRoot 'MinerU智能排版说明.md'),(Join-Path $PSScriptRoot '../ai-bridge/AI接入指南.md') -Destination $docs
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '使用说明.md') -Destination $docs
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '重置为初始状态.cmd') -Destination $tools -ErrorAction SilentlyContinue

$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $manifestFiles = @(foreach ($path in [IO.Directory]::GetFiles($Output, '*', [IO.SearchOption]::AllDirectories) | Sort-Object) {
        $relative = $path.Substring($Output.Length + 1).Replace('\','/')
        if ($relative -eq 'release-manifest.json' -or $relative -match '^(Data/|UpdateBackups/|data-location\.txt$)') { continue }
        $fileStream = [IO.File]::OpenRead($path)
        try {
            $hash = [BitConverter]::ToString($hasher.ComputeHash($fileStream)).Replace('-', '').ToLowerInvariant()
            @{ path = $relative; size = $fileStream.Length; sha256 = $hash }
        } finally { $fileStream.Dispose() }
    })
} finally { $hasher.Dispose() }
$manifest = [ordered]@{ version = $ReleaseVersion; requiresDataBackup = [bool]$DataMigration; files = $manifestFiles }
if ($SourceCommit) {
    $manifest.provenance = [ordered]@{
        sourceCommit = $SourceCommit
        runtimeArchiveSha256 = $runtimeSha256
        buildScript = 'tools/release.ps1'
        compilerSha256 = (Get-FileHash -LiteralPath $csc -Algorithm SHA256).Hash.ToLowerInvariant()
        nodeVersion = (& $node --version)
    }
}
[IO.File]::WriteAllText((Join-Path $Output 'release-manifest.json'),($manifest | ConvertTo-Json -Depth 6 -Compress),[Text.Encoding]::UTF8)

