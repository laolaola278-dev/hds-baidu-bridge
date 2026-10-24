param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [Parameter(Mandatory = $false)]
    [string]$TaskName = 'HDS-Baidu-Backup',
    [Parameter(Mandatory = $false)]
    [int]$EveryMinutes = 60,
    [switch]$Status,
    [switch]$Remove,
    [switch]$Apply
)

# Compatibility wrapper around `hds-baidu backup task`. Registration is opt-in
# through -Apply so a dry run can be reviewed first.
$ErrorActionPreference = 'Stop'
$resolved = [System.IO.Path]::GetFullPath($ProjectRoot)
if ($resolved -match '^[Cc]:') { throw "C: is prohibited: $resolved" }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $resolved 'bin\hds-baidu.mjs'
$env:TEMP = Join-Path $resolved 'var\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$arguments = @($entry, 'backup', 'task', '--name', $TaskName, '--every', "$EveryMinutes")
if ($Status) { $arguments += '--status' }
if ($Remove) { $arguments += '--remove' }
if ($Apply) { $arguments += '--apply' }
& $node @arguments
exit $LASTEXITCODE
