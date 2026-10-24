param(
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$resolved = [System.IO.Path]::GetFullPath($ProjectRoot)
if ($resolved -match '^[Cc]:') { throw "Refusing C: path: $resolved" }
$state = Join-Path $resolved 'state'
$target = Join-Path $state 'credentials.json'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$document = @{ accessToken = $Token.Trim(); savedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
# Write with a restrictive ACL: current user only.
$temp = Join-Path $state ("credentials.{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
[System.IO.File]::WriteAllText($temp, $document, (New-Object System.Text.UTF8Encoding($false)))
$acl = Get-Acl -LiteralPath $temp
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
    'FullControl',
    'Allow'
)
$acl.AddAccessRule($rule) | Out-Null
Set-Acl -LiteralPath $temp -AclObject $acl
Move-Item -LiteralPath $temp -Destination $target -Force
Write-Output "Token saved to $target (G: only)."
