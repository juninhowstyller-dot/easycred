# Easy Cred

Projeto Node.js/Express com frontend estatico em `public/`, autenticacao JWT, senhas com bcrypt e persistencia em SQLite local ou Postgres.

As taxas de cartao e o parcelamento ficam para configuracao manual dentro do sistema. O codigo apenas preserva e usa esses valores nas simulacoes.

## Rodar localmente

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

## Testes

```bash
npm test
```

A suite cobre sessao/login, persistencia de parcelamento e protecao contra deploy serverless sem banco Postgres.

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
