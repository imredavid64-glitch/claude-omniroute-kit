# Runs inside the self-extracting ClaudeOmniRouteSetup.exe (and can be run directly for testing).
# 1) unpack the kit  2) make sure a supported Node.js exists  3) run the interactive installer.
# Env knobs (testing/support): OMNIROUTE_KIT_HOME, OMNIROUTE_KIT_ARGS (e.g. "--dry-run"), OMNIROUTE_KIT_NOPAUSE=1
$ErrorActionPreference = 'Stop'
$kitHome = if ($env:OMNIROUTE_KIT_HOME) { $env:OMNIROUTE_KIT_HOME } else { Join-Path $env:LOCALAPPDATA 'claude-omniroute-kit' }
New-Item -ItemType Directory -Force $kitHome | Out-Null
$log = Join-Path $kitHome 'setup.log'
try { Start-Transcript -Path $log -Force | Out-Null } catch {}

function Pause-IfInteractive {
  if (-not $env:OMNIROUTE_KIT_NOPAUSE) { Read-Host 'Press Enter to close' | Out-Null }
}
function Fail($msg) {
  Write-Host "`n$msg" -ForegroundColor Red
  Write-Host "Details were saved to $log" -ForegroundColor Yellow
  try { Stop-Transcript | Out-Null } catch {}
  Pause-IfInteractive
  exit 1
}
function Test-NodeOk {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $false }
  $v = [version](& node -p 'process.versions.node')
  if ($v.Major -eq 22) { return ($v.Minor -gt 22) -or ($v.Minor -eq 22 -and $v.Build -ge 2) }
  return ($v.Major -ge 24 -and $v.Major -lt 27)
}
function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host ''
Write-Host '  Claude Code + OmniRoute setup' -ForegroundColor Cyan
Write-Host '  Provider failover, token optimization, secure defaults.' -ForegroundColor DarkGray
Write-Host ''

# 1) unpack ------------------------------------------------------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $here 'payload.zip'
$app = Join-Path $kitHome 'app'
if (-not (Test-Path $payload)) { Fail "payload.zip is missing next to setup.ps1 ($here)." }
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Expand-Archive -Path $payload -DestinationPath $app -Force
Write-Host "  + Installed files to $app"

# 2) Node.js -----------------------------------------------------------------
if (-not (Test-NodeOk)) {
  Write-Host '  ! OmniRoute needs Node.js 22.22.2+ (or 24-26). Installing Node.js LTS...' -ForegroundColor Yellow
  $done = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    $done = Test-NodeOk
  }
  if (-not $done) {
    try {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $sums = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
      $file = ([regex]::Match($sums, "node-v24\.\d+\.\d+-$arch\.msi")).Value
      if (-not $file) { throw 'could not find the Node MSI name' }
      $msi = Join-Path $env:TEMP $file
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v24.x/$file" -OutFile $msi
      Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Wait
      Update-SessionPath
    } catch { Write-Host "  ! Direct download failed: $($_.Exception.Message)" -ForegroundColor Yellow }
  }
  if (-not (Test-NodeOk)) { Fail 'Node.js could not be installed automatically. Install Node.js LTS from https://nodejs.org, then run this setup again.' }
}
Write-Host "  + Node.js $(& node -p 'process.versions.node') ready"

# 3) shortcuts so users can re-run / check health later ------------------------
try {
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude OmniRoute'
  New-Item -ItemType Directory -Force $menu | Out-Null
  $sh = New-Object -ComObject WScript.Shell
  foreach ($e in @(@('Setup (re-run)', 'installer\install.mjs'), @('Health check', 'installer\doctor.mjs'))) {
    $l = $sh.CreateShortcut((Join-Path $menu "$($e[0]).lnk"))
    $l.TargetPath = 'cmd.exe'
    $l.Arguments = "/k node `"$(Join-Path $app $e[1])`""
    $l.WorkingDirectory = $app
    $l.Save()
  }
  Write-Host "  + Start menu shortcuts: $menu"
} catch { Write-Host '  - Could not create Start menu shortcuts (not critical).' }

# 4) the actual setup ----------------------------------------------------------
Write-Host "`n  Starting setup...`n" -ForegroundColor Cyan
$kitArgs = @()
# @(...) matters: a single argument would otherwise collapse to a plain string and be dropped when splatted.
if ($env:OMNIROUTE_KIT_ARGS) { $kitArgs = @($env:OMNIROUTE_KIT_ARGS -split '\s+' | Where-Object { $_ }) }
& node (Join-Path $app 'installer\install.mjs') @kitArgs
$code = $LASTEXITCODE
try { Stop-Transcript | Out-Null } catch {}
if ($code -ne 0) { Write-Host "`nSetup stopped (exit $code). See $log" -ForegroundColor Yellow }
Pause-IfInteractive
exit $code
