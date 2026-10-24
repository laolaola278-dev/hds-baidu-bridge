param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = 'G:\project\deepseek-harness\work_hds\hds-baidu-bridge'
)

$ErrorActionPreference = 'Stop'

# Hard safety boundary: this project must never create files on C:.
$resolved = [System.IO.Path]::GetFullPath($ProjectRoot)
if ($resolved -match '^[Cc]:') {
    throw "Refusing to use a C: project root: $resolved"
}
if (-not (Test-Path -LiteralPath $resolved)) {
    throw "Project root not found: $resolved"
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $resolved 'bin\hds-baidu.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "Entry point not found: $entry"
}

Write-Output "Node: $node"
Write-Output "Entry: $entry"
Write-Output 'Running doctor with C: writes prohibited...'
$env:TEMP = Join-Path $resolved 'var\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
& $node $entry doctor
exit $LASTEXITCODE
