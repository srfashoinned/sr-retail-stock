$ErrorActionPreference = "SilentlyContinue"

$appDir = "E:\New Website"
$node = "C:\Program Files\nodejs\node.exe"
$logDir = Join-Path $appDir "logs"
$outLog = Join-Path $logDir "stock-site-server.log"
$errLog = Join-Path $logDir "stock-site-server-error.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$alreadyRunning = Get-NetTCPConnection -LocalPort 3031 -State Listen -ErrorAction SilentlyContinue
if ($alreadyRunning) {
  exit 0
}

Start-Process -FilePath $node -ArgumentList "serve-stock-site.js" -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
