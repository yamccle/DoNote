param(
    [string[]]$Path = @(),
    [switch]$Repair,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$packageRoot = $PSScriptRoot
$packageModels = Join-Path $packageRoot 'models'

if (!(Test-Path -LiteralPath $packageModels)) {
    Write-Host '找不到模型目录，请把安装包完整解压后再运行。' -ForegroundColor Red
    exit 2
}

Write-Host ''
Write-Host 'DoNote 模型安装器' -ForegroundColor Cyan
Write-Host '将按目录结构和文件大小，只补装当前缺少或损坏的模型。'
Write-Host ''

$running = @(Get-Process -Name 'DoNote' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host '检测到 DoNote 正在运行。请先完全退出 DoNote 再安装，否则正在加载的模型文件会被占用。' -ForegroundColor Yellow
    Write-Host ''
}

$modelItems = @(
    Get-ChildItem -LiteralPath $packageModels -File -Recurse |
        ForEach-Object {
            $relative = $_.FullName.Substring($packageModels.Length).TrimStart('\', '/')
            [pscustomobject]@{
                RelativePath = $relative
                Size         = $_.Length
                Source       = $_.FullName
            }
        }
)

$found = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

function Add-DoNoteDir {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return }
    try {
        $full = [System.IO.Path]::GetFullPath($Dir)
        if (Test-Path -LiteralPath (Join-Path $full 'DoNote.exe')) {
            [void]$found.Add($full)
        }
    } catch {
        # Ignore inaccessible paths.
    }
}

function Search-DoNoteUnder {
    param([string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root) -or !(Test-Path -LiteralPath $Root)) { return }
    Get-ChildItem -LiteralPath $Root -Filter 'DoNote.exe' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        ForEach-Object { Add-DoNoteDir $_.DirectoryName }
}

if ($Path.Count -gt 0) {
    foreach ($item in $Path) {
        if (!(Test-Path -LiteralPath $item)) {
            Write-Warning "跳过不存在的路径：$item"
            continue
        }
        if ((Get-Item -LiteralPath $item).PSIsContainer) {
            Add-DoNoteDir $item
        } elseif ((Split-Path -Leaf $item) -eq 'DoNote.exe') {
            Add-DoNoteDir (Split-Path -Parent $item)
        } else {
            Write-Warning "不是 DoNote.exe 或目录，已跳过：$item"
        }
    }
} else {
    Add-DoNoteDir $packageRoot
    Add-DoNoteDir (Split-Path -Parent $packageRoot)

    $searchRoots = @(
        [Environment]::GetFolderPath('DesktopDirectory')
        [Environment]::GetFolderPath('MyDocuments')
        (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads')
    )
    foreach ($root in $searchRoots) {
        Search-DoNoteUnder $root
    }

    foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
        if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or !$drive.IsReady) { continue }
        $driveRoot = $drive.RootDirectory.FullName
        Add-DoNoteDir $driveRoot

        $level1 = @()
        try { $level1 = [System.IO.Directory]::GetDirectories($driveRoot) } catch { $level1 = @() }
        foreach ($dir1 in $level1) {
            Add-DoNoteDir $dir1
            $level2 = @()
            try { $level2 = [System.IO.Directory]::GetDirectories($dir1) } catch { $level2 = @() }
            foreach ($dir2 in $level2) {
                Add-DoNoteDir $dir2
            }
        }
    }
}

$candidates = @($found)
if ($candidates.Count -eq 0) {
    Write-Host '没有自动找到 DoNote 安装目录。'
    Write-Host '请把安装包放到 DoNote.exe 所在目录附近，或使用参数指定：'
    Write-Host '  powershell -File Install-DoNote-Models.ps1 -Path "D:\DoNote"'
    exit 2
}

Write-Host "找到 $($candidates.Count) 个 DoNote 安装位置："
foreach ($candidate in $candidates) {
    Write-Host "  - $candidate"
}
Write-Host ''

$installed = 0
$repaired = 0
$skippedExisting = 0
$skippedMismatch = 0
$failed = 0

foreach ($candidate in $candidates) {
    $modelsRoot = Join-Path $candidate 'models'
    Write-Host "目标：$candidate" -ForegroundColor DarkGray

    foreach ($model in $modelItems) {
        $target = Join-Path $modelsRoot ($model.RelativePath -replace '/', '\')
        $targetDir = Split-Path -Parent $target
        $label = $model.RelativePath -replace '\\', '/'

        $existed = Test-Path -LiteralPath $target
        if ($existed) {
            $existingSize = (Get-Item -LiteralPath $target).Length
            if ($existingSize -eq $model.Size) {
                Write-Host "  跳过（已存在）  $label"
                $skippedExisting++
                continue
            }
            if (!$Repair) {
                Write-Host "  跳过（大小不一致）$label  可加 -Repair 修复" -ForegroundColor Yellow
                $skippedMismatch++
                continue
            }
            if ($WhatIf) {
                Write-Host "  [模拟] 覆盖      $label"
                $repaired++
                continue
            }
        } elseif ($WhatIf) {
            Write-Host "  [模拟] 安装      $label"
            $installed++
            continue
        }

        try {
            if (!$existed) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
            Copy-Item -LiteralPath $model.Source -Destination $target -Force
        } catch {
            Write-Host "  失败（文件被占用或没有写入权限）$label  请先完全退出 DoNote 后重试" -ForegroundColor Red
            $failed++
            continue
        }

        $copiedSize = 0
        try { $copiedSize = (Get-Item -LiteralPath $target).Length } catch {}
        if ($copiedSize -ne $model.Size) {
            Write-Host "  失败（复制不完整）$label" -ForegroundColor Red
            $failed++
            continue
        }
        if ($existed) {
            Write-Host "  已修复           $label" -ForegroundColor Green
            $repaired++
        } else {
            Write-Host "  已安装           $label" -ForegroundColor Green
            $installed++
        }
    }
    Write-Host ''
}

Write-Host '汇总：' -ForegroundColor Cyan
Write-Host "  新安装：$installed"
Write-Host "  已修复：$repaired"
Write-Host "  已存在：$skippedExisting"
Write-Host "  大小不一致且未处理：$skippedMismatch"
Write-Host "  失败：$failed"
if ($WhatIf) {
    Write-Host ''
    Write-Host '这是模拟运行，未复制或修改任何文件。' -ForegroundColor Yellow
}
if ($skippedMismatch -gt 0) {
    Write-Host ''
    Write-Host '存在大小不一致的模型文件。若怀疑损坏，可重新运行并加 -Repair 覆盖。' -ForegroundColor Yellow
}
if ($failed -gt 0) {
    Write-Host ''
    Write-Host '有文件未能安装。请完全退出 DoNote 后重试，或加 -Repair 覆盖损坏文件。' -ForegroundColor Yellow
    exit 3
}
exit 0