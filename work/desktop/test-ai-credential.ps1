$ErrorActionPreference = 'Stop'
$root = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path ('ai-credential-qa-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force $root
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$probe = Join-Path $root 'probe.exe'
& $csc /nologo /target:exe /platform:x64 /codepage:65001 "/out:$probe" /reference:System.Security.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'AiCredentialStore.cs') (Join-Path $PSScriptRoot 'AiCredentialProbe.cs')
if ($LASTEXITCODE -ne 0) { throw 'Credential probe compilation failed.' }
$data = Join-Path $root 'Data'
foreach ($action in 'save','check','forget') {
    & $probe $data $action
    if ($LASTEXITCODE -ne 0) { throw "Credential probe failed: $action" }
}
Write-Output "Credential QA directory: $root"
