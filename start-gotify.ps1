$ErrorActionPreference = 'Stop'
$gotifyRoot = Join-Path $PSScriptRoot 'gotify'
if (-not (Test-Path $gotifyRoot)) {
    New-Item -ItemType Directory -Path $gotifyRoot | Out-Null
}
$exe = Get-ChildItem -Path $gotifyRoot -Recurse -File -Filter 'gotify*.exe' | Select-Object -First 1
if (-not $exe) {
    throw 'Gotify binary not found. Download Windows amd64 from https://github.com/gotify/server/releases and extract into .\gotify\'
}
$secretFile = Join-Path $gotifyRoot 'first-login-password.txt'
if (-not (Test-Path $secretFile)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [System.IO.File]::WriteAllText($secretFile, $password)
    Write-Host 'First-start Gotify administrator password saved locally to gotify\first-login-password.txt'
}
$env:GOTIFY_DEFAULTUSER_NAME = 'admin'
$env:GOTIFY_DEFAULTUSER_PASS = [System.IO.File]::ReadAllText($secretFile).Trim()
$env:GOTIFY_SERVER_LISTENADDR = '127.0.0.1'
$env:GOTIFY_SERVER_PORT = '8780'
$env:GOTIFY_SERVER_SSL_ENABLED = 'false'
$env:GOTIFY_REGISTRATION = 'false'
$env:GOTIFY_DATABASE_CONNECTION = 'data/gotify.db'
$env:GOTIFY_UPLOADEDIMAGESDIR = 'data/images'
$env:GOTIFY_PLUGINSDIR = 'data/plugins'
$env:GOTIFY_MCP_ENABLED = 'false'
New-Item -ItemType Directory -Force -Path (Join-Path $gotifyRoot 'data') | Out-Null
Write-Host 'Starting Gotify on http://127.0.0.1:8780 (local only).'
Write-Host 'The initial password is used only when Gotify creates its database. Change it in the web UI.'
Set-Location $gotifyRoot
& $exe.FullName
