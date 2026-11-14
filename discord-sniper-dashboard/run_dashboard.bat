@echo off
title Kayzer Airlines - Web Control Center
cls
echo ======================================================
echo       KAYZER AIRLINES — WEB CONTROL CENTER
echo ======================================================
echo.

cd /d "%~dp0"

if not exist "node_modules\ws" (
    echo [*] Gerekli paketler yukleniyor...
    call npm install ws --save
)

echo [*] Web Dashboard baslatiliyor...
echo [*] Tarayici otomatik aciliyor: http://localhost:3000
start http://localhost:3000

node server.js
pause
