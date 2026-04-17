// db.js — SQLite via sql.js (WebAssembly puro — sem compilação nativa)
// Drop-in replacement do PostgreSQL. Mesmo API do server.js original.
// Banco salvo em disco como arquivo .db, carregado em memória ao iniciar.

const fs          = require('fs');
const pathMod     = require('path');
const crypto      = require('crypto');
const { EventEmitter } = require('events');

const DB_PATH = process.env.DB_PATH || '/app/data/evocrm.db';
console.log('🟢 [DB] db.js v2 carregado — UPSERT manual sem ON CONFLICT');
fs.mkdirSync(pathMod.dirname(DB_PATH), { recursive: true });

// Emite eventos de mudança para o server.js (substitui pg_notify)
const dbEvents = new EventEmitter();
dbEvents.setMaxListeners(200);

// ── ESTADO GLOBAL ─────────────────────────────────────────────────────────────
let _db     = null;
let _ready  = false;
let _saveTimer = null;

// ── INICIALIZAÇÃO ASSÍNCRONA ──────────────────────────────────────────────────
async function initDb() {
    if (_ready) return;
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
        const buf = fs.readFileSync(DB_PATH);
        _db = new SQL.Database(buf);
        console.log(`✅ [DB] SQLite carregado: ${DB_PATH} (${(buf.length/1024).toFixed(1)} KB)`);
    } else {
        _db = new SQL.Database();
        console.log(`✅ [DB] SQLite novo banco criado: ${DB_PATH}`);
    }

    _db.run('PRAGMA foreign_keys = ON');
    _criarTabelas();
    _persistir(true);
    _ready = true;
}

// Salva banco em disco (debounce 800ms — evita gravar a cada msg)
function _persistir(imediato = false) {
    if (!_db) return;
    if (imediato) {
        try {
            const data = _db.export();
            fs.writeFileSync(DB_PATH, Buffer.from(data));
        } catch(e) { console.error('[DB] Erro ao salvar:', e.message); }
        return;
    }
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            const data = _db.export();
            fs.writeFileSync(DB_PATH, Buffer.from(data));
        } catch(e) { console.error('[DB] Erro ao salvar:', e.message); }
    }, 300);
}

// ── SCHEMA COMPLETO ───────────────────────────────────────────────────────────
function _criarTabelas() {
    _db.run(`
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, instance_name TEXT UNIQUE NOT NULL,
  license_key TEXT, plano TEXT DEFAULT 'basico', status TEXT DEFAULT 'active',
  features TEXT DEFAULT '{}', expires_at TEXT, is_trial INTEGER DEFAULT 0,
  renewal_url TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_config (
  id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  nome TEXT, numero TEXT, status TEXT DEFAULT 'novo', etiquetas TEXT DEFAULT '',
  foto_url TEXT, departamento TEXT DEFAULT 'ADM Principal',
  last_interaction TEXT, last_msg TEXT, unread INTEGER DEFAULT 0,
  push_name TEXT, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_numero   ON leads(instance_name, numero);
CREATE INDEX IF NOT EXISTS idx_leads_instance ON leads(instance_name);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  content TEXT, type TEXT DEFAULT 'text', from_me INTEGER DEFAULT 0,
  status TEXT DEFAULT 'sent', sent_by_ia INTEGER, push_name TEXT,
  timestamp TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_lead     ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_name);
CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at);
CREATE TABLE IF NOT EXISTS ia_config (
  id TEXT PRIMARY KEY, instance_name TEXT UNIQUE NOT NULL,
  ativo INTEGER DEFAULT 0, api_key TEXT, modelo TEXT DEFAULT 'gpt-4o-mini',
  prompt TEXT DEFAULT '', selected_prompt_id TEXT,
  delay_min INTEGER DEFAULT 1, delay_max INTEGER DEFAULT 3,
  pausa_se_humano INTEGER DEFAULT 1, responder_grupos INTEGER DEFAULT 0,
  pausa_tempo INTEGER DEFAULT 30, palavra_chave TEXT DEFAULT '',
  palavra_retomar TEXT DEFAULT '', buffer_tempo INTEGER DEFAULT 8,
  msg_max_chars INTEGER DEFAULT 300, msg_delay_partes INTEGER DEFAULT 2,
  msg_quebrar_linhas INTEGER DEFAULT 1,
  tts_mode TEXT DEFAULT 'off', tts_voz TEXT DEFAULT 'nova',
  tts_max_seconds INTEGER DEFAULT 10, tts_frequencia INTEGER DEFAULT 50,
  temperatura REAL DEFAULT 0.7, max_tokens INTEGER DEFAULT 1024,
  bot_identifiers TEXT DEFAULT '', bot_rate_limit INTEGER DEFAULT 6,
  bot_rate_window INTEGER DEFAULT 60,
  followup_ativo INTEGER DEFAULT 0, followup_max_tentativas INTEGER DEFAULT 3,
  followup_tempo_1 INTEGER DEFAULT 30, followup_unidade_1 TEXT DEFAULT 'minutos',
  followup_tempo_2 INTEGER DEFAULT 2,  followup_unidade_2 TEXT DEFAULT 'horas',
  followup_tempo_3 INTEGER DEFAULT 1,  followup_unidade_3 TEXT DEFAULT 'dias',
  followup_horario_inicio INTEGER DEFAULT 8, followup_horario_fim INTEGER DEFAULT 20,
  followup_ignorar_colunas TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ia_prompts (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  nome TEXT, descricao TEXT, prompt TEXT, conteudo TEXT,
  modelo TEXT DEFAULT 'gpt-4o-mini', temperatura REAL DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 1024, pausa_se_humano INTEGER DEFAULT 1,
  responder_grupos INTEGER DEFAULT 0, delay_min INTEGER DEFAULT 1,
  delay_max INTEGER DEFAULT 3, palavra_chave TEXT DEFAULT '',
  updated_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ia_midias (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  nome TEXT, tipo TEXT, url TEXT, palavras_chave TEXT DEFAULT '',
  descricao TEXT, ativo INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ia_pausa (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  pausado INTEGER DEFAULT 0, pausado_por TEXT, pausado_em TEXT,
  retomado_em TEXT, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(instance_name, lead_id)
);
CREATE TABLE IF NOT EXISTS ia_buffer (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  msgs TEXT DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(instance_name, lead_id)
);
CREATE TABLE IF NOT EXISTS ia_historico (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT, pergunta TEXT, resposta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agendamentos_crm (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  avulso_name TEXT, numero TEXT, tipo TEXT DEFAULT 'simples',
  texto TEXT, flow_id TEXT, data_hora TEXT,
  sent INTEGER DEFAULT 0, status TEXT DEFAULT 'ativo',
  lembrete_enviado INTEGER DEFAULT 0, criado_por_ia INTEGER DEFAULT 0,
  data_hora_anterior TEXT, reagendado_em TEXT, alterado_por TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agenda_instance ON agendamentos_crm(instance_name, sent, status);
CREATE TABLE IF NOT EXISTS agenda_config (
  id TEXT PRIMARY KEY, instance_name TEXT UNIQUE NOT NULL,
  ia_verificar INTEGER DEFAULT 0,
  dias_semana TEXT DEFAULT '{"1":true,"2":true,"3":true,"4":true,"5":true}',
  horario_inicio TEXT DEFAULT '08:00', horario_fim TEXT DEFAULT '18:00',
  duracao_slot INTEGER DEFAULT 60, almoco_ativo INTEGER DEFAULT 0,
  almoco_inicio TEXT DEFAULT '12:00', almoco_fim TEXT DEFAULT '13:00',
  max_por_dia INTEGER DEFAULT 8,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  name TEXT NOT NULL, access_key TEXT DEFAULT 'admin123',
  descricao TEXT, cor TEXT DEFAULT '#6366f1',
  palavras_chave TEXT DEFAULT '',
  msg_roteamento TEXT DEFAULT 'Você está sendo direcionado para o setor responsável. Em breve um de nossos atendentes irá te atender. 😊',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(instance_name, name)
);
CREATE TABLE IF NOT EXISTS kanban_columns (
  id TEXT PRIMARY KEY, instance_name TEXT UNIQUE NOT NULL,
  columns_json TEXT, updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS crm_tags (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  name TEXT NOT NULL, color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(instance_name, name)
);
CREATE TABLE IF NOT EXISTS dash_notifs (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  title TEXT, body TEXT, type TEXT DEFAULT 'info',
  read INTEGER DEFAULT 0, criado_por_ia INTEGER DEFAULT 0,
  lead_id TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifs_instance ON dash_notifs(instance_name, read);
CREATE TABLE IF NOT EXISTS dash_tasks (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  title TEXT, "desc" TEXT, priority TEXT DEFAULT 'media',
  tag TEXT DEFAULT 'geral', due TEXT, done INTEGER DEFAULT 0,
  criado_por_ia INTEGER DEFAULT 0, lead_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auto_replies (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  gatilhos TEXT NOT NULL, modo_match TEXT DEFAULT 'contem',
  blocos TEXT DEFAULT '[]', ativo INTEGER DEFAULT 1,
  apenas_uma_vez INTEGER DEFAULT 0, prioridade INTEGER DEFAULT 2,
  disparos INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auto_replies_config (
  id TEXT PRIMARY KEY, instance_name TEXT UNIQUE NOT NULL,
  bot_ativo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS auto_replies_respondidos (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  regra_id TEXT NOT NULL, lead_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(instance_name, regra_id, lead_id)
);
CREATE TABLE IF NOT EXISTS chatbot_rules (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  trigger_text TEXT DEFAULT '', response_text TEXT DEFAULT '',
  media_url TEXT, media_type TEXT,
  departamento TEXT DEFAULT 'ADM Principal',
  ativo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bot_flows (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  name TEXT, steps TEXT DEFAULT '[]', ativo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS disparo_modelos (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  nome TEXT, conteudo TEXT, tipo TEXT DEFAULT 'texto',
  tipo_mensagem TEXT DEFAULT 'simples',
  msg TEXT DEFAULT '', msgs TEXT DEFAULT '[]',
  min_delay INTEGER DEFAULT 30, max_delay INTEGER DEFAULT 60,
  selected_flow_id TEXT, status_publico TEXT DEFAULT 'todos',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS planos (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  preco REAL DEFAULT 0, preco_anual REAL DEFAULT 0, ordem INTEGER DEFAULT 1,
  features TEXT DEFAULT '[]', descricao TEXT, ativo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pagamentos (
  id TEXT PRIMARY KEY, instance_name TEXT, plano TEXT,
  billing TEXT DEFAULT 'mensal', status TEXT DEFAULT 'pending',
  mp_payment_id TEXT, reference_id TEXT UNIQUE,
  instancia_criada INTEGER DEFAULT 0, expires_at TEXT,
  nome TEXT, email TEXT, whatsapp TEXT, cpf TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fila_atendimento (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  numero TEXT, nome TEXT, departamento TEXT NOT NULL,
  posicao INTEGER DEFAULT 0, status TEXT DEFAULT 'aguardando',
  agente_id TEXT, agente_nome TEXT,
  entrada_em TEXT DEFAULT (datetime('now')),
  inicio_atendimento TEXT, fim_atendimento TEXT,
  tme_segundos INTEGER, tma_segundos INTEGER,
  motivo_entrada TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fila_instance ON fila_atendimento(instance_name, status);
CREATE INDEX IF NOT EXISTS idx_fila_dept    ON fila_atendimento(instance_name, departamento, status);
CREATE TABLE IF NOT EXISTS atendimentos (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT, fila_id TEXT, departamento TEXT,
  agente_id TEXT, agente_nome TEXT, numero TEXT, nome TEXT,
  inicio TEXT, fim TEXT,
  tme_segundos INTEGER, tma_segundos INTEGER,
  status TEXT DEFAULT 'ativo',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_atend_instance ON atendimentos(instance_name, status);
CREATE INDEX IF NOT EXISTS idx_atend_dept     ON atendimentos(instance_name, departamento);
CREATE INDEX IF NOT EXISTS idx_atend_criado   ON atendimentos(created_at);
CREATE TABLE IF NOT EXISTS internal_chat (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  from_dept TEXT, to_dept TEXT, from_nome TEXT, content TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ichat_instance ON internal_chat(instance_name);
CREATE INDEX IF NOT EXISTS idx_ichat_to       ON internal_chat(instance_name, to_dept);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  nome TEXT, departamento TEXT, status TEXT DEFAULT 'disponivel',
  current_lead_id TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_instance ON agents(instance_name);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  nome TEXT NOT NULL, tipo TEXT DEFAULT 'txt',
  conteudo_raw TEXT DEFAULT '', chunks TEXT DEFAULT '[]',
  tamanho INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_instance ON knowledge_docs(instance_name);

CREATE TABLE IF NOT EXISTS lead_documentos (
  id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
  nome TEXT NOT NULL, descricao TEXT DEFAULT '',
  arquivo_url TEXT NOT NULL, arquivo_tipo TEXT DEFAULT '',
  arquivo_tamanho INTEGER DEFAULT 0, versao INTEGER DEFAULT 1,
  notificar INTEGER DEFAULT 1, criado_por TEXT DEFAULT 'operador',
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_docs ON lead_documentos(instance_name, lead_id);

    `);

    // ── MIGRAÇÕES: adiciona colunas novas em bancos existentes (ALTER TABLE é seguro — ignora se já existe)
    const migrations = [
        // chatbot_rules: colunas novas
        "ALTER TABLE chatbot_rules ADD COLUMN trigger_text TEXT DEFAULT ''",
        "ALTER TABLE chatbot_rules ADD COLUMN response_text TEXT DEFAULT ''",
        "ALTER TABLE chatbot_rules ADD COLUMN media_url TEXT",
        "ALTER TABLE chatbot_rules ADD COLUMN media_type TEXT",
        "ALTER TABLE chatbot_rules ADD COLUMN departamento TEXT DEFAULT 'ADM Principal'",
        // disparo_modelos: colunas novas
        "ALTER TABLE disparo_modelos ADD COLUMN tipo_mensagem TEXT DEFAULT 'simples'",
        "ALTER TABLE disparo_modelos ADD COLUMN msg TEXT DEFAULT ''",
        "ALTER TABLE disparo_modelos ADD COLUMN msgs TEXT DEFAULT '[]'",
        "ALTER TABLE disparo_modelos ADD COLUMN min_delay INTEGER DEFAULT 30",
        "ALTER TABLE disparo_modelos ADD COLUMN max_delay INTEGER DEFAULT 60",
        "ALTER TABLE disparo_modelos ADD COLUMN selected_flow_id TEXT",
        "ALTER TABLE disparo_modelos ADD COLUMN status_publico TEXT DEFAULT 'todos'",
        // ia_prompts: colunas novas
        "ALTER TABLE ia_prompts ADD COLUMN descricao TEXT",
        "ALTER TABLE ia_prompts ADD COLUMN prompt TEXT",
        "ALTER TABLE ia_prompts ADD COLUMN modelo TEXT DEFAULT 'gpt-4o-mini'",
        "ALTER TABLE ia_prompts ADD COLUMN temperatura REAL DEFAULT 0.7",
        "ALTER TABLE ia_prompts ADD COLUMN max_tokens INTEGER DEFAULT 1024",
        "ALTER TABLE ia_prompts ADD COLUMN pausa_se_humano INTEGER DEFAULT 1",
        "ALTER TABLE ia_prompts ADD COLUMN responder_grupos INTEGER DEFAULT 0",
        "ALTER TABLE ia_prompts ADD COLUMN delay_min INTEGER DEFAULT 1",
        "ALTER TABLE ia_prompts ADD COLUMN delay_max INTEGER DEFAULT 3",
        "ALTER TABLE ia_prompts ADD COLUMN palavra_chave TEXT DEFAULT ''",
        "ALTER TABLE ia_prompts ADD COLUMN updated_at TEXT",
        // dash_notifs: coluna tipo_agenda
        "ALTER TABLE dash_notifs ADD COLUMN tipo_agenda INTEGER DEFAULT 0",
        // crm_tags: renomear colunas (SQLite não suporta RENAME COLUMN antigo — usar ADD + cópia)
        "ALTER TABLE crm_tags ADD COLUMN name TEXT",
        "ALTER TABLE crm_tags ADD COLUMN color TEXT DEFAULT '#6366f1'",
        // departments: colunas novas
        "ALTER TABLE departments ADD COLUMN name TEXT",
        "ALTER TABLE departments ADD COLUMN access_key TEXT DEFAULT 'admin123'",
        "ALTER TABLE departments ADD COLUMN palavras_chave TEXT DEFAULT ''",
        "ALTER TABLE departments ADD COLUMN msg_roteamento TEXT DEFAULT 'Você está sendo direcionado para o setor responsável. Em breve um de nossos atendentes irá te atender. 😊'",
        // ia_config: colunas novas
        "ALTER TABLE ia_config ADD COLUMN msg_quebrar_linhas INTEGER DEFAULT 1",
        // agendamentos: colunas novas
        "ALTER TABLE agendamentos_crm ADD COLUMN avulso_name TEXT",
        "ALTER TABLE agendamentos_crm ADD COLUMN data_hora_anterior TEXT",
        // leads: colunas que faltavam (observacao nunca existiu no schema original)
        "ALTER TABLE leads ADD COLUMN observacao TEXT",
        // leads: sentimento (positivo | negativo | neutro) — analisado pela IA no servidor
        "ALTER TABLE leads ADD COLUMN sentimento TEXT",
        // pagamentos: colunas usadas pelo checkout
        "ALTER TABLE pagamentos ADD COLUMN license_key TEXT",
        "ALTER TABLE pagamentos ADD COLUMN valor REAL DEFAULT 0",
        "ALTER TABLE pagamentos ADD COLUMN instancia TEXT",
        "ALTER TABLE pagamentos ADD COLUMN is_renewal INTEGER DEFAULT 0",
        // planos: colunas de layout usadas pelo checkout/evolution
        "ALTER TABLE planos ADD COLUMN cor TEXT DEFAULT '#7b7ff5'",
        "ALTER TABLE planos ADD COLUMN popular INTEGER DEFAULT 0",
        "ALTER TABLE planos ADD COLUMN preco_mensal REAL DEFAULT 0",
        "ALTER TABLE planos ADD COLUMN id_slug TEXT",

        // fila_atendimento — migrações para bancos existentes
        "ALTER TABLE fila_atendimento ADD COLUMN tme_segundos INTEGER",
        "ALTER TABLE fila_atendimento ADD COLUMN tma_segundos INTEGER",
        "ALTER TABLE fila_atendimento ADD COLUMN motivo_entrada TEXT",
        // atendimentos
        "ALTER TABLE atendimentos ADD COLUMN numero TEXT",
        "ALTER TABLE atendimentos ADD COLUMN nome TEXT",
        // agents
        "ALTER TABLE agents ADD COLUMN current_lead_id TEXT",
        // ia_config: temperatura e max_tokens
        "ALTER TABLE ia_config ADD COLUMN temperatura REAL DEFAULT 0.7",
        "ALTER TABLE ia_config ADD COLUMN max_tokens INTEGER DEFAULT 1024",
        // ia_config: follow-up
        "ALTER TABLE ia_config ADD COLUMN followup_ativo INTEGER DEFAULT 0",
        "ALTER TABLE ia_config ADD COLUMN followup_max_tentativas INTEGER DEFAULT 3",
        "ALTER TABLE ia_config ADD COLUMN followup_tempo_1 INTEGER DEFAULT 30",
        "ALTER TABLE ia_config ADD COLUMN followup_unidade_1 TEXT DEFAULT 'minutos'",
        "ALTER TABLE ia_config ADD COLUMN followup_tempo_2 INTEGER DEFAULT 2",
        "ALTER TABLE ia_config ADD COLUMN followup_unidade_2 TEXT DEFAULT 'horas'",
        "ALTER TABLE ia_config ADD COLUMN followup_tempo_3 INTEGER DEFAULT 1",
        "ALTER TABLE ia_config ADD COLUMN followup_unidade_3 TEXT DEFAULT 'dias'",
        "ALTER TABLE ia_config ADD COLUMN followup_horario_inicio INTEGER DEFAULT 8",
        "ALTER TABLE ia_config ADD COLUMN followup_horario_fim INTEGER DEFAULT 20",
        "ALTER TABLE ia_config ADD COLUMN followup_ignorar_colunas TEXT DEFAULT ''",
        // leads: prompt específico por conversa
        "ALTER TABLE leads ADD COLUMN prompt_id TEXT",
        // leads: controle de atendimento para TMA/TME
        "ALTER TABLE leads ADD COLUMN atendimento_inicio TEXT",
        "ALTER TABLE leads ADD COLUMN atendimento_fim TEXT",
        "ALTER TABLE leads ADD COLUMN tma_segundos INTEGER",
        // chat_interno: garante tabela em bancos existentes
        `CREATE TABLE IF NOT EXISTS chat_interno (
            id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
            lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
            from_dept TEXT NOT NULL, content TEXT NOT NULL,
            lido INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
        )`,
        "CREATE INDEX IF NOT EXISTS idx_chat_interno_lead ON chat_interno(lead_id)",
        // leads: follow-up / reengajamento
        "ALTER TABLE leads ADD COLUMN followup_count INTEGER DEFAULT 0",
        "ALTER TABLE leads ADD COLUMN followup_last_at TEXT DEFAULT NULL",
        "ALTER TABLE leads ADD COLUMN followup_paused INTEGER DEFAULT 0",
        "ALTER TABLE leads ADD COLUMN followup_lead_ativo INTEGER DEFAULT 0",
        // Supervisor por departamento
        "ALTER TABLE departments ADD COLUMN supervisor_nome TEXT",
        "ALTER TABLE departments ADD COLUMN supervisor_key TEXT",
        "ALTER TABLE departments ADD COLUMN supervisor_id TEXT",
        // Atendente atribuído ao lead
        "ALTER TABLE leads ADD COLUMN atendente_nome TEXT",
    ];
    // Índice de follow-up (criado após as colunas existirem)
    try { _db.run("CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(instance_name, followup_paused, followup_count, last_interaction)"); } catch(e) {}
    // lead_documentos — criar tabela se não existir em bancos antigos
    try {
        _db.run(`CREATE TABLE IF NOT EXISTS lead_documentos (
            id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
            lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
            nome TEXT NOT NULL, descricao TEXT DEFAULT \'\',
            arquivo_url TEXT NOT NULL, arquivo_tipo TEXT DEFAULT \'\',
            arquivo_tamanho INTEGER DEFAULT 0, versao INTEGER DEFAULT 1,
            notificar INTEGER DEFAULT 1, criado_por TEXT DEFAULT \'operador\',
            updated_at TEXT DEFAULT (datetime(\'now\')),
            created_at TEXT DEFAULT (datetime(\'now\'))
        )`);
        _db.run(`CREATE INDEX IF NOT EXISTS idx_lead_docs ON lead_documentos(instance_name, lead_id)`);
    } catch(e) { /* já existe */ }
    // dept_atendentes — atendentes por departamento (criados pelo supervisor)
    try {
        _db.run(`CREATE TABLE IF NOT EXISTS dept_atendentes (
            id TEXT PRIMARY KEY, instance_name TEXT NOT NULL,
            dept_id TEXT NOT NULL, nome TEXT NOT NULL,
            senha TEXT NOT NULL, ativo INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        )`);
        _db.run(`CREATE INDEX IF NOT EXISTS idx_dept_atend_inst ON dept_atendentes(instance_name, dept_id)`);
    } catch(e) { /* já existe */ }
    // Copia dados de colunas antigas para novas (crm_tags e departments)
    try { _db.run("UPDATE crm_tags SET name = nome WHERE name IS NULL AND nome IS NOT NULL"); } catch(e) {}
    try { _db.run("UPDATE crm_tags SET color = cor WHERE color IS NULL AND cor IS NOT NULL"); } catch(e) {}
    try { _db.run("UPDATE departments SET name = nome WHERE name IS NULL AND nome IS NOT NULL"); } catch(e) {}
    for (const sql of migrations) {
        try { _db.run(sql); } catch(e) { /* coluna já existe — ignorar */ }
    }
    // Garante índices únicos em bancos migrados via ALTER TABLE
    ['CREATE UNIQUE INDEX IF NOT EXISTS idx_depts_inst_name ON departments(instance_name, name)',
     'CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_inst_name  ON crm_tags(instance_name, name)'
    ].forEach(s => { try { _db.run(s); } catch(e) {} });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function newId() { return crypto.randomUUID(); }

const BOOL_FIELDS = new Set([
    'ativo','from_me','sent_by_ia','pausado','sent','lembrete_enviado',
    'criado_por_ia','done','read','is_trial','instancia_criada',
    'pausa_se_humano','responder_grupos','ia_verificar','almoco_ativo',
    'apenas_uma_vez','bot_ativo','msg_quebrar_linhas'
]);
const JSON_FIELDS = new Set(['features','blocos','steps','dias_semana','columns_json']);

function normalizeRow(row) {
    if (!row) return null;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (BOOL_FIELDS.has(k)) {
            out[k] = v === null ? null : (v === 1 || v === true);
        } else if (JSON_FIELDS.has(k) && typeof v === 'string') {
            try { out[k] = JSON.parse(v); } catch { out[k] = v; }
        } else {
            out[k] = v;
        }
    }
    return out;
}

function prepareVal(v) {
    if (v === true)  return 1;
    if (v === false) return 0;
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
}

function _waitReady() {
    if (_ready) return Promise.resolve();
    return new Promise(resolve => {
        const t = setInterval(() => { if (_ready) { clearInterval(t); resolve(); } }, 50);
    });
}

function _runSelect(sql, vals = []) {
    const stmt = _db.prepare(sql);
    stmt.bind(vals.map(prepareVal));
    const rows = [];
    while (stmt.step()) rows.push(normalizeRow(stmt.getAsObject()));
    stmt.free();
    return rows;
}

// ── QUERY RAW ─────────────────────────────────────────────────────────────────
async function query(sql, params = []) {
    await _waitReady();
    const prepared = params.map(prepareVal);
    try {
        if (sql.trim().toUpperCase().startsWith('SELECT')) {
            return { rows: _runSelect(sql, params) };
        } else {
            _db.run(sql, prepared);
            _persistir();
            return { rows: [], rowCount: 1 };
        }
    } catch(e) {
        console.error('[DB] query erro:', e.message);
        throw e;
    }
}

// ── QUERY BUILDER ─────────────────────────────────────────────────────────────
function from(table) { return new QueryBuilder(table); }

class QueryBuilder {
    constructor(table) {
        this._table  = table;
        this._select = '*';
        this._wheres = [];
        this._wVals  = [];
        this._order  = null;
        this._limit  = null;
        this._single = false;
        this._op     = 'SELECT';
        this._data   = null;
        this._upsertConflict = null;
    }

    select(cols = '*') { this._select = cols; return this; }
    eq(col, val)  { this._wheres.push(`"${col}" = ?`);  this._wVals.push(prepareVal(val)); return this; }
    neq(col, val) { this._wheres.push(`"${col}" != ?`); this._wVals.push(prepareVal(val)); return this; }
    gt(col, val)  { this._wheres.push(`"${col}" > ?`);  this._wVals.push(prepareVal(val)); return this; }
    gte(col, val) { this._wheres.push(`"${col}" >= ?`); this._wVals.push(prepareVal(val)); return this; }
    lt(col, val)  { this._wheres.push(`"${col}" < ?`);  this._wVals.push(prepareVal(val)); return this; }
    lte(col, val) { this._wheres.push(`"${col}" <= ?`); this._wVals.push(prepareVal(val)); return this; }
    not(col, op, val) {
        if (op === 'is' && val === null) {
            this._wheres.push(`"${col}" IS NOT NULL`);
        } else if (op === 'is') {
            this._wheres.push(`"${col}" IS NOT ?`);
            this._wVals.push(prepareVal(val));
        } else {
            this._wheres.push(`NOT ("${col}" ${op} ?)`);
            this._wVals.push(prepareVal(val));
        }
        return this;
    }
    in(col, vals) {
        const arr = Array.isArray(vals) ? vals : [vals];
        this._wheres.push(`"${col}" IN (${arr.map(()=>'?').join(',')})`);
        this._wVals.push(...arr.map(prepareVal));
        return this;
    }
    order(col, opts = {}) {
        this._order = `"${col}" ${opts.ascending === false ? 'DESC' : 'ASC'}`;
        return this;
    }
    limit(n)  { this._limit = n;    return this; }
    single()  { this._single = true; return this; }
    insert(data)  { this._op = 'INSERT'; this._data = data; return this; }
    update(data)  { this._op = 'UPDATE'; this._data = data; return this; }
    delete()      { this._op = 'DELETE'; return this; }
    upsert(data, opts = {}) {
        this._op = 'UPSERT'; this._data = data;
        this._upsertConflict = opts.onConflict || null;
        return this;
    }

    _where() { return this._wheres.length ? ' WHERE ' + this._wheres.join(' AND ') : ''; }
    _emit(action, data, old = null) { dbEvents.emit('change', { table: this._table, action, data, old }); }

    async _execute() {
        await _waitReady();
        try {
            const table = this._table;
            const where = this._where();

            // ── SELECT ───────────────────────────────────────────────────────
            if (this._op === 'SELECT') {
                let sql = `SELECT ${this._select} FROM "${table}"${where}`;
                if (this._order) sql += ` ORDER BY ${this._order}`;
                if (this._limit) sql += ` LIMIT ${this._limit}`;
                const rows = _runSelect(sql, this._wVals);
                if (this._single) {
                    const row = rows[0] || null;
                    return { data: row, error: row ? null : { code: 'PGRST116', message: 'Row not found' } };
                }
                return { data: rows, error: null };
            }

            // ── INSERT ───────────────────────────────────────────────────────
            if (this._op === 'INSERT') {
                const rows = Array.isArray(this._data) ? this._data : [this._data];
                const results = [];
                for (const row of rows) {
                    if (!row.id) row.id = newId();
                    if (!row.created_at) row.created_at = new Date().toISOString();
                    // Espelha campos novos→antigos para tabelas que têm colunas legadas NOT NULL
                    if (table === 'crm_tags') {
                        if (row.name && !row.nome)  row.nome = row.name;
                        if (row.color && !row.cor)   row.cor  = row.color;
                    }
                    if (table === 'departments') {
                        if (row.name && !row.nome)  row.nome = row.name;
                    }
                    const keys = Object.keys(row);
                    const vals = keys.map(k => prepareVal(row[k]));
                    const cols = keys.map(k => `"${k}"`).join(',');
                    const phs  = keys.map(() => '?').join(',');
                    _db.run(`INSERT INTO "${table}" (${cols}) VALUES (${phs})`, vals);
                    const inserted = _runSelect(`SELECT * FROM "${table}" WHERE id = ?`, [row.id])[0];
                    results.push(inserted);
                    this._emit('INSERT', inserted);
                }
                _persistir();
                if (this._single) {
                    const row = results[0] || null;
                    return { data: row, error: row ? null : { code: 'PGRST116', message: 'Row not found' } };
                }
                return { data: results.length === 1 ? results[0] : results, error: null };
            }

            // ── UPDATE ───────────────────────────────────────────────────────
            if (this._op === 'UPDATE') {
                const before  = _runSelect(`SELECT * FROM "${table}"${where}`, this._wVals);
                const keys    = Object.keys(this._data);
                const sets    = keys.map(k => `"${k}" = ?`).join(',');
                const setVals = keys.map(k => prepareVal(this._data[k]));
                _db.run(`UPDATE "${table}" SET ${sets}${where}`, [...setVals, ...this._wVals]);
                const after = _runSelect(`SELECT * FROM "${table}"${where}`, this._wVals);
                after.forEach((row, i) => this._emit('UPDATE', row, before[i] || null));
                _persistir();
                if (this._single) {
                    const row = after[0] || null;
                    return { data: row, error: row ? null : { code: 'PGRST116', message: 'Row not found' } };
                }
                return { data: after, error: null };
            }

            // ── DELETE ───────────────────────────────────────────────────────
            if (this._op === 'DELETE') {
                const toDelete = _runSelect(`SELECT * FROM "${table}"${where}`, this._wVals);
                _db.run(`DELETE FROM "${table}"${where}`, this._wVals);
                toDelete.forEach(row => this._emit('DELETE', row));
                _persistir();
                return { data: toDelete, error: null };
            }

            // ── UPSERT ───────────────────────────────────────────────────────
            // IMPLEMENTACAO MANUAL — sem ON CONFLICT SQL.
            // Funciona em qualquer banco, com ou sem UNIQUE constraint.
            if (this._op === 'UPSERT') {
                const rows = Array.isArray(this._data) ? this._data : [this._data];
                const results = [];
                const conflictKeys = (this._upsertConflict || 'id').split(',').map(c => c.trim());
                for (const row of rows) {
                    if (!row.created_at) row.created_at = new Date().toISOString();
                    if (table === 'crm_tags') {
                        if (row.name && !row.nome) row.nome = row.name;
                        if (row.color && !row.cor)  row.cor  = row.color;
                    }
                    if (table === 'departments') {
                        if (row.name && !row.nome) row.nome = row.name;
                    }
                    // 1. Busca linha existente pelos conflictKeys
                    let existing = null;
                    const ck0 = conflictKeys[0];
                    if (ck0 && row[ck0] !== undefined) {
                        let fSql = 'SELECT * FROM "' + table + '" WHERE "' + ck0 + '" = ?';
                        const fVals = [prepareVal(row[ck0])];
                        for (let ci = 1; ci < conflictKeys.length; ci++) {
                            const ck = conflictKeys[ci];
                            if (ck && row[ck] !== undefined) {
                                fSql += ' AND "' + ck + '" = ?';
                                fVals.push(prepareVal(row[ck]));
                            }
                        }
                        const found = _runSelect(fSql, fVals);
                        if (found.length > 0) existing = found[0];
                    }
                    if (existing) {
                        // 2a. UPDATE — preserva id e created_at originais
                        row.id = existing.id;
                        const upKeys = Object.keys(row).filter(k => k !== 'id' && k !== 'created_at');
                        if (upKeys.length > 0) {
                            const sets   = upKeys.map(k => '"' + k + '" = ?').join(', ');
                            const upVals = upKeys.map(k => prepareVal(row[k]));
                            _db.run('UPDATE "' + table + '" SET ' + sets + ' WHERE id = ?', [...upVals, existing.id]);
                        }
                    } else {
                        // 2b. INSERT
                        if (!row.id) row.id = newId();
                        const iKeys = Object.keys(row);
                        const cols  = iKeys.map(k => '"' + k + '"').join(', ');
                        const phs   = iKeys.map(() => '?').join(', ');
                        const vals  = iKeys.map(k => prepareVal(row[k]));
                        _db.run('INSERT INTO "' + table + '" (' + cols + ') VALUES (' + phs + ')', vals);
                    }
                    const upserted = _runSelect('SELECT * FROM "' + table + '" WHERE id = ?', [row.id])[0];
                    results.push(upserted);
                    this._emit('UPSERT', upserted);
                }
                _persistir();
                if (this._single) {
                    const row = results[0] || null;
                    return { data: row, error: row ? null : { code: 'PGRST116', message: 'Row not found' } };
                }
                return { data: results, error: null };
            }

        } catch(e) {
            console.error(`[DB] Erro ${this._op} ${this._table}:`, e.message);
            return { data: null, error: { message: e.message, code: e.code } };
        }
    }

    then(resolve, reject) { return this._execute().then(resolve, reject); }
}

const pool   = { on: () => {}, end: () => {} };
const Client = class {};

module.exports = { query, from, pool, Client, dbEvents, initDb };
