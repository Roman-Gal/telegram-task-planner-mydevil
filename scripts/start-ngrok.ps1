$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.env')) { throw 'Copy .env.example to .env and fill TELEGRAM_BOT_TOKEN and WEBHOOK_SECRET first.' }
$ngrokCommand = Get-Command ngrok -ErrorAction SilentlyContinue
$localNgrok = Join-Path $projectRoot '.tools\ngrok\ngrok.exe'
$ngrokExecutable = if ($ngrokCommand) { $ngrokCommand.Source } elseif (Test-Path -LiteralPath $localNgrok) { $localNgrok } else { $null }
if (-not $ngrokExecutable) { throw 'Install ngrok in PATH or .tools\ngrok\ngrok.exe, then configure its authtoken.' }
$ngrokConfig = Join-Path $projectRoot '.tools\ngrok\ngrok.yml'
$portLine = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -Last 1
$plannerPort = if ($portLine) { ($portLine -split '=',2)[1].Trim().Trim('"').Trim("'") } else { '8080' }
if ($plannerPort -notmatch '^\d+$' -or [int]$plannerPort -lt 1 -or [int]$plannerPort -gt 65535) { throw 'Invalid PORT in .env.' }
New-Item -ItemType Directory -Path 'data' -Force | Out-Null
try {
    $null = Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 1
    throw 'An ngrok agent is already using port 4040. Stop it or use the manual README instructions.'
} catch {
    if ($_.Exception.Message -like 'An ngrok agent*') { throw }
}
$previousUrl = $env:PUBLIC_BASE_URL
$ngrokArguments = @('http', $plannerPort, '--log=data/ngrok.log', '--log-format=json')
if (Test-Path -LiteralPath $ngrokConfig) { $ngrokArguments += '--config=.tools/ngrok/ngrok.yml' }
$ngrokProcess = Start-Process -FilePath $ngrokExecutable -ArgumentList $ngrokArguments -WindowStyle Hidden -PassThru
try {
    $tunnelUrl = $null
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($ngrokProcess.HasExited) { throw 'ngrok exited. Check data/ngrok.log and your ngrok account configuration.' }
        try {
            $tunnels = Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 1
            $tunnelUrl = ($tunnels.tunnels | Where-Object { $_.proto -eq 'https' -and $_.config.addr -match ":$plannerPort/?$" } | Select-Object -First 1).public_url
            if ($tunnelUrl) { break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $tunnelUrl) { throw 'No HTTPS tunnel found. Check data/ngrok.log.' }
    $env:PUBLIC_BASE_URL = $tunnelUrl
    Write-Host "ngrok tunnel ready: $tunnelUrl"
    & npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw "Planner exited with code $LASTEXITCODE" }
} finally {
    $env:PUBLIC_BASE_URL = $previousUrl
    if (-not $ngrokProcess.HasExited) { Stop-Process -Id $ngrokProcess.Id }
}
