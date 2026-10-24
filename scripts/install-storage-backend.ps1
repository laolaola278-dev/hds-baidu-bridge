param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = 'G:\project\deepseek-harness\work_hds\hds-baidu-bridge',
    [switch]$Apply,
    [switch]$SwitchDomain
)

# Compatibility wrapper around `hds-baidu install storage` and, optionally,
# `hds-baidu install domain`. Registering the backend and switching the domain
# layer are separate steps on purpose: the switch changes durability semantics
# for every DSH storage write.
$ErrorActionPreference = 'Stop'
$resolved = [System.IO.Path]::GetFullPath($ProjectRoot)
if ($resolved -match '^[Cc]:') { throw "C: is prohibited: $resolved" }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $resolved 'bin\hds-baidu.mjs'
$env:TEMP = Join-Path $resolved 'var\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$storage = @($entry, 'install', 'storage')
if ($Apply) { $storage += '--apply' }
& $node @storage
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($SwitchDomain) {
    $domain = @($entry, 'install', 'domain')
    if ($Apply) { $domain += '--apply' }
    & $node @domain
    exit $LASTEXITCODE
}
Write-Output 'Storage backend step only. Re-run with -SwitchDomain to change storage-domain.backend.'
