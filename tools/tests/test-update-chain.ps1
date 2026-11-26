<#
[INPUT]: 读取选包逻辑、更新器和合成判据源码。
[OUTPUT]: 验证更新路径和安装回退。
[POS]: 在独立临时目录中执行。供发布流程调用。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
$ErrorActionPreference = 'Stop'
$parent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$temp = Join-Path $parent ('donote-update-chain-test-' + [Guid]::NewGuid().ToString('N'))
$desktop = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../work/desktop')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$null = New-Item -ItemType Directory -Path $temp
try {
    $probe = Join-Path $temp 'UpdateChainProbe.exe'
    & $compiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$probe" /main:UpdateChainProbe `
        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
        /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
        (Join-Path $desktop 'OnlineUpdatePlan.cs') (Join-Path $desktop 'UpdateHost.cs') (Join-Path $desktop 'UpdatePackage.cs') (Join-Path $PSScriptRoot 'UpdateChainProbe.cs')
    if ($LASTEXITCODE) { throw '更新链测试编译失败。' }
    & $probe $temp
    if ($LASTEXITCODE) { throw '更新链测试失败。' }
} finally {
    $resolved = (Resolve-Path -LiteralPath $temp).Path
    if ((Split-Path -Parent $resolved) -eq $parent -and (Split-Path -Leaf $resolved) -match '^donote-update-chain-test-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
