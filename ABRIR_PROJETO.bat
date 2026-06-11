@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias...
  npm install
)

echo.
echo Abrindo Easy Cred em duas janelas:
echo - Painel: http://localhost:3000
echo - Bot WhatsApp: leia o QR Code se aparecer
echo.
start "Easy Cred - Painel" cmd /k "cd /d ""%~dp0"" && npm start"
start "Easy Cred - WhatsApp Bot" cmd /k "cd /d ""%~dp0"" && npm run start:whatsapp"
