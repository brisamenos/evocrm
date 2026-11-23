// ═══════════════════════════════════════════════════════════════════════════════
// SITE + ADMIN DAS INSCRIÇÕES
// ───────────────────────────────────────────────────────────────────────────────
//  /                  → página do site (usucapiao.html + textos salvos no Admin)
//  POST /api/inscricao → recebe o formulário, grava e repassa ao CRM
//  /admin             → painel com todos os inscritos, exportação e conexão com o CRM
//
// Cada inscrição é gravada ANTES de ir para o CRM. Se o CRM estiver fora do ar,
// ela fica na fila e é reenviada sozinha (1, 2, 5, 15, 30 min, 1 h, 2 h, 6 h...).
// Sem dependências além do sql.js (SQLite em WebAssembly): roda em qualquer lugar.
// ═══════════════════════════════════════════════════════════════════════════════
'use strict';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const criarSiteConfig = require('./site-config.js');
let site = null; // configuração da página + vídeos (criado depois que o banco abre)

const PORT = parseInt(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'site.db');
// Tudo fica numa pasta só. Só estes arquivos podem ser baixados pelo navegador;
// o resto (código, banco, configurações) nunca é servido.
const ADMIN_FILE = path.join(__dirname, 'admin.html');
const ARQUIVOS_PUBLICOS = new Set(['logo-padrao.png', 'favicon.ico', 'robots.txt']);
const SESSAO_DIAS = 7;
const ESPERAS_MIN = [1, 2, 5, 15, 30, 60, 120, 360, 720, 1440]; // retentativas de envio ao CRM

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── banco ──────────────────────────────────────────────────────────────────────
let db = null;
let salvarTimer = null;
function persistir(agora = false) {
    if (!db) return;
    const gravar = () => {
        salvarTimer = null;
        const tmp = DB_FILE + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(db.export()));
        fs.renameSync(tmp, DB_FILE); // troca atômica: nunca deixa o arquivo pela metade
    };
    if (agora) { if (salvarTimer) clearTimeout(salvarTimer); return gravar(); }
    if (!salvarTimer) salvarTimer = setTimeout(() => { try { gravar(); } catch (e) { console.error('[db] erro ao salvar:', e.message); } }, 300);
}
function todos(sql, params = []) {
    const st = db.prepare(sql);
    try { st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
}
const um = (sql, params) => todos(sql, params)[0] || null;
function exec(sql, params = []) { db.run(sql, params); persistir(); }

async function iniciarBanco() {
    const SQL = await initSqlJs();
    db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
    db.run(`CREATE TABLE IF NOT EXISTS inscricoes (
        id TEXT PRIMARY KEY, nome TEXT, cidade TEXT, telefone TEXT, telefone_digitos TEXT, email TEXT,
        campos TEXT, utm TEXT, pagina TEXT, ip TEXT, user_agent TEXT,
        status TEXT DEFAULT 'novo', observacao TEXT,
        crm_status TEXT DEFAULT 'pendente', crm_tentativas INTEGER DEFAULT 0, crm_proxima TEXT, crm_erro TEXT,
        crm_id TEXT, crm_enviado_em TEXT, crm_fluxo TEXT, crm_fluxo_rotulo TEXT, crm_escolha TEXT, crm_sync_em TEXT,
        created_at TEXT, updated_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, expira TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS envios (id INTEGER PRIMARY KEY AUTOINCREMENT, inscricao_id TEXT, em TEXT, ok INTEGER, detalhe TEXT)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ins_data ON inscricoes(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ins_crm ON inscricoes(crm_status, crm_proxima)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ins_tel ON inscricoes(telefone_digitos, created_at)`);
    // Senha inicial pelo ambiente (só se ainda não existir uma)
    if (!cfg('senha_hash') && process.env.ADMIN_SENHA) definirSenha(process.env.ADMIN_SENHA);
    persistir(true);
    site = criarSiteConfig({ DATA_DIR, todos, um, exec, cfg, setCfg, lerCorpo, json });
}
process.on('exit', () => { try { if (salvarTimer) persistir(true); } catch (e) {} });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

function cfg(chave, padrao = null) { const r = um('SELECT valor FROM config WHERE chave = ?', [chave]); return r ? r.valor : padrao; }
function setCfg(chave, valor) { exec('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor', [chave, valor == null ? null : String(valor)]); }

// ── utilidades ─────────────────────────────────────────────────────────────────
const agora = () => new Date().toISOString();
const limpar = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const digitos = v => String(v || '').replace(/\D/g, '');
const jsonParse = (s, pad) => { try { return s ? JSON.parse(s) : pad; } catch (e) { return pad; } };
function ipDe(req) {
    return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function lerCorpo(req, max = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let tam = 0; const partes = [];
        req.on('data', c => { tam += c.length; if (tam > max) { reject(Object.assign(new Error('Envio muito grande'), { status: 413 })); req.destroy(); } else partes.push(c); });
        req.on('end', () => {
            const txt = Buffer.concat(partes).toString('utf8');
            const tipo = String(req.headers['content-type'] || '');
            if (!txt) return resolve({});
            if (tipo.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(txt)));
            try { resolve(JSON.parse(txt)); } catch (e) { reject(Object.assign(new Error('Dados inválidos'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}
function json(res, status, obj, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(JSON.stringify(obj));
}
const janelas = new Map();
function limite(chave, max, janelaMs) {
    const t = Date.now();
    const lst = (janelas.get(chave) || []).filter(x => t - x < janelaMs);
    lst.push(t); janelas.set(chave, lst);
    if (janelas.size > 10000) janelas.delete(janelas.keys().next().value);
    return lst.length <= max;
}

// ── senha e sessão ─────────────────────────────────────────────────────────────
function hashSenha(senha, sal) { return crypto.scryptSync(String(senha), sal, 64).toString('hex'); }
function definirSenha(senha) {
    const sal = crypto.randomBytes(16).toString('hex');
    setCfg('senha_sal', sal); setCfg('senha_hash', hashSenha(senha, sal));
    exec('DELETE FROM sessoes'); // troca de senha derruba todas as sessões
}
function senhaConfere(senha) {
    const sal = cfg('senha_sal'), hash = cfg('senha_hash');
    if (!sal || !hash) return false;
    const a = Buffer.from(hashSenha(senha, sal), 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookies(req) {
    return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function sessaoValida(req) {
    const t = cookies(req).sid;
    if (!t || t.length !== 64) return false;
    const s = um('SELECT expira FROM sessoes WHERE token = ?', [t]);
    return !!(s && new Date(s.expira) > new Date());
}
function cookieSessao(req, token, maxAge) {
    const seguro = String(req.headers['x-forwarded-proto'] || '').includes('https') || req.socket.encrypted;
    return `sid=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${seguro ? '; Secure' : ''}`;
}

// ── conexão com o CRM ──────────────────────────────────────────────────────────
// Código gerado no CRM: "EVO-" + base64url({ v, u: url do CRM, t: token })
function lerCodigo(codigo) {
    const c = String(codigo || '').trim();
    if (!c.startsWith('EVO-')) throw new Error('Código inválido: ele começa com "EVO-". Copie de novo no CRM → Inscrições do site → Conexão.');
    let o;
    try { o = JSON.parse(Buffer.from(c.slice(4), 'base64url').toString('utf8')); } catch (e) { throw new Error('Código incompleto ou corrompido. Copie de novo no CRM.'); }
    if (!o || !/^https?:\/\//i.test(o.u || '') || !/^ins_[a-f0-9]{48}$/.test(o.t || '')) throw new Error('Código inválido. Copie de novo no CRM.');
    return { url: String(o.u).replace(/\/+$/, ''), token: o.t };
}
function conexao() {
    const codigo = cfg('crm_codigo');
    if (!codigo) return null;
    try { return lerCodigo(codigo); } catch (e) { return null; }
}
async function chamarCrm(rota, metodo = 'GET', corpo = null, timeoutMs = 20000) {
    const cx = conexao();
    if (!cx) throw Object.assign(new Error('CRM não conectado'), { semConexao: true });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(cx.url + rota, {
            method: metodo, signal: ctrl.signal,
            headers: { Authorization: `Bearer ${cx.token}`, 'Content-Type': 'application/json', 'User-Agent': 'SiteInscricoes/1.0' },
            body: corpo ? JSON.stringify(corpo) : undefined,
        });
        const dados = await r.json().catch(() => ({}));
        if (!r.ok || dados.ok === false) {
            throw Object.assign(new Error(dados.error || `CRM respondeu ${r.status}`), { status: r.status, definitivo: r.status === 401 || r.status === 422 });
        }
        return dados;
    } catch (e) {
        if (e.name === 'AbortError') throw Object.assign(new Error('O CRM demorou demais para responder'), { status: 0 });
        if (!e.status && !e.semConexao) e.message = `Não consegui falar com o CRM (${e.cause?.code || e.message})`;
        throw e;
    } finally { clearTimeout(t); }
}

function registrarEnvio(id, ok, detalhe) {
    exec('INSERT INTO envios (inscricao_id, em, ok, detalhe) VALUES (?, ?, ?, ?)', [id, agora(), ok ? 1 : 0, String(detalhe || '').slice(0, 500)]);
    exec(`DELETE FROM envios WHERE id NOT IN (SELECT id FROM envios ORDER BY id DESC LIMIT 5000)`);
}

async function enviarAoCrm(ins) {
    const campos = jsonParse(ins.campos, {});
    const corpo = {
        externo_id: ins.id, nome: ins.nome, telefone: ins.telefone, cidade: ins.cidade, email: ins.email || undefined,
        campos, utm: jsonParse(ins.utm, {}), pagina: ins.pagina, criado_em: ins.created_at,
    };
    try {
        const r = await chamarCrm('/api/inscricoes/receber', 'POST', corpo);
        exec(`UPDATE inscricoes SET crm_status='enviado', crm_erro=NULL, crm_id=?, crm_enviado_em=?, crm_fluxo=?, crm_proxima=NULL, updated_at=? WHERE id=?`,
            [r.id || null, agora(), r.fluxo_status || null, agora(), ins.id]);
        registrarEnvio(ins.id, true, `Recebido pelo CRM (fluxo: ${r.fluxo_status || '-'})${r.motivo ? ' — ' + r.motivo : ''}`);
        return { ok: true, resposta: r };
    } catch (e) {
        if (e.semConexao) {
            exec(`UPDATE inscricoes SET crm_status='aguardando_conexao', crm_erro=?, updated_at=? WHERE id=?`, ['CRM não conectado', agora(), ins.id]);
            return { ok: false, erro: 'CRM não conectado' };
        }
        const tent = (parseInt(ins.crm_tentativas) || 0) + 1;
        if (e.status === 401) {
            exec(`UPDATE inscricoes SET crm_status='erro_codigo', crm_tentativas=?, crm_erro=?, updated_at=? WHERE id=?`, [tent, e.message, agora(), ins.id]);
        } else if (e.status === 422) {
            exec(`UPDATE inscricoes SET crm_status='recusado', crm_tentativas=?, crm_erro=?, updated_at=? WHERE id=?`, [tent, e.message, agora(), ins.id]);
        } else if (tent >= ESPERAS_MIN.length) {
            exec(`UPDATE inscricoes SET crm_status='falhou', crm_tentativas=?, crm_erro=?, updated_at=? WHERE id=?`, [tent, e.message, agora(), ins.id]);
        } else {
            const prox = new Date(Date.now() + ESPERAS_MIN[tent - 1] * 60000).toISOString();
            exec(`UPDATE inscricoes SET crm_status='tentando', crm_tentativas=?, crm_erro=?, crm_proxima=?, updated_at=? WHERE id=?`, [tent, e.message, prox, agora(), ins.id]);
        }
        registrarEnvio(ins.id, false, e.message);
        console.warn(`[CRM] Falha ao enviar ${ins.id}: ${e.message}`);
        return { ok: false, erro: e.message };
    }
}

let filaRodando = false;
async function processarFila() {
    if (filaRodando || !conexao() || cfg('envio_ativo', '1') !== '1') return;
    filaRodando = true;
    try {
        const pend = todos(`SELECT * FROM inscricoes WHERE (crm_status IN ('pendente','aguardando_conexao')) OR (crm_status='tentando' AND crm_proxima <= ?) ORDER BY created_at ASC LIMIT 25`, [agora()]);
        for (const ins of pend) {
            const r = await enviarAoCrm(ins);
            if (!r.ok && /não consegui falar|demorou/i.test(r.erro || '')) break; // CRM fora: não insiste com os outros agora
        }
    } finally { filaRodando = false; }
}

// Traz do CRM a situação do fluxo (enviado, cliente respondeu, botão escolhido...)
let syncRodando = false;
async function sincronizarStatus(forcar = false) {
    if (syncRodando || !conexao()) return { ok: false };
    syncRodando = true;
    try {
        const desde = new Date(Date.now() - 30 * 86400000).toISOString();
        const limiteSync = new Date(Date.now() - (forcar ? 0 : 3 * 60000)).toISOString();
        const lst = todos(`SELECT id FROM inscricoes WHERE crm_status='enviado' AND created_at >= ? AND (crm_sync_em IS NULL OR crm_sync_em <= ?) ORDER BY created_at DESC LIMIT 200`, [desde, limiteSync]);
        if (!lst.length) return { ok: true, atualizadas: 0 };
        const r = await chamarCrm('/api/inscricoes/consultar', 'POST', { ids: lst.map(x => x.id) });
        let n = 0;
        for (const x of lst) {
            const it = r.itens?.[x.id];
            exec(`UPDATE inscricoes SET crm_sync_em=?${it ? ', crm_fluxo=?, crm_fluxo_rotulo=?, crm_escolha=?' : ''} WHERE id=?`,
                it ? [agora(), it.fluxo_status, it.fluxo_rotulo, it.escolha, x.id] : [agora(), x.id]);
            if (it) n++;
        }
        return { ok: true, atualizadas: n };
    } catch (e) {
        return { ok: false, erro: e.message };
    } finally { syncRodando = false; }
}

// ── formulário público ─────────────────────────────────────────────────────────
async function receberInscricao(req, res) {
    const ip = ipDe(req);
    if (!limite(`form:${ip}`, 8, 10 * 60000)) return json(res, 429, { ok: false, error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    let b;
    try { b = await lerCorpo(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }

    // Anti-robô: campo escondido preenchido ou envio rápido demais → finge sucesso e descarta
    if (limpar(b.empresa_site || b.website, 50) || (b.t !== undefined && parseInt(b.t) < 1500)) {
        console.warn(`[form] envio descartado (anti-robô) ip=${ip}`);
        return json(res, 200, { ok: true });
    }
    const nome = limpar(b.nome, 120);
    const cidade = limpar(b.cidade || b.cidade_estado, 120);
    const telefone = limpar(b.telefone, 40);
    const email = limpar(b.email, 160);
    const dig = digitos(telefone).replace(/^0+/, '').replace(/^55(?=\d{10,11}$)/, '');
    const erros = [];
    if (nome.length < 3 || !/[a-zà-ú]{2,}/i.test(nome)) erros.push('Informe seu nome completo.');
    if (cidade.length < 2) erros.push('Informe sua cidade/estado.');
    if (!/^\d{10,11}$/.test(dig) || /^(\d)\1+$/.test(dig)) erros.push('Informe um WhatsApp válido com DDD.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) erros.push('E-mail inválido.');
    if (erros.length) return json(res, 422, { ok: false, error: erros.join(' ') });

    // Mesma pessoa clicando 2x / reenviando em seguida: não duplica
    const recente = um(`SELECT id FROM inscricoes WHERE telefone_digitos = ? AND created_at >= ?`, [dig, new Date(Date.now() - 10 * 60000).toISOString()]);
    if (recente) return json(res, 200, { ok: true, id: recente.id, repetida: true });

    const conhecidos = ['nome', 'cidade', 'cidade_estado', 'telefone', 'email', 'utm', 'pagina', 't', 'empresa_site', 'website'];
    const campos = {};
    for (const [k, v] of Object.entries(b)) if (!conhecidos.includes(k) && (typeof v === 'string' || typeof v === 'number')) campos[limpar(k, 40)] = limpar(v, 1000);
    const utm = {};
    for (const [k, v] of Object.entries(b.utm && typeof b.utm === 'object' ? b.utm : {})) if (/^(utm_|gclid|fbclid|ref)/.test(k)) utm[limpar(k, 40)] = limpar(v, 300);

    const id = crypto.randomUUID();
    const quando = agora();
    const status = conexao() ? 'pendente' : 'aguardando_conexao';
    exec(`INSERT INTO inscricoes (id, nome, cidade, telefone, telefone_digitos, email, campos, utm, pagina, ip, user_agent, status, crm_status, crm_tentativas, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo', ?, 0, ?, ?)`,
        [id, nome, cidade, telefone, dig, email || null, JSON.stringify(campos), JSON.stringify(utm), limpar(b.pagina || req.headers.referer, 500),
         ip, limpar(req.headers['user-agent'], 300), status, quando, quando]);
    persistir(true); // a inscrição está garantida em disco antes de responder
    console.log(`[form] nova inscrição: ${nome} (${dig})`);
    json(res, 200, { ok: true, id });
    // Envio ao CRM em segundo plano (o visitante não espera)
    setImmediate(async () => {
        const ins = um('SELECT * FROM inscricoes WHERE id = ?', [id]);
        if (ins && conexao() && cfg('envio_ativo', '1') === '1') await enviarAoCrm(ins).catch(() => {});
    });
}

// ── API do admin ───────────────────────────────────────────────────────────────
const ROTULO_CRM = {
    pendente: 'Na fila', tentando: 'Tentando de novo', enviado: 'No CRM', aguardando_conexao: 'Aguardando conexão',
    erro_codigo: 'Código inválido', recusado: 'Recusado pelo CRM', falhou: 'Falhou', desativado: 'Envio desligado',
};
function formatarIns(r) {
    return { ...r, campos: jsonParse(r.campos, {}), utm: jsonParse(r.utm, {}), crm_rotulo: ROTULO_CRM[r.crm_status] || r.crm_status, ip: undefined, user_agent: undefined, telefone_digitos: undefined };
}
function filtrosSql(q) {
    const w = [], p = [];
    const busca = limpar(q.get('q'), 80);
    if (busca) {
        const d = digitos(busca);
        w.push(`(nome LIKE ? OR cidade LIKE ? OR email LIKE ?${d.length >= 4 ? ' OR telefone_digitos LIKE ?' : ''})`);
        p.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); if (d.length >= 4) p.push(`%${d}%`);
    }
    if (q.get('status')) { w.push('status = ?'); p.push(q.get('status')); }
    if (q.get('crm')) {
        if (q.get('crm') === 'problema') w.push(`crm_status IN ('erro_codigo','recusado','falhou','tentando','aguardando_conexao')`);
        else { w.push('crm_status = ?'); p.push(q.get('crm')); }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('de') || '')) { w.push('created_at >= ?'); p.push(new Date(q.get('de') + 'T00:00:00').toISOString()); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('ate') || '')) { w.push('created_at <= ?'); p.push(new Date(q.get('ate') + 'T23:59:59.999').toISOString()); }
    return { where: w.length ? ' WHERE ' + w.join(' AND ') : '', params: p };
}
const STATUS_VALIDOS = ['novo', 'em_contato', 'agendado', 'cliente', 'descartado'];

async function rotaAdmin(req, res, url) {
    const rota = url.pathname;
    const metodo = req.method;

    // ── sessão ──
    if (rota === '/admin/api/sessao') return json(res, 200, { ok: true, logado: sessaoValida(req), precisa_criar_senha: !cfg('senha_hash') });
    if (rota === '/admin/api/criar-senha' && metodo === 'POST') {
        if (cfg('senha_hash')) return json(res, 403, { ok: false, error: 'A senha já foi criada' });
        const b = await lerCorpo(req);
        if (String(b.senha || '').length < 8) return json(res, 422, { ok: false, error: 'Use pelo menos 8 caracteres' });
        definirSenha(b.senha);
        const token = crypto.randomBytes(32).toString('hex');
        exec('INSERT INTO sessoes (token, expira) VALUES (?, ?)', [token, new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString()]);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSessao(req, token, SESSAO_DIAS * 86400) });
    }
    if (rota === '/admin/api/login' && metodo === 'POST') {
        const ip = ipDe(req);
        if (!limite(`login:${ip}`, 10, 15 * 60000)) return json(res, 429, { ok: false, error: 'Muitas tentativas. Aguarde 15 minutos.' });
        const b = await lerCorpo(req);
        if (!senhaConfere(b.senha || '')) { await new Promise(r => setTimeout(r, 600)); return json(res, 401, { ok: false, error: 'Senha incorreta' }); }
        const token = crypto.randomBytes(32).toString('hex');
        exec('DELETE FROM sessoes WHERE expira < ?', [agora()]);
        exec('INSERT INTO sessoes (token, expira) VALUES (?, ?)', [token, new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString()]);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSessao(req, token, SESSAO_DIAS * 86400) });
    }
    if (rota === '/admin/api/logout' && metodo === 'POST') {
        const t = cookies(req).sid; if (t) exec('DELETE FROM sessoes WHERE token = ?', [t]);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSessao(req, '', 0) });
    }

    // Daqui pra baixo, só logado
    if (!sessaoValida(req)) { req.resume(); return json(res, 401, { ok: false, error: 'Sessão expirada. Entre de novo.' }); }

    // Configuração do site, vídeos e imagens
    if (await site.rotas(req, res, url)) return;

    if (rota === '/admin/api/resumo') {
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        const conta = (sql, p = []) => um(sql, p)?.n || 0;
        const dias = [];
        for (let i = 13; i >= 0; i--) {
            const d0 = new Date(hoje); d0.setDate(hoje.getDate() - i);
            const d1 = new Date(d0); d1.setDate(d0.getDate() + 1);
            dias.push({ dia: d0.toISOString(), n: conta('SELECT COUNT(*) n FROM inscricoes WHERE created_at >= ? AND created_at < ?', [d0.toISOString(), d1.toISOString()]) });
        }
        const origens = todos(`SELECT COALESCE(NULLIF(json_extract(utm,'$.utm_source'),''),'(direto)') origem, COUNT(*) n FROM inscricoes GROUP BY origem ORDER BY n DESC LIMIT 6`);
        const s7 = new Date(hoje); s7.setDate(hoje.getDate() - 6);
        const s30 = new Date(hoje); s30.setDate(hoje.getDate() - 29);
        return json(res, 200, {
            ok: true,
            total: conta('SELECT COUNT(*) n FROM inscricoes'),
            hoje: conta('SELECT COUNT(*) n FROM inscricoes WHERE created_at >= ?', [hoje.toISOString()]),
            semana: conta('SELECT COUNT(*) n FROM inscricoes WHERE created_at >= ?', [s7.toISOString()]),
            mes: conta('SELECT COUNT(*) n FROM inscricoes WHERE created_at >= ?', [s30.toISOString()]),
            no_crm: conta(`SELECT COUNT(*) n FROM inscricoes WHERE crm_status='enviado'`),
            problemas: conta(`SELECT COUNT(*) n FROM inscricoes WHERE crm_status IN ('erro_codigo','recusado','falhou','tentando','aguardando_conexao')`),
            clientes: conta(`SELECT COUNT(*) n FROM inscricoes WHERE status='cliente'`),
            dias, origens,
            conectado: !!conexao(), envio_ativo: cfg('envio_ativo', '1') === '1',
            armazenamento: site.infoArmazenamento(),
        });
    }
    if (rota === '/admin/api/inscricoes' && metodo === 'GET') {
        const { where, params } = filtrosSql(url.searchParams);
        const pagina = Math.max(parseInt(url.searchParams.get('pagina')) || 1, 1);
        const porPagina = 30;
        const total = um(`SELECT COUNT(*) n FROM inscricoes${where}`, params)?.n || 0;
        const itens = todos(`SELECT * FROM inscricoes${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, porPagina, (pagina - 1) * porPagina]).map(formatarIns);
        return json(res, 200, { ok: true, itens, total, pagina, paginas: Math.max(Math.ceil(total / porPagina), 1) });
    }
    if (rota === '/admin/api/exportar.csv') {
        const { where, params } = filtrosSql(url.searchParams);
        const linhas = todos(`SELECT * FROM inscricoes${where} ORDER BY created_at DESC`, params);
        const cols = [['created_at', 'Data'], ['nome', 'Nome'], ['telefone', 'WhatsApp'], ['cidade', 'Cidade/Estado'], ['email', 'E-mail'], ['status', 'Status'],
            ['crm_status', 'Envio ao CRM'], ['crm_fluxo_rotulo', 'Fluxo no CRM'], ['crm_escolha', 'Botão escolhido'], ['observacao', 'Observação'], ['utm', 'Origem (UTM)'], ['pagina', 'Página']];
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const out = [cols.map(c => c[1]).join(';'), ...linhas.map(r => cols.map(([k]) => {
            if (k === 'created_at') return esc(new Date(r[k]).toLocaleString('pt-BR'));
            if (k === 'crm_status') return esc(ROTULO_CRM[r[k]] || r[k]);
            if (k === 'utm') return esc(Object.entries(jsonParse(r[k], {})).map(([a, b]) => `${a}=${b}`).join(' '));
            return esc(r[k]);
        }).join(';'))].join('\r\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inscricoes-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
        return res.end('﻿' + out);
    }
    const mItem = rota.match(/^\/admin\/api\/inscricoes\/([0-9a-f-]{36})(\/reenviar|\/envios)?$/);
    if (mItem) {
        const id = mItem[1];
        const ins = um('SELECT * FROM inscricoes WHERE id = ?', [id]);
        if (!ins) return json(res, 404, { ok: false, error: 'Inscrição não encontrada' });
        if (mItem[2] === '/envios') return json(res, 200, { ok: true, envios: todos('SELECT em, ok, detalhe FROM envios WHERE inscricao_id = ? ORDER BY id DESC LIMIT 30', [id]) });
        if (mItem[2] === '/reenviar' && metodo === 'POST') {
            if (!conexao()) return json(res, 400, { ok: false, error: 'Conecte o CRM primeiro (aba Conexão com o CRM).' });
            if (ins.crm_status === 'enviado') return json(res, 400, { ok: false, error: 'Esta inscrição já está no CRM. Para mandar o fluxo de novo, use "Reenviar fluxo" no CRM.' });
            exec(`UPDATE inscricoes SET crm_tentativas=0, crm_status='pendente' WHERE id=?`, [id]);
            const r = await enviarAoCrm(um('SELECT * FROM inscricoes WHERE id = ?', [id]));
            return json(res, r.ok ? 200 : 502, r.ok ? { ok: true, fluxo: r.resposta?.fluxo_status } : { ok: false, error: r.erro });
        }
        if (metodo === 'DELETE') { exec('DELETE FROM inscricoes WHERE id = ?', [id]); exec('DELETE FROM envios WHERE inscricao_id = ?', [id]); return json(res, 200, { ok: true }); }
        if (metodo === 'POST') {
            const b = await lerCorpo(req);
            if (b.status !== undefined) {
                if (!STATUS_VALIDOS.includes(b.status)) return json(res, 422, { ok: false, error: 'Status inválido' });
                exec('UPDATE inscricoes SET status=?, updated_at=? WHERE id=?', [b.status, agora(), id]);
            }
            if (b.observacao !== undefined) exec('UPDATE inscricoes SET observacao=?, updated_at=? WHERE id=?', [limpar(b.observacao, 3000), agora(), id]);
            return json(res, 200, { ok: true });
        }
        return json(res, 200, { ok: true, item: formatarIns(ins) });
    }
    if (rota === '/admin/api/config' && metodo === 'GET') {
        const cx = conexao();
        return json(res, 200, { ok: true, conectado: !!cx, crm_url: cx?.url || null, envio_ativo: cfg('envio_ativo', '1') === '1',
            fonte: cfg('crm_fonte'), conta: cfg('crm_conta'), testado_em: cfg('crm_testado_em'),
            na_fila: um(`SELECT COUNT(*) n FROM inscricoes WHERE crm_status IN ('pendente','tentando','aguardando_conexao')`)?.n || 0,
            com_erro: um(`SELECT COUNT(*) n FROM inscricoes WHERE crm_status IN ('erro_codigo','recusado','falhou')`)?.n || 0 });
    }
    if (rota === '/admin/api/config' && metodo === 'POST') {
        const b = await lerCorpo(req);
        if (b.envio_ativo !== undefined) setCfg('envio_ativo', b.envio_ativo ? '1' : '0');
        if (b.codigo !== undefined) {
            if (!String(b.codigo).trim()) { setCfg('crm_codigo', null); setCfg('crm_fonte', null); setCfg('crm_conta', null); return json(res, 200, { ok: true, desconectado: true }); }
            let cx;
            try { cx = lerCodigo(b.codigo); } catch (e) { return json(res, 422, { ok: false, error: e.message }); }
            const anterior = cfg('crm_codigo');
            setCfg('crm_codigo', String(b.codigo).trim());
            try {
                const p = await chamarCrm('/api/inscricoes/ping');
                setCfg('crm_fonte', p.fonte); setCfg('crm_conta', p.conta); setCfg('crm_testado_em', agora());
                // Código novo: quem estava parado por código inválido volta para a fila
                exec(`UPDATE inscricoes SET crm_status='pendente', crm_tentativas=0 WHERE crm_status IN ('erro_codigo','aguardando_conexao')`);
                setImmediate(() => processarFila().catch(() => {}));
                return json(res, 200, { ok: true, fonte: p.fonte, conta: p.conta, url: cx.url, etapas: p.etapas, ativo_no_crm: p.ativo });
            } catch (e) {
                setCfg('crm_codigo', anterior); // não troca por um código que não funciona
                return json(res, 422, { ok: false, error: e.status === 401 ? 'O CRM recusou este código (foi trocado ou excluído). Gere/copie de novo no CRM.' : e.message });
            }
        }
        return json(res, 200, { ok: true });
    }
    if (rota === '/admin/api/testar-crm' && metodo === 'POST') {
        try {
            const p = await chamarCrm('/api/inscricoes/ping');
            setCfg('crm_fonte', p.fonte); setCfg('crm_conta', p.conta); setCfg('crm_testado_em', agora());
            return json(res, 200, { ok: true, ...p });
        } catch (e) { return json(res, 200, { ok: false, error: e.semConexao ? 'Nenhum código de conexão salvo' : e.message }); }
    }
    if (rota === '/admin/api/reenviar-pendentes' && metodo === 'POST') {
        if (!conexao()) return json(res, 400, { ok: false, error: 'Conecte o CRM primeiro.' });
        const n = um(`SELECT COUNT(*) n FROM inscricoes WHERE crm_status IN ('tentando','falhou','erro_codigo','aguardando_conexao')`)?.n || 0;
        exec(`UPDATE inscricoes SET crm_status='pendente', crm_tentativas=0 WHERE crm_status IN ('tentando','falhou','erro_codigo','aguardando_conexao')`);
        processarFila().catch(() => {});
        return json(res, 200, { ok: true, n });
    }
    if (rota === '/admin/api/sincronizar' && metodo === 'POST') return json(res, 200, await sincronizarStatus(true));
    if (rota === '/admin/api/senha' && metodo === 'POST') {
        const b = await lerCorpo(req);
        if (!senhaConfere(b.atual || '')) return json(res, 401, { ok: false, error: 'Senha atual incorreta' });
        if (String(b.nova || '').length < 8) return json(res, 422, { ok: false, error: 'A nova senha precisa de pelo menos 8 caracteres' });
        definirSenha(b.nova);
        const token = crypto.randomBytes(32).toString('hex');
        exec('INSERT INTO sessoes (token, expira) VALUES (?, ?)', [token, new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString()]);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSessao(req, token, SESSAO_DIAS * 86400) });
    }
    return json(res, 404, { ok: false, error: 'Rota não encontrada' });
}

// ── arquivos ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.txt': 'text/plain' };
function servirArquivo(res, arquivo, cache = 'public, max-age=300') {
    fs.readFile(arquivo, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(arquivo).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
        res.end(data);
    });
}

// ── servidor ───────────────────────────────────────────────────────────────────
const servidor = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    try {
        if (url.pathname === '/health') return json(res, 200, { ok: true });
        if (url.pathname === '/api/inscricao') {
            if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST' });
            res.setHeader('Access-Control-Allow-Origin', '*'); // a página pode estar hospedada em outro domínio
            return await receberInscricao(req, res);
        }
        if (url.pathname.startsWith('/admin/api/')) return await rotaAdmin(req, res, url);
        if (url.pathname === '/admin' || url.pathname === '/admin/') {
            res.setHeader('X-Frame-Options', 'DENY');
            return servirArquivo(res, ADMIN_FILE, 'no-store');
        }
        // Página do site: montada com a configuração salva no Admin
        if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/' + site.nomePagina()) {
            const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
            const base = `${proto}://${String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()}`;
            const html = site.renderizar(base);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
            return res.end(req.method === 'HEAD' ? undefined : html);
        }
        if (url.pathname.startsWith('/midia/')) return site.servirMidia(req, res, decodeURIComponent(url.pathname.slice(7)));
        if (url.pathname === '/template.html') { res.writeHead(302, { Location: '/' }); return res.end(); }

        // Arquivos liberados (logo padrão, favicon...)
        const nomeArq = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (ARQUIVOS_PUBLICOS.has(nomeArq) && fs.existsSync(path.join(__dirname, nomeArq))) {
            return servirArquivo(res, path.join(__dirname, nomeArq), 'public, max-age=86400');
        }
        if (!path.extname(nomeArq)) { res.writeHead(302, { Location: '/' }); return res.end(); }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada');
    } catch (e) {
        console.error('[erro]', e);
        if (!res.headersSent) json(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Erro interno' });
    }
});

// Envio de vídeo pelo celular com internet lenta: cada parte pode levar vários minutos
servidor.requestTimeout = 30 * 60 * 1000;
servidor.headersTimeout = 65 * 1000;
servidor.keepAliveTimeout = 61 * 1000;

iniciarBanco().then(() => {
    servidor.listen(PORT, () => {
        console.log(`🌐 Site + Admin rodando na porta ${PORT}`);
        console.log(`   Site:  http://localhost:${PORT}/`);
        console.log(`   Admin: http://localhost:${PORT}/admin${cfg('senha_hash') ? '' : '  (primeiro acesso: crie a senha)'}`);
        console.log(`   CRM:   ${conexao() ? 'conectado a ' + conexao().url : 'ainda não conectado'}`);
    });
    setInterval(() => processarFila().catch(() => {}), 15000);
    setInterval(() => sincronizarStatus().catch(() => {}), 3 * 60000);
    setTimeout(() => processarFila().catch(() => {}), 3000);
}).catch(e => { console.error('Falha ao iniciar o banco:', e); process.exit(1); });
