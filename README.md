# Easy Cred — cópia local (mock)

Este repositório contém os arquivos estáticos da interface e um backend Node.js simples que serve os arquivos e fornece endpoints mock com SQLite.

Instalação e execução:

```bash
npm install
npm start
```

O servidor roda em `http://localhost:3000` por padrão e serve os arquivos estáticos da pasta `public/`.

Endpoints principais (mock):
- `POST /api/register` {name,email,password}
- `POST /api/login` {email,password}
- `POST /api/forgot-password` {email}
- `POST /api/simulate` {amount,installments} (Bearer token required)
- `GET /api/simulations` (Bearer token required)

Observações:
- Senhas agora são armazenadas com `bcryptjs` e o servidor gera `JWT` para autenticação.

Atualizações recentes:
- Autenticação reforçada: `bcryptjs` + `jsonwebtoken` (JWT). Use o header `Authorization: Bearer <token>` para endpoints protegidos.
- Persistência com `sql.js` (WASM) em `data.db`.
- Adicionado `Dockerfile` e `.env.example`.

Variáveis de ambiente (exemplo em `.env.example`):
- `JWT_SECRET` — segredo usado para assinar tokens JWT
- `PORT` — porta do servidor

Rodando localmente (desenvolvimento):
```bash
npm install
cp .env.example .env
# editar .env e ajustar JWT_SECRET
npm start
```

Testando o fluxo seguro (PowerShell exemplo):
```powershell
# Registrar
Invoke-RestMethod -Uri http://localhost:3000/api/register -Method Post -ContentType 'application/json' -Body (@{name='User';email='u@example.com';password='123456'} | ConvertTo-Json)
# Login
$resp = Invoke-RestMethod -Uri http://localhost:3000/api/login -Method Post -ContentType 'application/json' -Body (@{email='u@example.com';password='123456'} | ConvertTo-Json)
$token = $resp.token
# Criar simulação (autenticado)
Invoke-RestMethod -Uri http://localhost:3000/api/simulate -Method Post -Headers @{Authorization = "Bearer $token"} -ContentType 'application/json' -Body (@{amount=1000;installments=12} | ConvertTo-Json)
```

Deployment rápido com Docker:
```bash
docker build -t easy-cred-clone .
docker run -p 3000:3000 --env JWT_SECRET=seusegredo -v $(pwd)/data.db:/app/data.db easy-cred-clone
```
