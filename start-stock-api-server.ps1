$ErrorActionPreference = "SilentlyContinue"

$appDir = "E:\New Website"
$node = "C:\Program Files\nodejs\node.exe"
$logDir = Join-Path $appDir "logs"
$outLog = Join-Path $logDir "stock-api-server.log"
$errLog = Join-Path $logDir "stock-api-server-error.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$alreadyRunning = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
if ($alreadyRunning) {
  exit 0
}

Start-Process -FilePath $node -ArgumentList "live-stock-api.js" -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
