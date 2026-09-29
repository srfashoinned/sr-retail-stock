$ErrorActionPreference = "SilentlyContinue"

$appDir = "E:\New Website"
$node = "C:\Program Files\nodejs\node.exe"
$logDir = Join-Path $appDir "logs"
$outLog = Join-Path $logDir "stock-site-server.log"
$errLog = Join-Path $logDir "stock-site-server-error.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stockRunning = Get-NetTCPConnection -LocalPort 3031 -State Listen -ErrorAction SilentlyContinue
if (-not $stockRunning) {
  Start-Process -FilePath $node -ArgumentList "serve-stock-site.js" -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

$receivablesRunning = Get-NetTCPConnection -LocalPort 3021 -State Listen -ErrorAction SilentlyContinue
if (-not $receivablesRunning) {
  Start-Process -FilePath $node -ArgumentList "serve-receivables-site.js" -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "receivables-site.log") -RedirectStandardError (Join-Path $logDir "receivables-site-error.log")
}
