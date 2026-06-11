#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Atualizando codigo..."
git pull --ff-only origin main

echo "Instalando dependencias..."
npm install --omit=dev

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env "WHATSAPP_AUTH_DIR" "auth_info"
set_env "WHATSAPP_TIMEZONE" "America/Sao_Paulo"
set_env "WHATSAPP_DEBUG" "false"
set_env "WHATSAPP_BOT_FOOTER" "Junior Cred"
set_env "WHATSAPP_OWNER_JID" "5527997584986@s.whatsapp.net"
set_env "WHATSAPP_ATTENDANT_PHONE" "5527997584986"
set_env "WHATSAPP_AMOUNT_PRESETS" "1000,2000,3000,4000,5000"
set_env "WHATSAPP_INSTALLMENT_PRESETS" "3,6,10,12,18"
set_env "WHATSAPP_SESSION_TTL_MINUTES" "30"
set_env "WHATSAPP_HUMAN_PAUSE_HOURS" "12"
set_env "WHATSAPP_DAILY_ART_TIME" "09:00"

echo "Validando bot..."
node -c whatsapp-bot.js
npm run test:whatsapp

echo "Reiniciando PM2..."
pm2 restart easycred --update-env || pm2 start server.js --name easycred --update-env
pm2 restart whatsapp-bot --update-env || pm2 start whatsapp-bot.js --name whatsapp-bot --update-env
pm2 save

echo "Status:"
pm2 list
