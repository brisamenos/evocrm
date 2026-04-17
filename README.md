# EvoCRM SaaS

CRM de atendimento integrado ao WhatsApp via Evolution API + Supabase.

## Estrutura de arquivos

```
/
├── index.html   → HTML principal (estrutura + templates Alpine.js)
├── style.css    → Estilos customizados (variáveis WhatsApp, animações, layout)
├── app.js       → Lógica completa do CRM (crmApp() Alpine.js)
├── sw.js        → Service Worker para notificações em segundo plano
└── README.md
```

## Deploy no EasyPanel

1. Conecte este repositório GitHub no EasyPanel
2. Tipo de serviço: **Static Site** (Nginx)
3. Pasta de build: `/` (raiz)
4. Não há etapa de build — os arquivos são servidos diretamente

## Banco de dados (Supabase)

Execute o SQL de migração em **Supabase → SQL Editor** antes de usar.
O SQL completo está disponível dentro do painel, na tela de configurações da IA.

## Configuração

As credenciais do Supabase e Evolution API estão em `app.js`:
- `SB_URL` e `SB_KEY` → Supabase
- `EVO_URL` e `EVO_KEY` → Evolution API
