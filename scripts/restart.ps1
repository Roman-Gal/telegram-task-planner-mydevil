$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.env')) { throw 'Missing .env. Configure the bot before starting it.' }
New-Item -ItemType Directory -Path 'data' -Force | Out-Null
try {
    $restartLock = [System.IO.File]::Open((Join-Path $projectRoot 'data\restart.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch { throw 'Another restart is already running. Wait until it finishes.' }
try {
    if (Test-Path -LiteralPath 'data/runtime.json') {
        $runtime = Get-Content -Raw -LiteralPath 'data/runtime.json' | ConvertFrom-Json
        if (-not $runtime.launcher_pid -or -not $runtime.started_at) { throw 'Invalid runtime metadata; no processes stopped.' }
        $rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([uint32]$runtime.launcher_pid)"
        if ($rootProcess) {
            if ($rootProcess.Name -ne 'powershell.exe' -or $rootProcess.CommandLine -notmatch 'scripts[\\/]start-ngrok\.ps1') { throw 'Launcher identity mismatch; no processes stopped.' }
            $expectedStart = [datetimeoffset]$runtime.started_at
            if ([Math]::Abs(($rootProcess.CreationDate.ToUniversalTime() - $expectedStart.UtcDateTime).TotalSeconds) -gt 10) { throw 'Launcher creation time mismatch; no processes stopped.' }
            $processes = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
            $processIds = @([uint32]$runtime.launcher_pid)
            for ($depth=0; $depth -lt 10; $depth++) {
                $children = @($processes | Where-Object { $_.ParentProcessId -in $processIds -and $_.ProcessId -notin $processIds })
                if (-not $children.Count) { break }
                $processIds += $children.ProcessId
            }
            [array]::Reverse($processIds)
            foreach ($processId in $processIds) { Stop-Process -Id $processId -ErrorAction SilentlyContinue }
            Write-Host 'Stopped this planner and its ngrok process.'
        }
    }
    $portLine = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -Last 1
    $plannerPort = if ($portLine) { ($portLine -split '=',2)[1].Trim().Trim('"').Trim("'") } else { '8080' }
    if ($plannerPort -notmatch '^\d+$' -or [int]$plannerPort -lt 1 -or [int]$plannerPort -gt 65535) { throw 'Invalid PORT in .env.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort @([int]$plannerPort,4040) -ErrorAction SilentlyContinue)
    if ($listeners.Count) { throw 'Planner or ngrok port is busy. Stop any manually started instance with Ctrl+C before retrying. No unrelated process was stopped.' }
    $databaseLine = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^\s*DATABASE_PATH\s*=' } | Select-Object -Last 1
    $databasePath = if ($env:DATABASE_PATH) { $env:DATABASE_PATH } elseif ($databaseLine) { ($databaseLine -split '=',2)[1].Trim().Trim('"').Trim("'") } else { './data/planner.sqlite' }
    if (Test-Path -LiteralPath $databasePath) {
        New-Item -ItemType Directory -Path 'data/backups' -Force | Out-Null
        $backupPath = Join-Path $projectRoot ('data\backups\planner-before-restart-' + (Get-Date -Format 'yyyyMMddTHHmmssfff') + '.sqlite')
        Copy-Item -LiteralPath $databasePath -Destination $backupPath
        # A forced stop can leave committed transactions in WAL; preserve it with the same backup basename.
        if (Test-Path -LiteralPath ($databasePath + '-wal')) { Copy-Item -LiteralPath ($databasePath + '-wal') -Destination ($backupPath + '-wal') }
        Write-Host 'Database backup created.'
    }
    $launcher = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/start-ngrok.ps1') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput 'data/runtime.stdout.log' -RedirectStandardError 'data/runtime.stderr.log' -PassThru
    $version = (Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json).version
    $metadata = @{ launcher_pid = $launcher.Id; started_at = (Get-Date).ToUniversalTime().ToString('o'); version = $version }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath 'data/runtime.json' -Encoding UTF8
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        if ($launcher.HasExited) { throw 'Planner exited during startup. Check data/runtime.stdout.log and data/runtime.stderr.log.' }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$plannerPort/health" -TimeoutSec 1
            $tunnels = Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 1
            $url = ($tunnels.tunnels | Where-Object { $_.proto -eq 'https' -and $_.config.addr -match ":$plannerPort/?$" } | Select-Object -First 1).public_url
            if ($health.status -eq 'ok' -and $url) {
                $metadata.public_url = $url
                $metadata | ConvertTo-Json | Set-Content -LiteralPath 'data/runtime.json' -Encoding UTF8
                $envPath = Join-Path $projectRoot '.env'
                $envText = [System.IO.File]::ReadAllText($envPath)
                if ($envText -match '(?m)^PUBLIC_BASE_URL=') { $envText = [regex]::Replace($envText, '(?m)^PUBLIC_BASE_URL=.*$', ('PUBLIC_BASE_URL=' + $url)) }
                else { $envText += "`nPUBLIC_BASE_URL=$url`n" }
                [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
                Write-Host "Planner restarted in background. Local health OK. Tunnel: $url"
                return
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw 'Startup did not become healthy within the time limit. Check local runtime logs; the launcher may still be starting.'
} finally { $restartLock.Dispose() }
