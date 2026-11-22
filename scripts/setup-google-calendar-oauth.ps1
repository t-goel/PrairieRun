# Launcher for the Google Calendar OAuth wizard on Windows (Git Bash).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/setup-google-calendar-oauth.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$wizard = Join-Path $PSScriptRoot "setup-google-calendar-oauth.sh"
$bash = @(
  "${env:ProgramFiles}\Git\bin\bash.exe",
  "${env:ProgramFiles(x86)}\Git\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bash) {
  Write-Host "Git Bash not found. Install Git for Windows, then re-run." -ForegroundColor Yellow
  Write-Host "Or open Git Bash and run:  bash scripts/setup-google-calendar-oauth.sh"
  exit 1
}

Write-Host ""
Write-Host "PrairieRun · Google Calendar OAuth wizard" -ForegroundColor Cyan
Write-Host ""
Write-Host "Where to get your extension ID (you will need it in stage 1):" -ForegroundColor White
Write-Host "  1. In Helium open:  helium://extensions"
Write-Host "     (Chrome: chrome://extensions · Brave: brave://extensions)"
Write-Host "  2. Turn on Developer mode (top right)."
Write-Host "  3. Find PrairieRun → copy the 32-character ID under the name."
Write-Host "     Letters are only a–p. Example: mnamlokfacnefhemchmhgnhcicolbdki"
Write-Host ""
Write-Host "Starting wizard…" -ForegroundColor DarkGray
Write-Host ""

Set-Location $root
& $bash $wizard
exit $LASTEXITCODE
