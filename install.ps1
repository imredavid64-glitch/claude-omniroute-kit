# claude-omniroute-kit bootstrap (Windows). Passes all arguments through to the Node installer.
$ErrorActionPreference = 'Stop'

function Test-NodeOk {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $false }
  $v = [version](& node -p "process.versions.node")
  if ($v.Major -eq 22) { return ($v.Minor -gt 22) -or ($v.Minor -eq 22 -and $v.Build -ge 2) }
  return ($v.Major -ge 24 -and $v.Major -lt 27)
}

if (-not (Test-NodeOk)) {
  Write-Host "Node.js 22.22.2+ (or 24.x-26.x) is required by OmniRoute." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $a = Read-Host "Install Node.js LTS with winget now? [Y/n]"
    if ($a -eq '' -or $a -match '^[Yy]') {
      winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
      Write-Host "Node installed. Open a NEW terminal and run .\install.ps1 again." -ForegroundColor Green
    }
  } else {
    Write-Host "Install Node LTS from https://nodejs.org and run this script again."
  }
  exit 1
}

& node (Join-Path $PSScriptRoot 'installer\install.mjs') @args
exit $LASTEXITCODE
