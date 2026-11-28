<#
[INPUT]: 读取已验证的 DoNote-Windows-x64-*.zip 便携包、图标源与 C# 5 安装向导源码。
[OUTPUT]: 编译纯安装壳、流式拼接 ZIP 载荷与 DNSETUP1 校验尾，生成并自检 DoNote-Setup-x64-*.exe。
[POS]: 双轨发布链的 Windows 用户级安装向导封装脚本，与 package-release.ps1 共享同一份完整包。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackageZip,
    [Parameter(Mandatory=$true)][string]$Destination,
    [string]$IconPath
)
$ErrorActionPreference = 'Stop'
$PackageZip = (Resolve-Path -LiteralPath $PackageZip).Path
$Destination = [IO.Path]::GetFullPath($Destination)
$destDir = Split-Path -Parent $Destination
if ($destDir) { [void][IO.Directory]::CreateDirectory($destDir) }

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('donote-setup-build-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($tempDir)
$tempExe = $Destination + '.tmp-' + [Guid]::NewGuid().ToString('N')

try {
    $resolvedIcon = $null
    if ($IconPath) {
        $resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
    } else {
        $brandLogo = Join-Path $PSScriptRoot '..\analog-notes\public\brand-logo.png'
        if (Test-Path -LiteralPath $brandLogo) {
            Add-Type -AssemblyName System.Drawing
            $logo = [Drawing.Image]::FromFile((Resolve-Path -LiteralPath $brandLogo).Path)
            $resolvedIcon = Join-Path $tempDir 'DoNote.ico'
            $stream = [IO.File]::Create($resolvedIcon)
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
        }
    }

    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (!(Test-Path -LiteralPath $csc)) { throw "未找到 .NET Framework 4.x C# 编译器：$csc" }

    $stubPath = Join-Path $tempDir 'DoNoteSetupStub.exe'
    $cscArgs = @(
        '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
        "/out:$stubPath",
        "/win32manifest:$PSScriptRoot\app.manifest",
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Web.Extensions.dll',
        '/reference:System.IO.Compression.dll',
        '/reference:System.IO.Compression.FileSystem.dll'
    )
    if ($resolvedIcon) { $cscArgs += "/win32icon:$resolvedIcon" }
    $cscArgs += @(
        "$PSScriptRoot\SetupHost.cs",
        "$PSScriptRoot\SetupPackage.cs",
        "$PSScriptRoot\UpdatePackage.cs"
    )
    & $csc @cscArgs
    if ($LASTEXITCODE -ne 0) { throw 'DoNote 安装向导编译失败。' }

    $stubBytes = [IO.File]::ReadAllBytes($stubPath)
    $payloadOffset = [Int64]$stubBytes.Length
    $sha = [Security.Cryptography.SHA256]::Create()
    $outStream = [IO.File]::Create($tempExe)
    $zipStream = [IO.File]::OpenRead($PackageZip)
    try {
        $outStream.Write($stubBytes, 0, $stubBytes.Length)
        $buffer = New-Object byte[] (1024 * 1024)
        $payloadLength = [Int64]0
        while (($read = $zipStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $null = $sha.TransformBlock($buffer, 0, $read, $buffer, 0)
            $outStream.Write($buffer, 0, $read)
            $payloadLength += $read
        }
        $null = $sha.TransformFinalBlock($buffer, 0, 0)
        $hashBytes = $sha.Hash

        $writer = [IO.BinaryWriter]::new($outStream, [Text.Encoding]::ASCII, $true)
        try {
            $writer.Write($payloadOffset)
            $writer.Write($payloadLength)
            $writer.Write($hashBytes)
            $writer.Write([Text.Encoding]::ASCII.GetBytes('DNSETUP1'))
        } finally {
            $writer.Dispose()
        }
    } finally {
        $zipStream.Dispose()
        $outStream.Dispose()
        $sha.Dispose()
    }

    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    [IO.File]::Move($tempExe, $Destination)

    $verifyLog = Join-Path $tempDir 'verify.log'
    $proc = Start-Process -FilePath $Destination -ArgumentList @('--verify-only', "--log=$verifyLog") -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) {
        $detail = if (Test-Path -LiteralPath $verifyLog) { Get-Content -Raw -LiteralPath $verifyLog } else { 'unknown error' }
        throw "安装包自检失败：$detail"
    }
    Get-Item -LiteralPath $Destination
} finally {
    if (Test-Path -LiteralPath $tempExe) { Remove-Item -LiteralPath $tempExe -Force }
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
