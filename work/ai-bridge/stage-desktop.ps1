param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot '../desktop-node-runtime'
$target = Join-Path ([IO.Path]::GetFullPath($Output)) 'ai-bridge'
$null = New-Item -ItemType Directory -Force $runtime, $target

function Get-VerifiedFile([string]$Name, [string]$Uri, [string]$Hash) {
    $path = Join-Path $runtime $Name
    if ((Test-Path -LiteralPath $path -PathType Leaf) -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $Hash) {
        return $path
    }
    $temporary = "$path.download"
    try {
        & curl.exe --fail --silent --show-error --retry 2 $Uri -o $temporary
        if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $Hash) {
            throw "Could not verify the Node.js runtime file $Name."
        }
        Copy-Item -LiteralPath $temporary -Destination $path -Force
        return $path
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary }
    }
}

$node = Get-VerifiedFile 'node.exe' 'https://nodejs.org/dist/v24.22.1/win-x64/node.exe' 'D702DAA815EABBFF763C7D3808E235CF031CF2CA70211B56847BC72F51E240E5'
$license = Get-VerifiedFile 'LICENSE.txt' 'https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE' '5888DBB9A1D2B18F2C3E6C5F6AF1B39DE658372B402A0577B002777F14C62ACE'
Copy-Item -LiteralPath $node -Destination (Join-Path $target 'node.exe') -Force
Copy-Item -LiteralPath $license -Destination (Join-Path $target 'Node-LICENSE.txt') -Force
$files = @('server.mjs', 'mcp.mjs', 'openapi.json', 'adapter.py', 'Dockerfile', '.dockerignore', 'Start-Local.cmd')
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target -Force
}
