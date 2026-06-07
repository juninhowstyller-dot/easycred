@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Instalando dependencias...
  npm install
)

echo.
echo Easy Cred rodando em http://localhost:3000
echo Para parar, feche esta janela ou pressione Ctrl+C.
echo.
npm start
