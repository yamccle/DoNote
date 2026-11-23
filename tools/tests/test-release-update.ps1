<#
[INPUT] 读取旧版完整 ZIP、新版更新 ZIP 和桌面更新器源码。
[OUTPUT] 验证真实版本更新、失败回退与用户文件完整性。
[POS] 只在独立临时目录执行更新，供发布前运行。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
param(
    [Parameter(Mandatory = $true)][string]$PreviousReleaseZip,
    [Parameter(Mandatory = $true)][string]$UpdateZip
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$previous = (Resolve-Path -LiteralPath $PreviousReleaseZip).Path
$update = (Resolve-Path -LiteralPath $UpdateZip).Path
$desktop = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../work/desktop')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$tempParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$temp = Join-Path $tempParent ('donote-release-update-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temp

function Read-Manifest($archive) {
    $entry = $archive.GetEntry('release-manifest.json')
    if (!$entry) { throw '安装包缺少 release-manifest.json。' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { return $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }
}

function Extract-File($entry, [string]$destination) {
    $null = New-Item -ItemType Directory -Force (Split-Path -Parent $destination)
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)
}

function Assert-Hash([string]$path, [string]$expected) {
    if (!(Test-Path -LiteralPath $path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $expected) {
        throw "文件哈希不匹配：$path"
    }
}

try {
    $probe = Join-Path $temp 'UpdateProbe.exe'
    & $compiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$probe" /main:UpdateProbe `
        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
        /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
        (Join-Path $desktop 'UpdateProbe.cs') (Join-Path $desktop 'UpdateHost.cs') (Join-Path $desktop 'UpdatePackage.cs')
    if ($LASTEXITCODE -ne 0) { throw '无法编译更新测试程序。' }

    foreach ($package in @($previous, $update)) {
        & $probe $package
        if ($LASTEXITCODE -ne 0) { throw "安装包完整性校验失败：$package" }
    }
    $incoming = [IO.Compression.ZipFile]::OpenRead($update)
    try { $newManifest = Read-Manifest $incoming }
    finally { $incoming.Dispose() }

    $oldArchive = [IO.Compression.ZipFile]::OpenRead($previous)
    try {
        $oldManifest = Read-Manifest $oldArchive
        if ($oldManifest.baseVersion) { throw '请提供旧版完整安装包。' }
        if ($newManifest.baseVersion -and $newManifest.baseVersion -ne $oldManifest.version) {
            throw '增量包声明的基础版本与旧版完整包不匹配。'
        }
        if ([version]$newManifest.version -le [version]$oldManifest.version) { throw '更新版本必须更高。' }

        $oldByPath = @{}
        foreach ($file in $oldManifest.files) { $oldByPath[$file.path] = $file }
        $changed = @($newManifest.files | Where-Object { $oldByPath[$_.path].sha256 -ne $_.sha256 })
        if (!$changed.Count) { throw '更新包没有变化的程序文件，不能验证回退。' }

        foreach ($scenario in 'default-data', 'custom-data', 'rollback') {
            $root = Join-Path $temp $scenario
            $program = Join-Path $root 'DoNote'
            $data = if ($scenario -eq 'default-data') { Join-Path $program 'Data' } else { Join-Path $root 'Library' }
            $null = New-Item -ItemType Directory -Force $program, $data
            $oldInstalledManifest = Join-Path $program 'release-manifest.json'
            Extract-File ($oldArchive.GetEntry('release-manifest.json')) $oldInstalledManifest
            $oldManifestHash = (Get-FileHash -LiteralPath $oldInstalledManifest -Algorithm SHA256).Hash
            foreach ($file in $newManifest.files) {
                $entry = $oldArchive.GetEntry($file.path)
                if ($entry) { Extract-File $entry (Join-Path $program $file.path) }
            }

            $sentinels = @{}
            $payloads = @{
                (Join-Path $data 'Workspace/IndexedDB/qa-record.ldb') = '用户记录测试数据'
                (Join-Path $data 'attachments/qa-original.bin') = '原始附件测试数据'
                (Join-Path $program 'models/qa-custom/qa-model.gguf') = '用户模型测试数据'
            }
            if ($scenario -ne 'default-data') { $payloads[(Join-Path $program 'data-location.txt')] = $data }
            foreach ($file in $payloads.GetEnumerator()) {
                $null = New-Item -ItemType Directory -Force (Split-Path -Parent $file.Key)
                [IO.File]::WriteAllText($file.Key, $file.Value)
                $sentinels[$file.Key] = (Get-FileHash -LiteralPath $file.Key -Algorithm SHA256).Hash
            }

            $failAfter = if ($scenario -eq 'rollback') { [Math]::Min(2, $changed.Count) } else { -1 }
            if ($failAfter -gt 0) {
                # PowerShell 7 可为非零原生进程返回码生成异常。
                $PSNativeCommandUseErrorActionPreference = $false
                & $probe $update $program $data $failAfter
                if ($LASTEXITCODE -eq 0) { throw '模拟中断没有触发回退。' }
                Assert-Hash $oldInstalledManifest $oldManifestHash
                foreach ($file in $newManifest.files) {
                    $target = Join-Path $program $file.path
                    if ($oldByPath.ContainsKey($file.path)) { Assert-Hash $target $oldByPath[$file.path].sha256 }
                    elseif (Test-Path -LiteralPath $target) { throw "回退后仍有新增文件：$target" }
                }
            } else {
                & $probe $update $program $data $failAfter
                if ($LASTEXITCODE -ne 0) { throw "更新失败：$scenario" }
                $installed = Get-Content -LiteralPath $oldInstalledManifest -Raw | ConvertFrom-Json
                if ($installed.version -ne $newManifest.version) { throw "安装后的版本不符：$scenario" }
                foreach ($file in $newManifest.files) { Assert-Hash (Join-Path $program $file.path) $file.sha256 }
            }
            foreach ($file in $sentinels.GetEnumerator()) { Assert-Hash $file.Key $file.Value }
            Write-Output "PASS release update: $scenario ($($oldManifest.version) to $($newManifest.version)); data and models verified"
        }
    } finally { $oldArchive.Dispose() }
} finally {
    $resolved = (Resolve-Path -LiteralPath $temp).Path
    if ((Split-Path -Parent $resolved) -eq $tempParent -and (Split-Path -Leaf $resolved).StartsWith('donote-release-update-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
