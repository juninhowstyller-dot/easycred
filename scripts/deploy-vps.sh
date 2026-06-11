#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Atualizando codigo..."
git pull --ff-only

if [ ! -f .env ]; then
  echo "Criando .env a partir do .env.example..."
  cp .env.example .env
fi

ensure_env() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" .env; then
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_env "WHATSAPP_AUTH_DIR" "auth_info"
ensure_env "WHATSAPP_BOT_FOOTER" "Junior Cred"
ensure_env "WHATSAPP_OWNER_JID" "5527997584986@s.whatsapp.net"
ensure_env "WHATSAPP_ATTENDANT_PHONE" "5527997584986"
ensure_env "WHATSAPP_AMOUNT_PRESETS" "1000,2000,3000,4000,5000"
ensure_env "WHATSAPP_INSTALLMENT_PRESETS" "3,6,10,12,18"
ensure_env "WHATSAPP_SESSION_TTL_MINUTES" "30"
ensure_env "WHATSAPP_HUMAN_PAUSE_HOURS" "12"
ensure_env "WHATSAPP_DAILY_ART_TIME" "09:00"

echo "Subindo containers..."
docker compose up -d --build

echo
echo "Status:"
docker compose ps

echo
echo "Logs do bot WhatsApp. Use Ctrl+C para sair dos logs sem parar o bot."
docker compose logs -f easycred-whatsapp
