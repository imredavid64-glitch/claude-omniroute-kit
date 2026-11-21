# Builds dist\ClaudeOmniRouteSetup.exe using IExpress (built into Windows; no extra tools needed).
# Usage:  powershell -ExecutionPolicy Bypass -File packaging\windows\build-exe.ps1
$ErrorActionPreference = 'Stop'
$kit = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dist = Join-Path $kit 'dist'
$stage = Join-Path ([IO.Path]::GetTempPath()) ("kit-exe-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $dist, $stage | Out-Null

# Refuse to package anything that looks like a secret.
& node (Join-Path $kit 'tools\scan-secrets.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Secret scan failed; not building.' }

# payload.zip = the kit minus build output, VCS and packaging scaffolding (zip entries use forward slashes).
$src = Join-Path $stage 'src'
New-Item -ItemType Directory -Force $src | Out-Null
robocopy $kit $src /E /XD dist packaging .git node_modules /XF *.zip /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
& tar.exe -a -c -f (Join-Path $stage 'payload.zip') -C $src .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
Copy-Item (Join-Path $PSScriptRoot 'setup.cmd'), (Join-Path $PSScriptRoot 'setup.ps1') $stage

$exe = Join-Path $dist 'ClaudeOmniRouteSetup.exe'
if (Test-Path $exe) { Remove-Item -Force $exe }
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=<None>
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=This sets up Claude Code with an OmniRoute gateway (provider failover + token optimization) on this computer. It may install Node.js and RTK. Continue?
DisplayLicense=
FinishMessage=
TargetName=$exe
FriendlyName=Claude OmniRoute Setup
AppLaunched=cmd /c setup.cmd
AdminQuietInstCmd=cmd /c setup.cmd
UserQuietInstCmd=cmd /c setup.cmd
FILE0="setup.cmd"
FILE1="setup.ps1"
FILE2="payload.zip"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
$sedPath = Join-Path $stage 'kit.sed'
Set-Content -Path $sedPath -Value $sed -Encoding ASCII
Start-Process -FilePath "$env:WINDIR\System32\iexpress.exe" -ArgumentList '/N', '/Q', "`"$sedPath`"" -Wait -NoNewWindow
for ($i = 0; $i -lt 60 -and -not (Test-Path $exe); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $exe)) { throw 'IExpress did not produce the exe.' }
Copy-Item (Join-Path $stage 'payload.zip') (Join-Path $dist 'kit-payload.zip') -Force
Remove-Item -Recurse -Force $stage
Write-Host ("Built {0} ({1:N0} KB)" -f $exe, ((Get-Item $exe).Length / 1KB))
Write-Host 'Unsigned: Windows SmartScreen will warn ("Unknown publisher"). Sign it to remove the warning.'
