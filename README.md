# Easy Cred

Projeto Node.js/Express com frontend estatico em `public/`, autenticacao JWT, senhas com bcrypt e persistencia em SQLite local ou Postgres.

As taxas de cartao e o parcelamento ficam para configuracao manual dentro do sistema. O codigo apenas preserva e usa esses valores nas simulacoes.

## Rodar localmente

No Windows, voce pode abrir direto pelo arquivo:

```text
ABRIR_PROJETO.bat
```

Ele instala as dependencias se `node_modules` nao existir e inicia o servidor.

```bash
npm install
cp .env.example .env
npm start
```

O servidor roda em `http://localhost:3000` por padrao.

Edite o `.env` antes de usar em producao:

```env
JWT_SECRET=troque_por_um_segredo_forte
JWT_REFRESH_SECRET=troque_por_outro_segredo_forte
JWT_REFRESH_EXPIRES_IN=10y
NODE_ENV=production
PORT=3000
EASYCRED_DB_PATH=./data.db
DATABASE_URL=
```

Se `DATABASE_URL` ficar vazio, o sistema usa SQLite no arquivo definido por `EASYCRED_DB_PATH`.

O banco local salvo nesta pasta fica em `data.db`.

## Testes

```bash
npm test
```

A suite cobre sessao/login, persistencia de parcelamento e protecao contra deploy serverless sem banco Postgres.

## Bot do Telegram

O bot usa as mesmas taxas, maquininha, cartao e parcelamento configurados no sistema. Ele fica desligado ate voce colocar um token no `.env`.

1. No Telegram, fale com `@BotFather`.
2. Use `/newbot` e copie o token.
3. Coloque no `.env`:

```env
TELEGRAM_BOT_TOKEN=token_do_bot
TELEGRAM_BOT_ENABLED=true
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_COMPANY_ID=
TELEGRAM_SHOW_PROFIT=false
```

Depois reinicie o servidor. No bot, envie:

```text
1000 10
1000 10 limite
R$ 1.500,00 12 sem limite
```

Use `/start` no bot para ver o ID do chat. Se quiser limitar quem pode usar, coloque esse ID em `TELEGRAM_ALLOWED_CHAT_IDS`.

## Bot do WhatsApp

O bot do WhatsApp roda separado do painel:

```bash
npm run start:whatsapp
```

Ele entende mensagens digitadas e tambem envia botoes de simulacao. Exemplos aceitos:

```text
tenho 3 mil de limite quanto recebo?
1000 em 10x
R$ 1.500,00 12 sem limite
```

Para ajustar os botoes e a arte diaria, use o `.env`:

```env
WHATSAPP_AUTH_DIR=auth_info
WHATSAPP_TIMEZONE=America/Sao_Paulo
WHATSAPP_DEBUG=false
WHATSAPP_AMOUNT_PRESETS=1000,2000,3000
WHATSAPP_INSTALLMENT_PRESETS=3,6,10,12,18
WHATSAPP_HUMAN_PAUSE_HOURS=12
WHATSAPP_DAILY_GROUP_JID=120000000000000000@g.us
WHATSAPP_DAILY_ART_PATH=./public/images/minha-arte.png
WHATSAPP_DAILY_ART_PATHS=
WHATSAPP_DAILY_ART_CAPTION=Fale com a Junior Cred
WHATSAPP_DAILY_ART_TIME=09:00
```

O bot ignora mensagens recebidas em grupos; ele so usa o grupo para postar a arte diaria configurada. No privado, quando voce responder manualmente um cliente pelo proprio WhatsApp, o bot pausa aquele contato em silencio e volta sozinho depois do tempo definido em `WHATSAPP_HUMAN_PAUSE_HOURS`.

## Deploy em VPS Ubuntu

Opcao recomendada com Docker Compose:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker

git clone <URL_DO_REPOSITORIO> easycred
cd easycred
cp .env.example .env
nano .env

docker compose up -d --build
```

O Compose sobe dois containers:

```text
easycred
easycred-whatsapp
```

Para parear o WhatsApp na VPS, abra os logs do bot e leia o QR Code:

```bash
docker compose logs -f easycred-whatsapp
```

Depois de escanear, pressione `Ctrl+C` apenas para sair dos logs. O container continua rodando. Para reiniciar so o bot:

```bash
docker compose restart easycred-whatsapp
```

Opcao Docker sem Compose:

```bash
docker build -t easycred .
docker run -d --name easycred --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  -v easycred-data:/app/data \
  easycred
```

Opcao sem Docker:

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone <URL_DO_REPOSITORIO> easycred
cd easycred
npm ci --omit=dev
cp .env.example .env
nano .env
npm start
```

Na VPS atual com PM2, use:

```bash
cd /home/ubuntu/easycred
./scripts/deploy-vps-pm2.sh
```

Para deixar rodando sem Docker, crie um servico systemd apontando para a pasta do projeto:

```ini
[Unit]
Description=Easy Cred
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/easycred
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=/home/ubuntu/easycred/.env

[Install]
WantedBy=multi-user.target
```

Depois:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now easycred
sudo systemctl status easycred
```

Crie tambem um servico para o bot do WhatsApp:

```ini
[Unit]
Description=Easy Cred WhatsApp Bot
After=network.target easycred.service

[Service]
WorkingDirectory=/home/ubuntu/easycred
ExecStart=/usr/bin/node whatsapp-bot.js
Restart=always
EnvironmentFile=/home/ubuntu/easycred/.env

[Install]
WantedBy=multi-user.target
```

Depois:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now easycred-whatsapp
sudo journalctl -u easycred-whatsapp -f
```

Use o QR Code que aparecer no `journalctl` para conectar o WhatsApp. Depois de escanear, pressione `Ctrl+C` apenas para sair dos logs.

## Deploy na Vercel

Na Vercel, configure `DATABASE_URL` ou `POSTGRES_URL` com um banco Postgres duravel, como Neon, Supabase ou Vercel Postgres. Sem Postgres, escritas importantes sao bloqueadas para evitar perda de dados em ambiente serverless.

## Arquivos importantes

- `server.js`: backend e endpoints.
- `public/index.html`: entrada do frontend.
- `public/js/index-company-photo-20260606.js`: bundle atual do frontend.
- `.env.example`: modelo de configuracao.
- `Dockerfile`: imagem pronta para VPS.
- `docker-compose.yml`: servico pronto com volume persistente.
- `.dockerignore`: evita enviar banco local, node_modules e arquivos privados para a imagem.
