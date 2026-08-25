@echo off
title SR Fashion - Retail Daddy Stock Auto Sync to Hostinger
cd /d "E:\New Website"

:loop
echo.
echo ==============================================
echo   SR FASHION - RETAIL DADDY HOSTINGER SYNC
echo ==============================================
echo [%date% %time%] Exporting live stock...

node export-stock.js

if errorlevel 1 (
    echo.
    echo EXPORT FAILED - NOTHING UPLOADED
    echo Retrying in 30 seconds...
    timeout /t 30 /nobreak >nul
    goto loop
)

echo.
echo Export successful. Checking Hostinger upload settings...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if([string]::IsNullOrWhiteSpace($env:HOSTINGER_FTP_HOST) -or [string]::IsNullOrWhiteSpace($env:HOSTINGER_FTP_USER) -or [string]::IsNullOrWhiteSpace($env:HOSTINGER_FTP_PASSWORD)){ exit 20 }"

if errorlevel 20 (
    echo.
    echo HOSTINGER FTP DETAILS NOT SET
    echo Local live cache is updated. Hostinger upload is skipped.
    goto wait_next
)

echo Uploading website, stock cache, image API, and public images to Hostinger...

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "E:\New Website\upload-to-hostinger.ps1"

if errorlevel 1 (
    echo.
    echo HOSTINGER UPLOAD FAILED
    echo Will retry on next cycle.
) else (
    echo.
    echo STOCK UPDATED ON HOSTINGER SUCCESSFULLY
)

echo.
:wait_next
echo Next stock check in 180 seconds...
timeout /t 180 /nobreak >nul
goto loop
