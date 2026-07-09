# Conector WhatsApp — Sinal CRM

Este serviço conecta seu WhatsApp (via QR Code, biblioteca `whatsapp-web.js`) ao banco de dados do CRM no Supabase. Ele precisa ficar **rodando o tempo todo** — não pode ser hospedado no Netlify (veja explicação no chat).

## 1. Pré-requisitos
- Node.js 18+ instalado
- Um número de WhatsApp para conectar (recomendado: um número dedicado, não o seu pessoal do dia a dia, mas funciona com qualquer um)

## 2. Instalação

```bash
cd whatsapp-connector
npm install
```

## 3. Configurar credenciais

Copie `.env.example` para `.env`:

```bash
cp .env.example .env
```

No arquivo `.env`, `SUPABASE_URL` já vem preenchida. Falta a `SUPABASE_SERVICE_KEY`:
1. Acesse https://supabase.com/dashboard/project/bontovhrlhfdlzaihmsl/settings/api
2. Copie a chave **service_role** (não é a mesma do frontend — essa é secreta, nunca a exponha publicamente)
3. Cole em `SUPABASE_SERVICE_KEY` no `.env`

## 4. Rodar

```bash
npm start
```

Um QR Code vai aparecer no terminal. Abra o WhatsApp no celular → **Aparelhos conectados** → **Conectar aparelho** → escaneie.

Depois de conectado, o terminal mostra "✅ Conector pronto". A partir daí:
- Mensagens recebidas aparecem no CRM (aba Conversas) em tempo real
- Mensagens enviadas pelo CRM chegam de fato no WhatsApp do contato
- Regras de automação (aba Automações do CRM) respondem sozinhas por palavra-chave

## 5. Manter rodando 24/7

Rodar `npm start` no seu computador só funciona enquanto ele estiver ligado. Para produção, hospede em um serviço que sustente processos Node.js persistentes, por exemplo:
- **Railway** ou **Render** (mais simples, planos pagos a partir de poucos dólares/mês)
- Uma **VPS** própria (ex: Contabo, DigitalOcean) com `pm2` para manter o processo vivo:
  ```bash
  npm install -g pm2
  pm2 start index.js --name whatsapp-connector
  pm2 save
  ```

Nesses ambientes, defina as mesmas variáveis do `.env` como variáveis de ambiente do serviço.

## Observações importantes

- **whatsapp-web.js não é oficial** — usa engenharia reversa do WhatsApp Web. Funciona bem para uso comercial moderado, mas há risco (baixo, porém real) de bloqueio de número pelo WhatsApp em caso de uso muito agressivo (disparos em massa, muitos números diferentes escaneados no mesmo IP, etc). Para operações críticas ou de grande volume, considere migrar futuramente para a API oficial (Meta Cloud API, Twilio ou 360dialog).
- A sessão fica salva em `.wwebjs_auth` — não delete essa pasta ou você precisa escanear o QR Code de novo.
- Por padrão, mensagens de **grupos** são ignoradas (só conversas 1:1 viram contatos no CRM). Se quiser incluir grupos, é uma mudança pequena no `index.js`.
