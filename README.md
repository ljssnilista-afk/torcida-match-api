# TorcidaMatch API

Backend REST para o app TorcidaMatch. Node.js + Express + MongoDB Atlas.

---

## Endpoints

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| POST | `/api/auth/register` | ❌ | Cadastro de usuário |
| POST | `/api/auth/login` | ❌ | Login |
| GET | `/api/auth/check-handle/:handle` | ❌ | Verifica se @handle está disponível |
| GET | `/api/profile/me` | ✅ | Perfil do usuário logado |
| PUT | `/api/profile/me` | ✅ | Atualizar perfil |
| GET | `/api/profile/:id` | ❌ | Perfil público por ID |
| GET | `/health` | ❌ | Health check |

---

## Setup local

```bash
# 1. Instalar dependências
npm install

# 2. Criar arquivo .env
cp .env.example .env
# Editar .env com suas credenciais

# 3. Rodar em desenvolvimento
npm run dev

# 4. Rodar em produção
npm start
```

---

## MongoDB Atlas (gratuito)

1. Acesse https://cloud.mongodb.com e crie uma conta
2. Crie um cluster gratuito (M0)
3. Em **Database Access** → crie um usuário com senha
4. Em **Network Access** → adicione `0.0.0.0/0` (permite qualquer IP)
5. Em **Connect** → copie a connection string e cole no `.env`

---

## Deploy no Railway

1. Acesse https://railway.app e faça login com GitHub
2. Clique em **New Project** → **Deploy from GitHub repo**
3. Selecione este repositório
4. Vá em **Variables** e adicione:
   - `MONGODB_URI` = sua connection string do Atlas
   - `JWT_SECRET` = uma string longa e aleatória
   - `CLIENT_URL` = URL do seu frontend (ex: https://torcidamatch.vercel.app)
5. Railway detecta o `package.json` e faz o deploy automaticamente
6. Copie a URL gerada (ex: `https://torcida-match-api.up.railway.app`)

---

## Deploy no Render (alternativa)

1. Acesse https://render.com → **New Web Service**
2. Conecte ao repositório GitHub
3. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Adicione as mesmas variáveis de ambiente
5. Copie a URL gerada

---

## Integrar no frontend React

Após o deploy, atualize o `bsdApi.js` ou crie um `authApi.js`:

```js
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

export async function registerUser(data) {
  const res = await fetch(`${API_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return res.json()
}

export async function loginUser(email, password) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

export async function checkHandle(handle) {
  const res = await fetch(`${API_URL}/api/auth/check-handle/${handle}`)
  return res.json() // { available: true/false }
}
```

No `.env` do frontend (Vite):
```
VITE_API_URL=https://sua-api.up.railway.app
```
