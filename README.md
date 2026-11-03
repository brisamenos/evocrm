# EvoCRM Pro — WhatsApp via Wuzapi

CRM de atendimento integrado ao WhatsApp pela **Wuzapi**, com banco SQLite local
(sql.js), IA (OpenAI), fila de atendimento, disparos, agenda, chatbot e checkout
com Mercado Pago.

## Como a Wuzapi foi ligada

O CRM foi escrito para a Evolution API. Em vez de reescrever o sistema todo, o
arquivo `wuzapi.js` faz o papel de "tradutor":

```
CRM  →  /evo/... (formato antigo)  →  wuzapi.js  →  Wuzapi
Wuzapi  →  /webhook/NOME_DA_INSTANCIA  →  wuzapi.js  →  CRM
```

- Cada **instância/empresa** do CRM vira **um usuário na Wuzapi** com o mesmo nome.
- O CRM cria esse usuário sozinho na primeira vez que alguém pede o QR Code.
- O webhook da Wuzapi é configurado automaticamente para
  `SERVER_PUBLIC_URL/webhook/NOME_DA_INSTANCIA`.
- Áudios são convertidos para OGG/Opus com `ffmpeg` (já incluso no Dockerfile).

## Variáveis de ambiente (EasyPanel → Environment)

| Variável | Obrigatória | O que é |
|---|---|---|
| `WUZAPI_URL` | sim | Endereço da sua Wuzapi. Ex: `https://wuzapi.seudominio.com` |
| `WUZAPI_ADMIN_TOKEN` | sim* | O mesmo `WUZAPI_ADMIN_TOKEN` configurado na Wuzapi |
| `WUZAPI_TOKEN` | não* | Token de um usuário só (modo 1 empresa, sem token admin) |
| `SERVER_PUBLIC_URL` | sim | Endereço público deste CRM. Ex: `https://crm.seudominio.com` |
| `WEBHOOK_BASE_URL` | não | Endereço que a Wuzapi usa para chegar no CRM (se for rede interna). Padrão: `SERVER_PUBLIC_URL` |
| `INSTANCE_NAME` | não | Cria a licença desta empresa automaticamente ao iniciar |
| `LICENSE_KEY` / `PLANO` | não | Chave e plano da licença criada automaticamente |
| `ADMIN_SECRET` | não | Senha para criar licenças. Atenção: o checkout e o painel admin enviam o valor padrão fixo no código — se trocar aqui, troque lá também (veja o relatório de revisão) |
| `MP_ACCESS_TOKEN` / `MP_PUBLIC_KEY` | p/ checkout | Credenciais do Mercado Pago |
| `CRM_INTERNAL_KEY` | não | Chave interna do adaptador. Se vazio, é gerada a cada início |
| `PORT` | não | Porta (padrão 3000) |
| `DB_PATH` / `UPLOADS_DIR` | não | Padrão `/app/data/evocrm.db` e `/app/uploads` |

\* Use `WUZAPI_ADMIN_TOKEN` (recomendado, permite várias empresas) **ou** `WUZAPI_TOKEN`.

## Deploy no EasyPanel

1. Suba a Wuzapi como um serviço (imagem `asternic/wuzapi`) com
   `WUZAPI_ADMIN_TOKEN` definido. Se puder, defina também `WEBHOOK_FORMAT=json`.
2. Crie o serviço do CRM a partir deste repositório (usa o `Dockerfile`).
3. Preencha as variáveis da tabela acima.
4. Crie **volumes persistentes**: `/app/data` (banco) e `/app/uploads` (arquivos).
5. Porta do serviço: `3000`.
6. Abra `https://SEU_CRM/conectar.html?i=NOME_DA_EMPRESA` e leia o QR Code.

## Estrutura

```
server.js        → servidor (API, webhook, IA, agenda, fila, backups)
wuzapi.js        → adaptador WhatsApp (Wuzapi)
db.js            → SQLite (sql.js)
fila_manager.js  → fila de atendimento
index.html/app*.js → painel do CRM
evolution.html   → painel administrativo (clientes, licenças, planos)
conectar.html    → página de leitura do QR Code
checkout.html    → página de venda/assinatura
storage.html     → gerenciador de arquivos
```

## O que muda em relação à Evolution

- **Sem histórico antigo pela API**: a Wuzapi não tem "listar conversas". As
  conversas entram pelo webhook a partir da conexão (e pelo histórico que o
  WhatsApp envia logo após ler o QR Code).
- **Nome do perfil do operador**: a Wuzapi nem sempre informa; o filtro que
  evita salvar o nome do operador como nome de lead pode não ter esse dado.

## Cobrança automática de mensalidade

- Cadastre **nome, WhatsApp e valor** do cliente no Painel Master (Novo Cliente ou "alterar plano").
  O plano Individual usa o valor fixo (R$ 49,90/mês ou R$ 297/ano).
- Todo dia, das 9h às 20h, quem vence em até **3 dias** recebe no WhatsApp a mensagem de cobrança
  e o **PIX copia e cola** do Mercado Pago (`MP_ACCESS_TOKEN`).
- As mensagens saem da instância definida em **Painel → Cobranças** (padrão: `INSTANCE_NAME`).
- Pagou → a validade é renovada (+1 mês no mesmo dia, ou +1 ano) e o cliente recebe a confirmação.
  O sistema confere o Mercado Pago a cada 15 minutos e também recebe o aviso em `/api/mp/webhook`
  (configurado sozinho quando `SERVER_PUBLIC_URL` é https).
- Em **Painel → Cobranças** você vê quem vence, quem já foi cobrado e pode clicar em **Cobrar agora**.
