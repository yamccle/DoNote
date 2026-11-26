<#
[INPUT]: 读取干净的 Git 提交、锁定的运行依赖包和旧版完整包。
[OUTPUT]: 生成 Windows 更新包和发布记录。记录云备份、更新链与工作台等验证结果。
[POS]: 正式发布入口。验证在独立目录运行。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^r[1-9][0-9]*$')][string]$Revision,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version,
    [Parameter(Mandatory=$true)][string]$RuntimeArchive,
    [Parameter(Mandatory=$true)][string]$PreviousReleaseZip,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [switch]$KeepStage
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.Replace('\','/')
$runtime = (Resolve-Path -LiteralPath $RuntimeArchive).Path
$previous = (Resolve-Path -LiteralPath $PreviousReleaseZip).Path
$destination = [IO.Path]::GetFullPath($OutputDirectory)
$published = Join-Path $destination $Revision
$gitArgs = @('-c', "safe.directory=$repo", '-C', $repo)
$sourceCommit = & git @gitArgs rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) { throw '无法读取正式源码提交。' }
$changes = & git @gitArgs status --porcelain
if ($LASTEXITCODE -ne 0 -or $changes) { throw '请先提交源码改动再发布。' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$tempParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$temp = Join-Path $tempParent ('donote-release-' + [Guid]::NewGuid().ToString('N'))
$incoming = Join-Path $destination ('.incoming-' + $Revision + '-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
try {
    if (Test-Path -LiteralPath $published) { throw "发布目录已存在 $published。" }
    $baseline = Join-Path $temp 'baseline'
    [void][IO.Directory]::CreateDirectory($baseline)
    $baseManifestPath = Join-Path $baseline 'release-manifest.json'
    $previousArchive = [IO.Compression.ZipFile]::OpenRead($previous)
    try {
        $entry = $previousArchive.GetEntry('release-manifest.json')
        if (!$entry) { throw '旧版完整包缺少版本清单。' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $baseManifestPath)
    } finally { $previousArchive.Dispose() }
    $base = Get-Content -Raw -LiteralPath $baseManifestPath | ConvertFrom-Json
    if ($base.baseVersion -or [version]$Version -le [version]$base.version) {
        throw '请使用更早的完整包作为升级基线。'
    }
    $fullName = "DoNote-Windows-x64-$Revision.zip"
    $updateName = "DoNote-Update-$($base.version)-to-$Revision.zip"
    $reportName = "DoNote-$Revision-release.json"
    $archive = Join-Path $temp 'source.zip'
    $source = Join-Path $temp 'source'
    & git @gitArgs archive --format=zip "--output=$archive" $sourceCommit
    if ($LASTEXITCODE -ne 0) { throw '无法导出源码提交。' }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $source)
    $desktop = Join-Path $source 'work/desktop'
    $tests = Join-Path $source 'tools/tests'
    $stage = Join-Path $temp 'stage'
    $patch = Join-Path $temp $updateName
    $full = Join-Path $temp $fullName

    & (Join-Path $desktop 'build.ps1') -RuntimeArchive $runtime -Output $stage -ReleaseVersion $Version -SourceCommit $sourceCommit
    & (Join-Path $desktop 'make-update-patch.ps1') -Baseline $baseline -Target $stage -Destination $patch -BaseVersion $base.version -ReleaseVersion $Version
    & (Join-Path $stage 'ai-bridge/node.exe') (Join-Path $tests 'test-workspace.mjs') (Join-Path $stage 'workspace')
    if ($LASTEXITCODE -ne 0) { throw '工作台回归验证失败。' }
    & (Join-Path $stage 'ai-bridge/node.exe') (Join-Path $tests 'test-cloud-backup.mjs')
    if ($LASTEXITCODE -ne 0) { throw '云备份传输回归验证失败。' }
    & (Join-Path $tests 'test-release-update.ps1') -PreviousReleaseZip $previous -UpdateZip $patch
    & (Join-Path $tests 'test-update-chain.ps1')
    & (Join-Path $desktop 'package-release.ps1') -Source $stage -Destination $full

    $manifestPath = Join-Path $stage 'release-manifest.json'
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $report = [ordered]@{
        revision = $Revision
        version = $Version
        baseVersion = $base.version
        previousArchiveSha256 = (Get-FileHash -LiteralPath $previous).Hash.ToLowerInvariant()
        provenance = $manifest.provenance
        checks = @('workspace', 'cloud-backup-transport', 'upgrade-and-rollback', 'online-update-chain', 'package-checksums')
        artifacts = @(foreach ($item in $patch,$full) {
            @{ name = [IO.Path]::GetFileName($item); sha256 = (Get-FileHash -LiteralPath $item).Hash.ToLowerInvariant() }
        })
    }
    [void][IO.Directory]::CreateDirectory($incoming)
    [IO.File]::Copy($full, (Join-Path $incoming $fullName))
    [IO.File]::Copy($patch, (Join-Path $incoming $updateName))
    [IO.File]::WriteAllText((Join-Path $incoming $reportName),($report | ConvertTo-Json -Depth 6))
    [IO.Directory]::Move($incoming, $published)
    Get-ChildItem -LiteralPath $published
} finally {
    if ((Test-Path -LiteralPath $incoming) -and
        (Split-Path -Parent ([IO.Path]::GetFullPath($incoming))) -eq $destination.TrimEnd('\') -and
        (Split-Path -Leaf $incoming) -match '^\.incoming-r[1-9][0-9]*-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $incoming -Recurse -Force
    }
    if ($KeepStage) {
        Write-Host "构建目录 $temp"
    } elseif ((Test-Path -LiteralPath $temp) -and
              (Split-Path -Parent ([IO.Path]::GetFullPath($temp))) -eq $tempParent -and
              (Split-Path -Leaf $temp) -match '^donote-release-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
