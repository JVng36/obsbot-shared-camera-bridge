[CmdletBinding()]
param(
    [ValidateRange(1, 10080)]
    [int]$Minutes = 30
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$ConfigPath = Join-Path $Root 'secrets.json'
$VendorRoot = Join-Path $Root 'vendor\obsbot-mcp'
$EntryPoint = Join-Path $Root 'src\main.js'

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing private bridge configuration: $ConfigPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $VendorRoot 'dist\mcp\tools.js'))) {
    throw "Reviewed OBSBOT device layer is not built. Run the installation verification first."
}
if (-not (Test-Path -LiteralPath (Join-Path $VendorRoot 'native\prebuilt\win32-x64\obsbot-helper.exe'))) {
    throw "Locally built OBSBOT helper is missing."
}

$Center = @(Get-Process -Name 'OBSBOT_Center', 'OBSBOT_Main' -ErrorAction SilentlyContinue)
if ($Center.Count -gt 0) {
    Write-Host ''
    Write-Host 'OBSBOT Center is still running.' -ForegroundColor Yellow
    Write-Host 'Close OBSBOT Center completely, including its tray process, then launch this again.'
    Write-Host 'The shared bridge refuses to compete with another camera owner.'
    throw 'OBSBOT Center must be closed before a shared camera session starts.'
}

$Models = @((Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10).models.name)
if ($Models -notcontains 'qwen3-vl:8b') {
    throw 'Local vision model qwen3-vl:8b is unavailable. Run: ollama pull qwen3-vl:8b'
}

$Node = (Get-Command node -ErrorAction Stop).Source
$Host.UI.RawUI.WindowTitle = "SHARED CAMERA ACTIVE - $Minutes min"
Clear-Host
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  SHARED CAMERA SESSION IS ACTIVE' -ForegroundColor Cyan
Write-Host "  Duration: $Minutes minute(s)"
Write-Host '  Raw frames: host memory -> local Qwen3-VL only'
Write-Host '  Agent output: text-only observations'
Write-Host '  Shared VLM prompt: live-editable, session-scoped, revisioned'
Write-Host '  Operator editor: Edit Shared VLM Prompt.cmd'
Write-Host '  Stop now: Ctrl+C, or tell an authorized agent to stop looking'
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

& $Node $EntryPoint `
    --config $ConfigPath `
    --vendor-root $VendorRoot `
    --minutes $Minutes
$ExitCode = $LASTEXITCODE

Write-Host ''
if ($ExitCode -eq 0) {
    Write-Host 'Shared camera session ended and cleanup completed.' -ForegroundColor Green
} else {
    Write-Host "Shared camera exited with code $ExitCode. The camera may need manual privacy mode or unplugging." -ForegroundColor Red
}
exit $ExitCode
