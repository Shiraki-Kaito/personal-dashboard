$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot '..\.security-tools\gitleaks'
New-Item -ItemType Directory -Force $directory | Out-Null
$archive = Join-Path $directory 'gitleaks.zip'
$expected = 'D29144DEFF3A68AA93CED33DDDF84B7FDC26070ADD4AA0F4513094C8332AFC4E'
Invoke-WebRequest 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_windows_x64.zip' -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Gitleaks checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
& (Join-Path $directory 'gitleaks.exe') git . --redact=100 --no-banner --report-format json --report-path (Join-Path $directory 'report.json') *> (Join-Path $directory 'run.log')
if ($LASTEXITCODE -ne 0) { throw 'Gitleaks failed: redacted report is in .security-tools/gitleaks/report.json; do not publish secrets.' }
Write-Output 'Gitleaks 8.30.1: history scan passed (redacted).'
