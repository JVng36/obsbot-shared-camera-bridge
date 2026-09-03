[CmdletBinding()]
param(
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LockPath = Join-Path $RepoRoot 'vendor.lock.json'

if ($env:OS -ne 'Windows_NT') {
    throw 'The OBSBOT native adapter bootstrap must run on 64-bit Windows.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'The OBSBOT native adapter requires 64-bit Windows.'
}
if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
    throw "Missing vendor lock: $LockPath"
}

$Lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
if ([string]$Lock.repository -notmatch '^https://github\.com/[^/]+/[^/]+$') {
    throw 'vendor.lock.json must contain an HTTPS GitHub repository URL.'
}
if ([string]$Lock.commit -notmatch '^[a-f0-9]{40}$') {
    throw 'vendor.lock.json must pin a full lowercase commit ID.'
}

$PatchPath = Join-Path $RepoRoot ([string]$Lock.hardening.patch)
if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) {
    throw "Missing reviewed vendor hardening patch: $PatchPath"
}
if (-not $Destination) {
    $Destination = Join-Path $RepoRoot 'vendor\obsbot-mcp'
}
$Destination = [System.IO.Path]::GetFullPath($Destination)

# Refuses to overwrite any existing destination, even an incomplete prior attempt.
if (Test-Path -LiteralPath $Destination) {
    throw "Bootstrap refuses to overwrite existing destination: $Destination"
}

foreach ($Command in @('git', 'node', 'npm', 'cmake')) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "Required command is unavailable: $Command"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

$Parent = Split-Path -Parent $Destination
[void](New-Item -ItemType Directory -Path $Parent -Force)

Write-Host "Cloning pinned OBSBOT adapter into $Destination" -ForegroundColor Cyan
Invoke-Checked -FilePath 'git' -Arguments @('clone', '--no-checkout', [string]$Lock.repository, $Destination)
Invoke-Checked -FilePath 'git' -Arguments @('-C', $Destination, 'checkout', '--detach', [string]$Lock.commit)

$ActualCommit = (& git -C $Destination rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $ActualCommit -ne [string]$Lock.commit) {
    throw "Pinned vendor commit verification failed. Expected $($Lock.commit), got $ActualCommit"
}

Invoke-Checked -FilePath 'git' -Arguments @('-C', $Destination, 'apply', '--check', $PatchPath)
Invoke-Checked -FilePath 'git' -Arguments @('-C', $Destination, 'apply', $PatchPath)

Push-Location $Destination
try {
    Invoke-Checked -FilePath 'npm' -Arguments @('ci')
    Invoke-Checked -FilePath 'npm' -Arguments @('audit', '--omit=dev')
    Invoke-Checked -FilePath 'npm' -Arguments @('run', 'build')
    Invoke-Checked -FilePath 'npm' -Arguments @('test')
    Invoke-Checked -FilePath 'npm' -Arguments @('run', 'build:helper')

    $Helper = Join-Path $Destination 'native\prebuilt\win32-x64\obsbot-helper.exe'
    if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) {
        throw "Native helper build did not produce the expected file: $Helper"
    }
    $HelperHash = (Get-FileHash -LiteralPath $Helper -Algorithm SHA256).Hash.ToLowerInvariant()
}
finally {
    Pop-Location
}

Write-Host 'Pinned OBSBOT adapter reconstruction passed.' -ForegroundColor Green
[pscustomobject]@{
    repository = [string]$Lock.repository
    commit = $ActualCommit
    helper = $Helper
    helperSha256 = $HelperHash
    productionAudit = 'passed'
    upstreamTests = 'passed'
}
