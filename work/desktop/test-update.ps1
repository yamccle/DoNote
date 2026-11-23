param([string]$Root = (Join-Path $PSScriptRoot '../update-qa'), [string]$ReleaseZip)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$workRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\') + '\'
if (-not $Root.StartsWith($workRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'QA root must be inside work.' }
$Root = Join-Path $Root ([Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force $Root
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$probe = Join-Path $Root 'probe.exe'
& $csc /nologo /target:exe /platform:x64 /codepage:65001 "/out:$probe" /main:UpdateProbe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'UpdateProbe.cs') (Join-Path $PSScriptRoot 'UpdateHost.cs') (Join-Path $PSScriptRoot 'UpdatePackage.cs')
if ($LASTEXITCODE -ne 0) { throw 'Probe compilation failed.' }
if ($ReleaseZip) {
    & $probe ([IO.Path]::GetFullPath($ReleaseZip))
    if ($LASTEXITCODE -ne 0) { throw 'Release ZIP validation failed.' }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$payload = Join-Path $Root 'payload'
$null = New-Item -ItemType Directory -Force $payload
$null = New-Item -ItemType Directory -Force (Join-Path $payload 'ai-bridge')
[IO.File]::WriteAllText((Join-Path $payload 'DoNote.exe'), 'new program')
[IO.File]::WriteAllText((Join-Path $payload 'extra.txt'), 'new file')
[IO.File]::WriteAllText((Join-Path $payload 'ai-bridge/adapter.py'), 'new adapter')
[IO.File]::WriteAllText((Join-Path $payload 'ai-bridge/node.exe'), 'new runtime')
$files = @(Get-ChildItem -LiteralPath $payload -Recurse -File | ForEach-Object { @{ path=$_.FullName.Substring($payload.Length+1).Replace('\','/'); size=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
$manifest = @{ version='26.1105.0002'; requiresDataBackup=$false; files=$files } | ConvertTo-Json -Compress -Depth 5
[IO.File]::WriteAllText((Join-Path $payload 'release-manifest.json'), $manifest)
$zip = Join-Path $Root 'update.zip'
function New-QAZip([string]$target) {
    $archive = [IO.Compression.ZipFile]::Open($target, [IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -LiteralPath $payload -Recurse -File | ForEach-Object {
            $relative = $_.FullName.Substring($payload.Length+1).Replace('\','/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
}
New-QAZip $zip
$migrationZip = Join-Path $Root 'data-migration-update.zip'
$manifest = @{ version='26.1105.0002'; requiresDataBackup=$true; files=$files } | ConvertTo-Json -Compress -Depth 5
[IO.File]::WriteAllText((Join-Path $payload 'release-manifest.json'), $manifest)
New-QAZip $migrationZip
$corruptZip = Join-Path $Root 'corrupt-update.zip'
[IO.File]::WriteAllText((Join-Path $payload 'release-manifest.json'), $manifest)
[IO.File]::WriteAllText((Join-Path $payload 'extra.txt'), 'bad file')
New-QAZip $corruptZip
$oldManifest = '{"version":"26.1105.0001"}'
foreach ($case in 'success','success-default-data','rollback','rollback-new-file','rollback-nested','locked-unchanged','locked-changed','migration-backup','corrupt-package','custom-data-protection') {
    $base = Join-Path $Root $case
    $install = Join-Path $base 'install'
    $data = if ($case -eq 'success-default-data') { Join-Path $install 'Data' }
        elseif ($case -eq 'custom-data-protection') { Join-Path $install 'ai-bridge' }
        else { Join-Path $base 'user-data' }
    $null = New-Item -ItemType Directory -Force $install,$data,(Join-Path $install 'ai-bridge')
    [IO.File]::WriteAllText((Join-Path $install 'DoNote.exe'), 'old program')
    [IO.File]::WriteAllText((Join-Path $install 'release-manifest.json'), $oldManifest)
    [IO.File]::WriteAllText((Join-Path $install 'ai-bridge/adapter.py'), 'old adapter')
    [IO.File]::WriteAllText((Join-Path $install 'ai-bridge/node.exe'), $(if ($case -eq 'locked-unchanged') {'new runtime'} else {'old runtime'}))
    [IO.File]::WriteAllText((Join-Path $data 'paper.pdf'), 'user paper')
    $failAfter = if ($case -eq 'rollback') { 1 } elseif ($case -eq 'rollback-new-file') { 2 } elseif ($case -eq 'rollback-nested') { 3 } else { -1 }
    $package = if ($case -eq 'migration-backup') { $migrationZip }
        elseif ($case -eq 'corrupt-package') { $corruptZip }
        else { $zip }
    if ($case.StartsWith('locked')) { & $probe $package $install $data $failAfter (Join-Path $install 'ai-bridge/node.exe') }
    else { & $probe $package $install $data $failAfter }
    $result = $LASTEXITCODE
    $isSuccess = $case.StartsWith('success') -or $case -eq 'locked-unchanged' -or $case -eq 'migration-backup'
    if ($isSuccess -and $result -ne 0) { throw 'Successful update failed.' }
    if (-not $isSuccess -and $result -eq 0) { throw 'Forced failure unexpectedly succeeded.' }
    $expected = if ($isSuccess) { 'new program' } else { 'old program' }
    if ([IO.File]::ReadAllText((Join-Path $install 'DoNote.exe')) -ne $expected) { throw "Program mismatch: $case" }
    if ([IO.File]::ReadAllText((Join-Path $data 'paper.pdf')) -ne 'user paper') { throw "Data mismatch: $case" }
    if (-not $isSuccess -and [IO.File]::ReadAllText((Join-Path $install 'release-manifest.json')) -ne $oldManifest) { throw 'Manifest rollback failed.' }
    if ($isSuccess -and -not (Test-Path -LiteralPath (Join-Path $install 'extra.txt'))) { throw 'New file missing.' }
    if (-not $isSuccess -and (Test-Path -LiteralPath (Join-Path $install 'extra.txt'))) { throw 'New file survived rollback.' }
    $expectedAdapter = if ($isSuccess) { 'new adapter' } else { 'old adapter' }
    if ([IO.File]::ReadAllText((Join-Path $install 'ai-bridge/adapter.py')) -ne $expectedAdapter) { throw "Nested rollback mismatch: $case" }
    $expectedRuntime = if ($isSuccess) { 'new runtime' } else { 'old runtime' }
    if ([IO.File]::ReadAllText((Join-Path $install 'ai-bridge/node.exe')) -ne $expectedRuntime) { throw "Runtime mismatch: $case" }
    $backupRoot = Join-Path $base 'DoNote-Backups'
    if ($case -eq 'corrupt-package' -or $case -eq 'custom-data-protection') {
        if (Test-Path -LiteralPath $backupRoot) { throw "Update must reject invalid inputs before the backup and installation: $case" }
        if (Get-ChildItem -LiteralPath $install -Force -Directory -Filter '.update-*') { throw "Update staging was not removed: $case" }
        Write-Output "$case OK"
        continue
    }
    $backup = Get-ChildItem -LiteralPath $backupRoot -Directory | Select-Object -First 1
    if (-not $backup -or -not (Test-Path -LiteralPath (Join-Path $backup.FullName 'Program/DoNote.exe'))) { throw "Program backup missing: $case" }
    if (Test-Path -LiteralPath (Join-Path $backup.FullName 'update-package.zip')) { throw "Redundant package backup: $case" }
    $dataBackedUp = Test-Path -LiteralPath (Join-Path $backup.FullName 'Data/paper.pdf')
    if ($dataBackedUp -ne ($case -eq 'migration-backup')) { throw "Data backup policy mismatch: $case" }
    Write-Output "$case OK"
}
Write-Output "QA directory: $Root"
