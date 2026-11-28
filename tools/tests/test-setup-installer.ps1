<#
[INPUT]: 调用 work/desktop/make-installer.ps1 与合成的 DoNote 发布 ZIP。
[OUTPUT]: 在临时目录与隔离注册表键下端到端验证：自检、全新安装、覆盖升级保数据、安全卸载保数据、完全卸载清数据。
[POS]: 双轨发布链的自动化回归测试脚本，不触碰真实安装目录、桌面快捷方式或正式注册表项。
[PROTOCOL]: Update this header on change, then check AGENTS.md
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$makeInstaller = Join-Path $repoRoot 'work\desktop\make-installer.ps1'

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('donote-setup-test-' + [Guid]::NewGuid().ToString('N'))
$regKeyName = 'DoNoteSetupTest_' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$regKeyName"

function New-SyntheticPackageZip {
    param([string]$StageDir, [string]$ZipPath, [string]$Version, [hashtable]$Files)
    [void][IO.Directory]::CreateDirectory($StageDir)
    $manifestFiles = @()
    foreach ($rel in ($Files.Keys | Sort-Object)) {
        $fullPath = Join-Path $StageDir ($rel.Replace('/', '\'))
        $parent = Split-Path -Parent $fullPath
        if ($parent) { [void][IO.Directory]::CreateDirectory($parent) }
        [IO.File]::WriteAllText($fullPath, $Files[$rel], [Text.UTF8Encoding]::new($false))
        $info = Get-Item -LiteralPath $fullPath
        $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifestFiles += [ordered]@{ path = $rel; size = [Int64]$info.Length; sha256 = $hash }
    }
    $manifest = [ordered]@{
        version = $Version
        requiresDataBackup = $false
        files = $manifestFiles
    }
    [IO.File]::WriteAllText((Join-Path $StageDir 'release-manifest.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    [IO.Compression.ZipFile]::CreateFromDirectory($StageDir, $ZipPath)
}

function Invoke-Setup {
    param([string]$ExePath, [string[]]$Arguments, [string]$LogFile)
    $allArgs = @($Arguments) + @("--log=$LogFile")
    $proc = Start-Process -FilePath $ExePath -ArgumentList $allArgs -Wait -PassThru -NoNewWindow
    $logText = if (Test-Path -LiteralPath $LogFile) { (Get-Content -Raw -LiteralPath $LogFile).Trim() } else { '' }
    if ($proc.ExitCode -ne 0) {
        throw "Setup command failed (exit=$($proc.ExitCode)): $ExePath $($allArgs -join ' ') -> $logText"
    }
    return $logText
}

try {
    [void][IO.Directory]::CreateDirectory($tempRoot)
    $zipV1 = Join-Path $tempRoot 'DoNote-v1.zip'
    $zipV2 = Join-Path $tempRoot 'DoNote-v2.zip'
    $setupV1 = Join-Path $tempRoot 'DoNote-Setup-v1.exe'
    $setupV2 = Join-Path $tempRoot 'DoNote-Setup-v2.exe'
    $installDir = Join-Path $tempRoot 'InstallTarget\DoNote'
    $shortcutDir = Join-Path $tempRoot 'Shortcuts'

    New-SyntheticPackageZip -StageDir (Join-Path $tempRoot 'stage-v1') -ZipPath $zipV1 -Version '26.1142.0088' -Files @{
        'DoNote.exe' = 'FAKE-DONOTE-V1'
        'workspace/index.html' = '<html>v1</html>'
        'workspace/obsolete-v1.js' = 'console.log("v1 only");'
        'models/asr/.keep' = ''
    }
    New-SyntheticPackageZip -StageDir (Join-Path $tempRoot 'stage-v2') -ZipPath $zipV2 -Version '26.1143.0089' -Files @{
        'DoNote.exe' = 'FAKE-DONOTE-V2'
        'workspace/index.html' = '<html>v2</html>'
        'workspace/new-v2.js' = 'console.log("v2 new");'
        'models/asr/.keep' = ''
    }

    # 1. Build & self-verify both installers
    $null = & $makeInstaller -PackageZip $zipV1 -Destination $setupV1
    $null = & $makeInstaller -PackageZip $zipV2 -Destination $setupV2

    # 2. Fresh silent user-level install (v1)
    $log1 = Invoke-Setup -ExePath $setupV1 -Arguments @(
        '--silent', "--dir=$installDir", "--shortcut-dir=$shortcutDir", "--test-reg-key=$regKeyName"
    ) -LogFile (Join-Path $tempRoot 'install-v1.log')
    if ($log1 -notmatch '^INSTALL_OK version=26\.1142\.0088') { throw "Unexpected v1 install log: $log1" }
    if ((Get-Content -Raw -LiteralPath (Join-Path $installDir 'DoNote.exe')) -ne 'FAKE-DONOTE-V1') { throw 'v1 DoNote.exe mismatch' }
    if (!(Test-Path -LiteralPath (Join-Path $shortcutDir 'DoNote.lnk'))) { throw 'Shortcut was not created' }

    $uninstaller = Get-Item -LiteralPath (Join-Path $installDir 'DoNoteUninstall.exe')
    if ($uninstaller.Length -gt 262144) { throw "DoNoteUninstall.exe unexpectedly large (contains payload?): $($uninstaller.Length)" }
    if (!(Test-Path -LiteralPath $regPath)) { throw 'HKCU Uninstall registry key missing' }
    $regProps = Get-ItemProperty -LiteralPath $regPath
    if ($regProps.DisplayVersion -ne '26.1142.0088' -or $regProps.InstallLocation -ne $installDir) {
        throw "Registry properties mismatch: version=$($regProps.DisplayVersion) loc=$($regProps.InstallLocation)"
    }

    # 3. Seed user data & models, then overwrite/upgrade to v2
    $dataFile = Join-Path $installDir 'Data\workspace.db'
    $modelFile = Join-Path $installDir 'models\asr\small\model.bin'
    $locFile = Join-Path $installDir 'data-location.txt'
    $syncFile = Join-Path $installDir 'FolderSync.txt'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $dataFile))
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $modelFile))
    [IO.File]::WriteAllText($dataFile, 'USER-RESEARCH-NOTES-DB')
    [IO.File]::WriteAllText($modelFile, 'LOCAL-WHISPER-MODEL-WEIGHTS')
    [IO.File]::WriteAllText($locFile, 'H:\MyCustomData')
    [IO.File]::WriteAllText($syncFile, 'K:\CloudSync\DoNote')

    $log2 = Invoke-Setup -ExePath $setupV2 -Arguments @(
        '--silent', "--dir=$installDir", "--shortcut-dir=$shortcutDir", "--test-reg-key=$regKeyName"
    ) -LogFile (Join-Path $tempRoot 'install-v2.log')
    if ($log2 -notmatch '^INSTALL_OK version=26\.1143\.0089 .*upgrade=True') { throw "Unexpected v2 upgrade log: $log2" }
    if ((Get-Content -Raw -LiteralPath (Join-Path $installDir 'DoNote.exe')) -ne 'FAKE-DONOTE-V2') { throw 'v2 DoNote.exe mismatch' }
    if (Test-Path -LiteralPath (Join-Path $installDir 'workspace\obsolete-v1.js')) { throw 'Obsolete v1 program file was not cleaned up' }
    if (!(Test-Path -LiteralPath (Join-Path $installDir 'workspace\new-v2.js'))) { throw 'New v2 program file missing' }
    if ((Get-ItemProperty -LiteralPath $regPath).DisplayVersion -ne '26.1143.0089') { throw 'Registry DisplayVersion did not update to v2' }
    if ((Get-Content -Raw -LiteralPath $dataFile) -ne 'USER-RESEARCH-NOTES-DB') { throw 'Data\workspace.db modified during upgrade' }
    if ((Get-Content -Raw -LiteralPath $modelFile) -ne 'LOCAL-WHISPER-MODEL-WEIGHTS') { throw 'models file modified during upgrade' }
    if ((Get-Content -Raw -LiteralPath $locFile) -ne 'H:\MyCustomData') { throw 'data-location.txt modified during upgrade' }
    if ((Get-Content -Raw -LiteralPath $syncFile) -ne 'K:\CloudSync\DoNote') { throw 'FolderSync.txt modified during upgrade' }

    # 4. Safe uninstall (default: preserve user data & models)
    $log3 = Invoke-Setup -ExePath $setupV2 -Arguments @(
        '--uninstall', '--silent', "--dir=$installDir", "--shortcut-dir=$shortcutDir", "--test-reg-key=$regKeyName"
    ) -LogFile (Join-Path $tempRoot 'uninstall-safe.log')
    if ($log3 -notmatch '^UNINSTALL_OK .*preserved=True') { throw "Unexpected safe uninstall log: $log3" }
    if (Test-Path -LiteralPath (Join-Path $installDir 'DoNote.exe')) { throw 'DoNote.exe still exists after uninstall' }
    if (Test-Path -LiteralPath (Join-Path $installDir 'DoNoteUninstall.exe')) { throw 'DoNoteUninstall.exe still exists after uninstall' }
    if (Test-Path -LiteralPath (Join-Path $shortcutDir 'DoNote.lnk')) { throw 'Shortcut still exists after uninstall' }
    if (Test-Path -LiteralPath $regPath) { throw 'HKCU Uninstall registry key still exists after uninstall' }
    if ((Get-Content -Raw -LiteralPath $dataFile) -ne 'USER-RESEARCH-NOTES-DB') { throw 'Safe uninstall lost Data\workspace.db' }
    if ((Get-Content -Raw -LiteralPath $modelFile) -ne 'LOCAL-WHISPER-MODEL-WEIGHTS') { throw 'Safe uninstall lost models file' }
    if ((Get-Content -Raw -LiteralPath $locFile) -ne 'H:\MyCustomData') { throw 'Safe uninstall lost data-location.txt' }
    if ((Get-Content -Raw -LiteralPath $syncFile) -ne 'K:\CloudSync\DoNote') { throw 'Safe uninstall lost FolderSync.txt' }

    # 5. Re-install & full uninstall (--remove-data)
    $null = Invoke-Setup -ExePath $setupV2 -Arguments @(
        '--silent', "--dir=$installDir", "--shortcut-dir=$shortcutDir", "--test-reg-key=$regKeyName"
    ) -LogFile (Join-Path $tempRoot 'reinstall-v2.log')
    $log4 = Invoke-Setup -ExePath $setupV2 -Arguments @(
        '--uninstall', '--silent', '--remove-data', "--dir=$installDir", "--shortcut-dir=$shortcutDir", "--test-reg-key=$regKeyName"
    ) -LogFile (Join-Path $tempRoot 'uninstall-full.log')
    if ($log4 -notmatch '^UNINSTALL_OK .*preserved=False') { throw "Unexpected full uninstall log: $log4" }
    if (Test-Path -LiteralPath $installDir) { throw 'Install directory still exists after --remove-data full uninstall' }

    Write-Host 'PASS: test-setup-installer (verify-only, fresh install, upgrade preserving Data/models, safe uninstall preserving Data/models, full uninstall)'
} finally {
    if (Test-Path -LiteralPath $regPath) { Remove-Item -LiteralPath $regPath -Recurse -Force }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
