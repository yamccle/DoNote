param(
    [Parameter(Mandatory=$true)][string]$Baseline,
    [Parameter(Mandatory=$true)][string]$Target,
    [Parameter(Mandatory=$true)][string]$Destination,
    [Parameter(Mandatory=$true)][string]$BaseVersion,
    [Parameter(Mandatory=$true)][string]$ReleaseVersion
)
$ErrorActionPreference='Stop'
[void][Version]::Parse($BaseVersion)
[void][Version]::Parse($ReleaseVersion)
if([Version]::Parse($ReleaseVersion) -le [Version]::Parse($BaseVersion)){throw 'ReleaseVersion must be newer than BaseVersion.'}
$baselinePath=(Resolve-Path -LiteralPath $Baseline).Path.TrimEnd('\')
$targetPath=(Resolve-Path -LiteralPath $Target).Path.TrimEnd('\')
$destinationPath=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $destinationPath){throw 'Destination already exists; choose a new patch filename.'}
$baselineManifest=Get-Content -LiteralPath (Join-Path $baselinePath 'release-manifest.json') -Raw | ConvertFrom-Json
if($baselineManifest.version -ne $BaseVersion){throw "Baseline manifest is $($baselineManifest.version), expected $BaseVersion."}
$targetManifest=Get-Content -LiteralPath (Join-Path $targetPath 'release-manifest.json') -Raw | ConvertFrom-Json
if($targetManifest.version -ne $ReleaseVersion){throw "Target manifest is $($targetManifest.version), expected $ReleaseVersion."}
$baselineFiles=@{}
foreach($file in $baselineManifest.files){$baselineFiles[$file.path]=$file}
$changed=@()
foreach($entry in $targetManifest.files){
    $relative=$entry.path
    if($relative.StartsWith('Data/',[StringComparison]::OrdinalIgnoreCase)){continue}
    $old=$baselineFiles[$relative]
    if(!$old -or [int64]$old.size -ne [int64]$entry.size -or $old.sha256 -ne $entry.sha256){
        $fullName=Join-Path $targetPath $relative.Replace('/',[IO.Path]::DirectorySeparatorChar)
        if(!(Test-Path -LiteralPath $fullName)){throw "Target file missing: $relative"}
        $changed+=@{path=$relative;fullName=$fullName;size=[int64]$entry.size;sha256=$entry.sha256}
    }
}
if(!($changed.path -contains 'DoNote.exe')){
    $program=Join-Path $targetPath 'DoNote.exe'
    if(!(Test-Path -LiteralPath $program)){throw 'Target is missing DoNote.exe.'}
    $targetProgram=$targetManifest.files | Where-Object {$_.path -eq 'DoNote.exe'} | Select-Object -First 1
    $changed+=@{path='DoNote.exe';fullName=$program;size=[int64]$targetProgram.size;sha256=$targetProgram.sha256}
}
$staging=Join-Path ([IO.Path]::GetTempPath()) ('donote-patch-'+[Guid]::NewGuid().ToString('N'))
try{
    foreach($file in $changed){
        $copy=Join-Path $staging $file.path.Replace('/',[IO.Path]::DirectorySeparatorChar)
        $null=New-Item -ItemType Directory -Force (Split-Path $copy)
        Copy-Item -LiteralPath $file.fullName -Destination $copy
    }
    $files=@($changed | ForEach-Object {@{path=$_.path;size=$_.size;sha256=$_.sha256}} | Sort-Object {$_.path})
    $manifest=@{version=$ReleaseVersion;baseVersion=$BaseVersion;requiresDataBackup=$false;files=$files} | ConvertTo-Json -Depth 6 -Compress
    [IO.File]::WriteAllText((Join-Path $staging 'release-manifest.json'),$manifest,[Text.Encoding]::UTF8)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive=[IO.Compression.ZipFile]::Open($destinationPath,[IO.Compression.ZipArchiveMode]::Create)
    try{
        Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object {
            $relative=$_.FullName.Substring($staging.Length+1).Replace('\','/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$_.FullName,$relative,[IO.Compression.CompressionLevel]::Optimal)
        }
    }finally{$archive.Dispose()}
    $probe=Join-Path $env:TEMP ('donote-patch-probe-'+[Guid]::NewGuid().ToString('N')+'.exe')
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $compiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$probe" /main:UpdateProbe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'UpdateProbe.cs') (Join-Path $PSScriptRoot 'UpdateHost.cs') (Join-Path $PSScriptRoot 'UpdatePackage.cs')
    if($LASTEXITCODE -ne 0){throw 'Patch validator compilation failed.'}
    & $probe $destinationPath
    if($LASTEXITCODE -ne 0){throw 'Patch rejected by desktop installer validator.'}
    [pscustomobject]@{Destination=$destinationPath;BaseVersion=$BaseVersion;Version=$ReleaseVersion;Files=$changed.Count;Size=(Get-Item -LiteralPath $destinationPath).Length}
}finally{
    if(Test-Path -LiteralPath $staging){Remove-Item -LiteralPath $staging -Recurse -Force}
}
