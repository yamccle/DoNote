param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination,[switch]$Fast)
$ErrorActionPreference='Stop'
$sourcePath=(Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
$destinationPath=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $destinationPath){throw 'Destination already exists; choose a new package filename.'}
if(!(Test-Path -LiteralPath (Join-Path $sourcePath 'release-manifest.json'))){throw 'Release manifest missing.'}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::Open($destinationPath,[IO.Compression.ZipArchiveMode]::Create)
$compression=if($Fast){[IO.Compression.CompressionLevel]::Fastest}else{[IO.Compression.CompressionLevel]::Optimal}
try{
 foreach($file in Get-ChildItem -LiteralPath $sourcePath -Recurse -File){
  $relative=$file.FullName.Substring($sourcePath.Length+1).Replace('\','/')
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relative,$compression)
 }
}finally{$archive.Dispose()}
# Validate using the exact reader shared by the desktop installer, not a separate ZIP heuristic.
$probe=Join-Path $env:TEMP ('donote-package-probe-'+[Guid]::NewGuid().ToString('N')+'.exe')
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:exe /platform:x64 /codepage:65001 "/out:$probe" /main:UpdateProbe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'UpdateProbe.cs') (Join-Path $PSScriptRoot 'UpdateHost.cs') (Join-Path $PSScriptRoot 'UpdatePackage.cs')
if($LASTEXITCODE -ne 0){throw 'Package validator compilation failed.'}
& $probe $destinationPath
if($LASTEXITCODE -ne 0){throw 'Package rejected by desktop installer validator.'}
Get-Item -LiteralPath $destinationPath | Select-Object FullName,Length
