@echo off
title SR Fashion - Retail Daddy Stock Auto Sync
cd /d "E:\New Website"

:loop
echo.
echo ==========================================
echo   SR FASHION - RETAIL DADDY AUTO SYNC
echo ==========================================
echo [%date% %time%] Exporting live stock...

node export-stock.js

if errorlevel 1 (
    echo.
    echo EXPORT FAILED - NOTHING PUSHED
    echo Retrying in 30 seconds...
    timeout /t 30 /nobreak >nul
    goto loop
)

echo.
echo Export successful. Syncing items.json to GitHub...

git add items.json

git diff --cached --quiet
if %errorlevel%==0 (
    echo No stock changes detected. Nothing to push.
) else (
    git commit -m "Auto stock update"
    git push origin main

    if errorlevel 1 (
        echo.
        echo GITHUB PUSH FAILED
        echo Will retry on next cycle.
    ) else (
        echo.
        echo STOCK UPDATED ON GITHUB SUCCESSFULLY
    )
)

echo.
echo Next stock check in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop