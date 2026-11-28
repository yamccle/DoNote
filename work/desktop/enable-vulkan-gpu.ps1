<#
[INPUT]: 定位 DoNote 安装目录、系统 vulkan-1.dll 与官方 llama-cpp-python Vulkan wheel 源。
[OUTPUT]: 在 video-runtime/vulkan-dependencies 安装或卸载独立 Vulkan 加速层，并验证 GPU offload 就绪状态。
[POS]: 零侵入 GPU 加速解锁脚本，不修改 runtime-lock.json 锁定的 translation-dependencies。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\DoNote'),
    [switch]$Disable
)
$ErrorActionPreference = 'Stop'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$runtime = Join-Path $InstallDir 'video-runtime'
$python = Join-Path $runtime 'python.exe'
$vulkanDeps = Join-Path $runtime 'vulkan-dependencies'
$baseDeps = Join-Path $runtime 'translation-dependencies'
$sharedDeps = Join-Path $runtime 'dependencies'

if ($Disable) {
    if (Test-Path -LiteralPath $vulkanDeps) {
        Remove-Item -LiteralPath $vulkanDeps -Recurse -Force
        Write-Host "已移除 Vulkan 加速层，已回退至默认 CPU 推理：$vulkanDeps"
    } else {
        Write-Host '未检测到 Vulkan 加速层，无需移除。'
    }
    exit 0
}

if (!(Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "未找到 DoNote Python 运行时：$python"
}
if (!(Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\vulkan-1.dll') -PathType Leaf)) {
    throw '当前系统未检测到 vulkan-1.dll，请先更新显卡驱动后再试。'
}

[void][IO.Directory]::CreateDirectory($vulkanDeps)
Write-Host "正在安装 Vulkan 加速版 llama-cpp-python 到：$vulkanDeps"
& $python -m pip install --upgrade --no-deps --only-binary=llama-cpp-python --index-url https://abetlen.github.io/llama-cpp-python/whl/vulkan --target $vulkanDeps llama-cpp-python
if ($LASTEXITCODE -ne 0) {
    throw '下载或安装 Vulkan 加速组件失败。'
}

$probe = & $python -c "import sys; sys.path[:0] = [r'$vulkanDeps', r'$baseDeps', r'$sharedDeps']; import llama_cpp; print('OFFLOAD=' + str(bool(llama_cpp.llama_supports_gpu_offload())))"
if ($LASTEXITCODE -ne 0 -or ($probe -join "`n") -notmatch 'OFFLOAD=True') {
    throw "Vulkan 加速验证未通过：$($probe -join '; ')"
}
Write-Host "Vulkan GPU 加速已就绪（$InstallDir）。"
