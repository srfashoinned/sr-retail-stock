$ErrorActionPreference = "Continue"

$sourceDir = "E:\New Website"
$publishDir = "C:\Users\SR\Documents\Codex\2026-09-15\referenced-chatgpt-conversation-this-is-an\work\catalogue-publish"
$logDir = Join-Path $sourceDir "logs"
$logFile = Join-Path $logDir "github-pages-stock-sync.log"
$lockName = "Global\SRFashionGitHubPagesStockSync"

function Write-SyncLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $logFile -Value $line
}

function Invoke-LoggedCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $outFile = Join-Path $logDir ("sync-out-{0}.log" -f ([guid]::NewGuid().ToString("N")))
    $errFile = Join-Path $logDir ("sync-err-{0}.log" -f ([guid]::NewGuid().ToString("N")))
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (Test-Path -LiteralPath $outFile) {
        Get-Content -LiteralPath $outFile | Add-Content -LiteralPath $logFile
        Remove-Item -LiteralPath $outFile -Force
    }
    if (Test-Path -LiteralPath $errFile) {
        Get-Content -LiteralPath $errFile | Add-Content -LiteralPath $logFile
        Remove-Item -LiteralPath $errFile -Force
    }
    return $process.ExitCode
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$createdNew = $false
$syncLock = New-Object System.Threading.Mutex($true, $lockName, [ref]$createdNew)
if (-not $createdNew) {
    Write-SyncLog "Another stock sync is already running. This duplicate copy will close."
    exit 0
}

try {
while ($true) {
    Write-SyncLog "=========================================="
    Write-SyncLog "SR FASHION - GITHUB PAGES AUTO SYNC"
    Write-SyncLog "Exporting latest stock from Retail Daddy"

    if (-not (Test-Path -LiteralPath $sourceDir)) {
        Write-SyncLog "ERROR: Source folder not found: $sourceDir"
        Start-Sleep -Seconds 30
        continue
    }

    Push-Location $sourceDir
    try {
        $exportCode = Invoke-LoggedCommand -FilePath "node" -Arguments @("export-stock.js") -WorkingDirectory $sourceDir
        if ($exportCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $sourceDir "export-item-ledgers-cache.js"))) {
            $ledgerExportCode = Invoke-LoggedCommand -FilePath "node" -Arguments @("export-item-ledgers-cache.js") -WorkingDirectory $sourceDir
            if ($ledgerExportCode -ne 0) {
                Write-SyncLog "WARNING: Item ledger cache export failed. Stock export will continue."
            }
        }
    } finally {
        Pop-Location
    }

    if ($exportCode -ne 0) {
        Write-SyncLog "ERROR: Export failed. Nothing pushed."
        Start-Sleep -Seconds 30
        continue
    }

    $sourceItems = Join-Path $sourceDir "items.json"
    $sourceLedgers = Join-Path $sourceDir "item-ledgers-cache.json"
    if (-not (Test-Path -LiteralPath $sourceItems)) {
        Write-SyncLog "ERROR: items.json was not created."
        Start-Sleep -Seconds 30
        continue
    }

    if (-not (Test-Path -LiteralPath (Join-Path $publishDir ".git"))) {
        Write-SyncLog "ERROR: Publishing checkout missing: $publishDir"
        Start-Sleep -Seconds 180
        continue
    }

    Push-Location $publishDir
    try {
        $fetchCode = Invoke-LoggedCommand -FilePath "git" -Arguments @("fetch", "origin", "main") -WorkingDirectory $publishDir
        if ($fetchCode -ne 0) {
            Write-SyncLog "ERROR: Could not fetch GitHub. Will retry."
            Start-Sleep -Seconds 180
            continue
        }

        $mergeCode = Invoke-LoggedCommand -FilePath "git" -Arguments @("merge", "--ff-only", "origin/main") -WorkingDirectory $publishDir
        if ($mergeCode -ne 0) {
            Write-SyncLog "ERROR: Publishing checkout is not a clean fast-forward. Will retry."
            Start-Sleep -Seconds 180
            continue
        }

        Copy-Item -LiteralPath $sourceItems -Destination (Join-Path $publishDir "items.json") -Force
        if (Test-Path -LiteralPath $sourceLedgers) {
            Copy-Item -LiteralPath $sourceLedgers -Destination (Join-Path $publishDir "item-ledgers-cache.json") -Force
        }

        $addCode = Invoke-LoggedCommand -FilePath "git" -Arguments @("add", "--", "items.json", "item-ledgers-cache.json") -WorkingDirectory $publishDir
        if ($addCode -ne 0) {
            Write-SyncLog "ERROR: Could not stage items.json. Will retry."
            Start-Sleep -Seconds 180
            continue
        }

        & git diff --cached --quiet -- items.json item-ledgers-cache.json
        if ($LASTEXITCODE -eq 0) {
            Write-SyncLog "No stock changes found."
        } else {
            $commitCode = Invoke-LoggedCommand -FilePath "git" -Arguments @("-c", "user.name=SR Fashion", "-c", "user.email=srfashoinned@users.noreply.github.com", "commit", "-m", "Auto stock update", "--", "items.json") -WorkingDirectory $publishDir
            if ($commitCode -ne 0) {
                Write-SyncLog "ERROR: Commit failed. Will retry."
            } else {
                $pushCode = Invoke-LoggedCommand -FilePath "git" -Arguments @("push", "origin", "main") -WorkingDirectory $publishDir
                if ($pushCode -ne 0) {
                    Write-SyncLog "ERROR: GitHub push failed. Will retry."
                } else {
                    Write-SyncLog "SUCCESS: Stock updated on GitHub Pages."
                }
            }
        }
    } finally {
        Pop-Location
    }

    Write-SyncLog "Next stock check in 180 seconds."
    Start-Sleep -Seconds 180
}
} finally {
    if ($syncLock) {
        $syncLock.ReleaseMutex() | Out-Null
        $syncLock.Dispose()
    }
}
