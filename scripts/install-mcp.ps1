param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$Apply
)

# Compatibility wrapper. The canonical implementation lives in the CLI so that
# planning, backup files and rollback stay in one place.
$ErrorActionPreference = 'Stop'
$resolved = [System.IO.Path]::GetFullPath($ProjectRoot)
if ($resolved -match '^[Cc]:') { throw "C: is prohibited: $resolved" }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $resolved 'bin\hds-baidu.mjs'
$env:TEMP = Join-Path $resolved 'var\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$arguments = @($entry, 'install', 'mcp')
if ($Apply) { $arguments += '--apply' }
& $node @arguments
exit $LASTEXITCODE
