-- EvoCRM — Schema PostgreSQL completo e atualizado
-- Sincronizado com db.js, server.js e app.js
-- Execute este arquivo no banco antes de iniciar o server.js
-- psql -U evocrm -d evocrm -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── LICENÇAS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS licenses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT UNIQUE NOT NULL,
  license_key   TEXT,
  plano         TEXT DEFAULT 'basico',
  status        TEXT DEFAULT 'active',
  features      JSONB DEFAULT '{}',
  expires_at    TIMESTAMPTZ,
  is_trial      BOOLEAN DEFAULT false,
  renewal_url   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CONFIGURAÇÃO ADMIN ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_config (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key        TEXT UNIQUE NOT NULL,
  value      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LEADS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name    TEXT NOT NULL,
  nome             TEXT,
  numero           TEXT,
  status           TEXT DEFAULT NULL,
  etiquetas        TEXT DEFAULT '',
  foto_url         TEXT,
  departamento     TEXT DEFAULT 'ADM Principal',
  last_interaction TIMESTAMPTZ,
  last_msg         TEXT,
  unread           INT DEFAULT 0,
  push_name        TEXT,
  observacao       TEXT,
  sentimento       TEXT DEFAULT NULL,
  -- ── Follow-up ──
  followup_count   INT         DEFAULT 0,
  followup_last_at TIMESTAMPTZ DEFAULT NULL,
  followup_paused  BOOLEAN     DEFAULT false,
  prompt_id        UUID        REFERENCES ia_prompts(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_instance ON leads(instance_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_numero ON leads(instance_name, numero);
CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(instance_name, followup_paused, followup_count, last_interaction);

-- Coluna de sentimento (adicionada via migration para bancos existentes)
-- Se já existir a tabela, a coluna é adicionada sem erro:
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS sentimento TEXT DEFAULT NULL;

-- Prompt específico por conversa (adicionado via migration)
-- ALTER TABLE leads ADD COLUMN IF NOT EXISTS prompt_id UUID REFERENCES ia_prompts(id) ON DELETE SET NULL;

-- Temperatura e max_tokens na ia_config (adicionado via migration)
-- ALTER TABLE ia_config ADD COLUMN IF NOT EXISTS temperatura NUMERIC(3,2) DEFAULT 0.70;
-- ALTER TABLE ia_config ADD COLUMN IF NOT EXISTS max_tokens INT DEFAULT 1024;

-- ─── MENSAGENS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  lead_id       UUID REFERENCES leads(id) ON DELETE CASCADE,
  content       TEXT,
  type          TEXT DEFAULT 'text',
  from_me       BOOLEAN DEFAULT false,
  status        TEXT DEFAULT 'sent',
  sent_by_ia    BOOLEAN,
  push_name     TEXT,
  timestamp     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_lead     ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_name);
CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at);

-- ─── CONFIG IA ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_config (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name       TEXT UNIQUE NOT NULL,
  ativo               BOOLEAN DEFAULT false,
  api_key             TEXT,
  modelo              TEXT DEFAULT 'gpt-4o-mini',
  prompt              TEXT DEFAULT '',
  selected_prompt_id  UUID,
  delay_min           INT DEFAULT 1,
  delay_max           INT DEFAULT 3,
  pausa_se_humano     BOOLEAN DEFAULT true,
  responder_grupos    BOOLEAN DEFAULT false,
  pausa_tempo         INT DEFAULT 30,
  palavra_chave       TEXT DEFAULT '',
  palavra_retomar     TEXT DEFAULT '',
  buffer_tempo        INT DEFAULT 8,
  msg_max_chars       INT DEFAULT 300,
  msg_delay_partes    INT DEFAULT 2,
  msg_quebrar_linhas  BOOLEAN DEFAULT true,           -- ✅ adicionado
  tts_mode            TEXT DEFAULT 'off',
  tts_voz             TEXT DEFAULT 'nova',
  tts_max_seconds     INT DEFAULT 10,
  tts_frequencia      INT DEFAULT 50,
  temperatura         NUMERIC(3,2) DEFAULT 0.70,
  max_tokens          INT DEFAULT 1024,
  bot_identifiers     TEXT DEFAULT '',
  bot_rate_limit      INT DEFAULT 6,
  bot_rate_window     INT DEFAULT 60,
  -- ── Follow-up / Reengajamento ──
  followup_ativo          BOOLEAN DEFAULT false,
  followup_max_tentativas INT     DEFAULT 3,
  followup_tempo_1        INT     DEFAULT 30,
  followup_unidade_1      TEXT    DEFAULT 'minutos',
  followup_tempo_2        INT     DEFAULT 2,
  followup_unidade_2      TEXT    DEFAULT 'horas',
  followup_tempo_3        INT     DEFAULT 1,
  followup_unidade_3      TEXT    DEFAULT 'dias',
  followup_horario_inicio INT     DEFAULT 8,
  followup_horario_fim    INT     DEFAULT 20,
  followup_ignorar_colunas TEXT   DEFAULT '',
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PROMPTS SALVOS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_prompts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name     TEXT NOT NULL,
  nome              TEXT,
  descricao         TEXT,                             -- ✅ adicionado
  prompt            TEXT,                             -- ✅ adicionado
  conteudo          TEXT,
  modelo            TEXT DEFAULT 'gpt-4o-mini',       -- ✅ adicionado
  temperatura       NUMERIC(3,2) DEFAULT 0.7,         -- ✅ adicionado
  max_tokens        INT DEFAULT 1024,                 -- ✅ adicionado
  pausa_se_humano   BOOLEAN DEFAULT true,             -- ✅ adicionado
  responder_grupos  BOOLEAN DEFAULT false,            -- ✅ adicionado
  delay_min         INT DEFAULT 1,                    -- ✅ adicionado
  delay_max         INT DEFAULT 3,                    -- ✅ adicionado
  palavra_chave     TEXT DEFAULT '',                  -- ✅ adicionado
  updated_at        TIMESTAMPTZ,                      -- ✅ adicionado
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DOCUMENTOS POR LEAD (processos, contratos, etc.) ───────────────────────
CREATE TABLE IF NOT EXISTS lead_documentos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name   TEXT NOT NULL,
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  descricao       TEXT DEFAULT '',
  arquivo_url     TEXT NOT NULL,
  arquivo_tipo    TEXT DEFAULT '',
  arquivo_tamanho BIGINT DEFAULT 0,
  versao          INT DEFAULT 1,
  notificar       BOOLEAN DEFAULT true,
  criado_por      TEXT DEFAULT 'operador',
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_docs ON lead_documentos(instance_name, lead_id);

-- ─── MÍDIAS IA ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_midias (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name  TEXT NOT NULL,
  nome           TEXT,
  tipo           TEXT,
  url            TEXT,
  palavras_chave TEXT DEFAULT '',
  descricao      TEXT,
  ativo          BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PAUSA IA ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_pausa (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  lead_id       UUID REFERENCES leads(id) ON DELETE CASCADE,
  pausado       BOOLEAN DEFAULT false,
  pausado_por   TEXT,
  pausado_em    TIMESTAMPTZ,
  retomado_em   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instance_name, lead_id)
);

-- ─── BUFFER IA ───────────────────────────────────────────────────────────────
-- ⚠️  CORRIGIDO: coluna renomeada de "conteudo" para "msgs" (array JSON de mensagens)
CREATE TABLE IF NOT EXISTS ia_buffer (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  lead_id       UUID REFERENCES leads(id) ON DELETE CASCADE,
  msgs          TEXT DEFAULT '[]',                    -- ✅ corrigido (era "conteudo TEXT")
  updated_at    TIMESTAMPTZ DEFAULT NOW(),            -- ✅ adicionado
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instance_name, lead_id)
);

-- ─── HISTÓRICO IA ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ia_historico (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  lead_id       UUID,
  pergunta      TEXT,
  resposta      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AGENDAMENTOS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agendamentos_crm (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name       TEXT NOT NULL,
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  avulso_name         TEXT,                           -- ✅ adicionado
  numero              TEXT,
  tipo                TEXT DEFAULT 'simples',
  texto               TEXT,
  flow_id             UUID,
  data_hora           TIMESTAMPTZ,
  data_hora_anterior  TIMESTAMPTZ,                    -- ✅ adicionado
  sent                BOOLEAN DEFAULT false,
  status              TEXT DEFAULT 'ativo',
  lembrete_enviado    BOOLEAN DEFAULT false,
  criado_por_ia       BOOLEAN DEFAULT false,
  reagendado_em       TIMESTAMPTZ,
  alterado_por        TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agenda_instance ON agendamentos_crm(instance_name, sent, status);

-- ─── CONFIG AGENDA ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agenda_config (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name  TEXT UNIQUE NOT NULL,
  ia_verificar   BOOLEAN DEFAULT false,
  dias_semana    JSONB DEFAULT '{"1":true,"2":true,"3":true,"4":true,"5":true}',
  horario_inicio TEXT DEFAULT '08:00',
  horario_fim    TEXT DEFAULT '18:00',
  duracao_slot   INT DEFAULT 60,
  almoco_ativo   BOOLEAN DEFAULT false,
  almoco_inicio  TEXT DEFAULT '12:00',
  almoco_fim     TEXT DEFAULT '13:00',
  max_por_dia    INT DEFAULT 8,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DEPARTAMENTOS ───────────────────────────────────────────────────────────
-- ⚠️  CORRIGIDO: coluna renomeada de "nome" para "name"; adicionado "access_key"
CREATE TABLE IF NOT EXISTS departments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  name          TEXT NOT NULL,                        -- ✅ corrigido (era "nome")
  access_key    TEXT DEFAULT 'admin123',              -- ✅ adicionado
  descricao     TEXT,
  cor           TEXT DEFAULT '#6366f1',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instance_name, name)
);

-- ─── KANBAN ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kanban_columns (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT UNIQUE NOT NULL,
  columns_json  TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── TAGS CRM ────────────────────────────────────────────────────────────────
-- ⚠️  CORRIGIDO: colunas renomeadas de "nome"/"cor" para "name"/"color"
CREATE TABLE IF NOT EXISTS crm_tags (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  name          TEXT NOT NULL,                        -- ✅ corrigido (era "nome")
  color         TEXT DEFAULT '#6366f1',               -- ✅ corrigido (era "cor")
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instance_name, name)
);

-- ─── NOTIFICAÇÕES DASHBOARD ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dash_notifs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  title         TEXT,
  body          TEXT,
  type          TEXT DEFAULT 'info',
  read          BOOLEAN DEFAULT false,
  criado_por_ia BOOLEAN DEFAULT false,
  tipo_agenda   BOOLEAN DEFAULT false,                -- ✅ adicionado
  lead_id       UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifs_instance ON dash_notifs(instance_name, read);

-- ─── TAREFAS DASHBOARD ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dash_tasks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  title         TEXT,
  "desc"        TEXT,
  priority      TEXT DEFAULT 'media',
  tag           TEXT DEFAULT 'geral',
  due           TIMESTAMPTZ,
  done          BOOLEAN DEFAULT false,
  criado_por_ia BOOLEAN DEFAULT false,
  lead_id       UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── RESPOSTAS AUTOMÁTICAS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_replies (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name  TEXT NOT NULL,
  gatilhos       TEXT NOT NULL,
  modo_match     TEXT DEFAULT 'contem',
  blocos         JSONB DEFAULT '[]',
  ativo          BOOLEAN DEFAULT true,
  apenas_uma_vez BOOLEAN DEFAULT false,
  prioridade     INT DEFAULT 2,
  disparos       INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auto_replies_config (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT UNIQUE NOT NULL,
  bot_ativo     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auto_replies_respondidos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  regra_id      TEXT NOT NULL,
  lead_id       UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instance_name, regra_id, lead_id)
);

-- ─── CHATBOT RULES ────────────────────────────────────────────────────────────
-- ⚠️  CORRIGIDO: colunas reescritas para refletir o modelo real do sistema
CREATE TABLE IF NOT EXISTS chatbot_rules (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  trigger_text  TEXT DEFAULT '',                      -- ✅ corrigido (era "gatilho TEXT")
  response_text TEXT DEFAULT '',                      -- ✅ corrigido (era "resposta TEXT")
  media_url     TEXT,                                 -- ✅ adicionado
  media_type    TEXT,                                 -- ✅ adicionado
  departamento  TEXT DEFAULT 'ADM Principal',         -- ✅ adicionado
  ativo         BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── FLUXOS BOT ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_flows (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name TEXT NOT NULL,
  name          TEXT,
  steps         JSONB DEFAULT '[]',
  ativo         BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── MODELOS DE DISPARO ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disparo_modelos (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name    TEXT NOT NULL,
  nome             TEXT,
  conteudo         TEXT,
  tipo             TEXT DEFAULT 'texto',
  tipo_mensagem    TEXT DEFAULT 'simples',            -- ✅ adicionado
  msg              TEXT DEFAULT '',                   -- ✅ adicionado
  msgs             JSONB DEFAULT '[]',                -- ✅ adicionado
  min_delay        INT DEFAULT 30,                    -- ✅ adicionado
  max_delay        INT DEFAULT 60,                    -- ✅ adicionado
  selected_flow_id UUID,                              -- ✅ adicionado
  status_publico   TEXT DEFAULT 'todos',              -- ✅ adicionado
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PLANOS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planos (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  id_slug      TEXT,                                  -- ✅ adicionado
  preco        NUMERIC(10,2) DEFAULT 0,
  preco_anual  NUMERIC(10,2) DEFAULT 0,
  preco_mensal NUMERIC(10,2) DEFAULT 0,               -- ✅ adicionado
  ordem        INT DEFAULT 1,
  features     JSONB DEFAULT '[]',
  descricao    TEXT,
  cor          TEXT DEFAULT '#7b7ff5',                -- ✅ adicionado
  popular      BOOLEAN DEFAULT false,                 -- ✅ adicionado
  ativo        BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PAGAMENTOS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagamentos (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name    TEXT,
  instancia        TEXT,                              -- ✅ adicionado (usado pelo checkout)
  plano            TEXT,
  billing          TEXT DEFAULT 'mensal',
  status           TEXT DEFAULT 'pending',
  mp_payment_id    TEXT,
  reference_id     TEXT UNIQUE,
  instancia_criada BOOLEAN DEFAULT false,
  expires_at       TIMESTAMPTZ,
  nome             TEXT,
  email            TEXT,
  whatsapp         TEXT,
  cpf              TEXT,
  license_key      TEXT,                              -- ✅ adicionado
  valor            NUMERIC(10,2) DEFAULT 0,           -- ✅ adicionado
  is_renewal       BOOLEAN DEFAULT false,             -- ✅ adicionado
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── TRIGGER: notifica via LISTEN/NOTIFY para Realtime ───────────────────────
CREATE OR REPLACE FUNCTION notify_change() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object(
    'table',  TG_TABLE_NAME,
    'action', TG_OP,
    'data',   CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END,
    'old',    CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) ELSE NULL END
  )::text;
  PERFORM pg_notify('evocrm_changes', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers nas tabelas principais
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages','leads','ia_config','licenses',
    'auto_replies','auto_replies_config','agendamentos_crm'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_notify ON %s', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_notify AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION notify_change()',
      t, t
    );
  END LOOP;
END$$;

-- ─── MIGRAÇÃO: TMA / TME ──────────────────────────────────────────────────────
-- Execute estas linhas no banco existente (sem recriar tabelas):
ALTER TABLE leads ADD COLUMN IF NOT EXISTS atendimento_inicio TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS atendimento_fim    TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tma_segundos       INTEGER     DEFAULT NULL;

-- ─── FILA DE ATENDIMENTO ─────────────────────────────────────────────────────
-- Cada linha representa uma entrada de cliente na fila de um departamento.
-- Status: 'aguardando' → 'em_atendimento' → 'encerrado'
CREATE TABLE IF NOT EXISTS fila_atendimento (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name       TEXT NOT NULL,
  lead_id             TEXT NOT NULL,
  numero              TEXT,
  nome                TEXT,
  departamento        TEXT NOT NULL,
  posicao             INTEGER DEFAULT 1,
  status              TEXT DEFAULT 'aguardando',         -- aguardando | em_atendimento | encerrado
  motivo_entrada      TEXT DEFAULT '',
  agente_id           TEXT DEFAULT NULL,
  agente_nome         TEXT DEFAULT NULL,
  entrada_em          TIMESTAMPTZ DEFAULT NOW(),
  inicio_atendimento  TIMESTAMPTZ DEFAULT NULL,
  fim_atendimento     TIMESTAMPTZ DEFAULT NULL,
  tme_segundos        INTEGER DEFAULT NULL,              -- tempo médio de espera (entrada → início)
  tma_segundos        INTEGER DEFAULT NULL,              -- tempo médio de atendimento (início → fim)
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fila_inst_dept_status ON fila_atendimento(instance_name, departamento, status);
CREATE INDEX IF NOT EXISTS idx_fila_lead              ON fila_atendimento(lead_id);

-- ─── HISTÓRICO DE ATENDIMENTOS ───────────────────────────────────────────────
-- Espelho "eventificado" do atendimento (útil para relatórios por agente/depto).
CREATE TABLE IF NOT EXISTS atendimentos (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name  TEXT NOT NULL,
  lead_id        TEXT NOT NULL,
  fila_id        UUID,
  departamento   TEXT,
  agente_id      TEXT,
  agente_nome    TEXT,
  numero         TEXT,
  nome           TEXT,
  inicio         TIMESTAMPTZ DEFAULT NOW(),
  fim            TIMESTAMPTZ DEFAULT NULL,
  tme_segundos   INTEGER DEFAULT NULL,
  tma_segundos   INTEGER DEFAULT NULL,
  status         TEXT DEFAULT 'ativo',                   -- ativo | encerrado
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_atend_inst_dept ON atendimentos(instance_name, departamento);
CREATE INDEX IF NOT EXISTS idx_atend_fila      ON atendimentos(fila_id);

-- ─── LEMBRETES RECORRENTES ───────────────────────────────────────────────────
-- Admin pode enviar para qualquer setor/pessoa. Supervisor apenas para seu setor.
CREATE TABLE IF NOT EXISTS lembretes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_name   TEXT NOT NULL,
  titulo          TEXT NOT NULL,
  mensagem        TEXT,
  tipo            TEXT DEFAULT 'info',
  criado_por      TEXT NOT NULL,
  criado_por_dept TEXT NOT NULL,
  destinatarios   TEXT NOT NULL DEFAULT '[]',
  horario         TEXT NOT NULL DEFAULT '09:00',
  recorrencia     TEXT NOT NULL DEFAULT 'diario',
  dias_semana     TEXT DEFAULT '[]',
  dia_mes         INTEGER DEFAULT 1,
  ativo           BOOLEAN DEFAULT true,
  ultimo_envio    TIMESTAMPTZ DEFAULT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lembretes_inst ON lembretes(instance_name, ativo);
