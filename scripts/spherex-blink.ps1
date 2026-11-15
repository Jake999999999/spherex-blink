param(
    [ValidateSet("menu", "start", "stop", "status", "restart")]
    [string]$Action = "menu"
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $Repo "backend"
$FrontendDir = Join-Path $Repo "frontend"
$BackendPort = 8091
$FrontendPort = 5186
$Url = "http://127.0.0.1:$FrontendPort/"

function Get-PortPid([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return $null
}

function Show-Status {
    $bPid = Get-PortPid $BackendPort
    $fPid = Get-PortPid $FrontendPort
    Write-Host ""
    Write-Host "=== SPHEREx Blink Processes ===" -ForegroundColor Cyan
    if ($bPid) {
        Write-Host ("  Backend  (127.0.0.1:{0}) : RUNNING (PID {1})" -f $BackendPort, $bPid) -ForegroundColor Green
    } else {
        Write-Host ("  Backend  (127.0.0.1:{0}) : STOPPED" -f $BackendPort) -ForegroundColor Yellow
    }
    if ($fPid) {
        Write-Host ("  Frontend (127.0.0.1:{0}) : RUNNING (PID {1})" -f $FrontendPort, $fPid) -ForegroundColor Green
    } else {
        Write-Host ("  Frontend (127.0.0.1:{0}) : STOPPED" -f $FrontendPort) -ForegroundColor Yellow
    }
    Write-Host ""
}

function Stop-All {
    $stopped = $false
    foreach ($port in @($BackendPort, $FrontendPort, 5187)) {
        $p = Get-PortPid $port
        if ($p) {
            Write-Host ("Stopping process on port {0} (PID {1})..." -f $port, $p)
            & taskkill /PID $p /T /F | Out-Null
            $stopped = $true
        }
    }
    if (-not $stopped) {
        Write-Host "No SPHEREx Blink servers are running." -ForegroundColor Gray
    } else {
        Write-Host "All SPHEREx Blink processes stopped." -ForegroundColor Green
    }
}

function Start-All {
    if (-not (Get-PortPid $BackendPort)) {
        Write-Host "Starting backend server (127.0.0.1:$BackendPort)..." -ForegroundColor Cyan
        Start-Process -FilePath "uv" -ArgumentList "run", "python", "-m", "spherex_blink", "serve" -WorkingDirectory $BackendDir -WindowStyle Minimized | Out-Null
    } else {
        Write-Host "Backend already running on port $BackendPort." -ForegroundColor Gray
    }

    if (-not (Get-PortPid $FrontendPort)) {
        Write-Host "Starting frontend dev server (127.0.0.1:$FrontendPort)..." -ForegroundColor Cyan
        Start-Process -FilePath "bun" -ArgumentList "run", "dev" -WorkingDirectory $FrontendDir -WindowStyle Minimized | Out-Null
    } else {
        Write-Host "Frontend already running on port $FrontendPort." -ForegroundColor Gray
    }

    Write-Host "Waiting for frontend at $Url ..." -NoNewline
    for ($i = 0; $i -lt 30; $i++) {
        if (Get-PortPid $FrontendPort) {
            Write-Host " ready!" -ForegroundColor Green
            Start-Process $Url | Out-Null
            return
        }
        Start-Sleep -Milliseconds 400
        Write-Host "." -NoNewline
    }
    Write-Host " timed out (check logs)." -ForegroundColor Red
}

switch ($Action) {
    "status" {
        Show-Status
        exit 0
    }
    "stop" {
        Stop-All
        exit 0
    }
    "restart" {
        Stop-All
        Start-Sleep -Milliseconds 500
        Start-All
        exit 0
    }
    "start" {
        Start-All
        exit 0
    }
    "menu" {
        Start-All
        while ($true) {
            Show-Status
            Write-Host "Commands: [O] Open browser  [S] Refresh status  [R] Restart  [X] Stop all & exit  [K] Keep running & close window"
            $key = (Read-Host "Choose").Trim().ToUpperInvariant()
            switch ($key) {
                "O" { Start-Process $Url | Out-Null }
                "S" { }
                "R" { Stop-All; Start-Sleep -Milliseconds 500; Start-All }
                "X" { Stop-All; exit 0 }
                "K" { exit 0 }
                default { Write-Host "Unknown option." -ForegroundColor Yellow }
            }
        }
    }
}
