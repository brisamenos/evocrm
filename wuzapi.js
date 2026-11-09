// ─────────────────────────────────────────────────────────────────────────────
// wuzapi.js — Adaptador WUZAPI para o EvoCRM
//
// O CRM inteiro foi escrito para a Evolution API. Em vez de reescrever dezenas
// de chamadas espalhadas pelo código, este módulo EMULA os endpoints da
// Evolution que o CRM usa e traduz cada um para a Wuzapi:
//
//   CRM  ──(formato Evolution)──►  /evo/*  ──(este adaptador)──►  Wuzapi
//   Wuzapi ──(webhook Wuzapi)──►  /webhook/:inst ──(normalizeWebhook)──► CRM
//
// Cada "instância" do CRM = 1 usuário da Wuzapi (mesmo nome).
// O token de cada usuário é descoberto pela API admin (WUZAPI_ADMIN_TOKEN)
// ou definido manualmente (WUZAPI_TOKEN para modo de instância única).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const pathMod = require('path');
const { spawn, spawnSync } = require('child_process');

const _fetch = (...a) => (globalThis.fetch
    ? globalThis.fetch(...a)
    : import('node-fetch').then(({ default: f }) => f(...a)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pega um campo independente de maiúsculas/minúsculas (Wuzapi muda entre versões)
function pick(obj, ...names) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const n of names) {
        if (obj[n] !== undefined) return obj[n];
        const k = Object.keys(obj).find(x => x.toLowerCase() === n.toLowerCase());
        if (k !== undefined) return obj[k];
    }
    return undefined;
}

const EXT_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime', webm: 'video/webm',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    aac: 'audio/aac', wav: 'audio/wav', amr: 'audio/amr',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', rar: 'application/vnd.rar',
};

function sniffMime(buf) {
    if (!buf || buf.length < 12) return null;
    const h = buf.slice(0, 12);
    if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'image/jpeg';
    if (h.slice(0, 4).toString('hex') === '89504e47') return 'image/png';
    if (h.slice(0, 3).toString() === 'GIF') return 'image/gif';
    if (h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    if (h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WAVE') return 'audio/wav';
    if (h.slice(0, 4).toString() === '%PDF') return 'application/pdf';
    if (h.slice(0, 4).toString() === 'OggS') return 'audio/ogg';
    if (h.slice(0, 3).toString() === 'ID3' || (h[0] === 0xFF && (h[1] & 0xE0) === 0xE0)) return 'audio/mpeg';
    if (h.slice(4, 8).toString() === 'ftyp') {
        const brand = h.slice(8, 12).toString();
        return /M4A|M4B/.test(brand) ? 'audio/mp4' : 'video/mp4';
    }
    if (h.slice(0, 4).toString('hex') === '1a45dfa3') return 'video/webm';
    if (h.slice(0, 4).toString('hex') === '504b0304') return 'application/zip';
    return null;
}

function extFromMime(mime) {
    const m = (mime || '').split(';')[0].trim();
    const found = Object.entries(EXT_MIME).find(([, v]) => v === m);
    return found ? found[0] : (m.split('/')[1] || 'bin');
}

// Chaves de mensagem que não são conteúdo (vêm junto no objeto Message)
const META_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'deviceSentMessage']);
// Mensagens técnicas que não devem virar mensagem no CRM
const SKIP_KEYS = new Set(['protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage',
    'encReactionMessage', 'pinInChatMessage', 'messageHistoryBundle', 'callLogMesssage']);
const WRAPPER_KEYS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
    'documentWithCaptionMessage', 'editedMessage'];

function createWuzapi(opts = {}) {
    const WUZ = String(opts.url || '').replace(/\/+$/, '');
    const ADMIN = opts.adminToken || '';
    const SINGLE_TOKEN = opts.singleToken || '';
    const SINGLE_INST = opts.singleInstance || '';
    const WEBHOOK_BASE = String(opts.webhookBase || '').replace(/\/+$/, '');
    const UPLOADS_DIR = opts.uploadsDir || '/app/uploads';
    const PUBLIC_URL = String(opts.publicUrl || '').replace(/\/+$/, '');
    const LOCAL_BASE = String(opts.localBase || '').replace(/\/+$/, '');
    const DATA_DIR = opts.dataDir || '/app/data';
    const log = opts.log || ((i, t, m) => console.log(`[Wuzapi:${i}] ${m}`));
    // Só instâncias com licença no CRM são visíveis/controláveis. Protege outros
    // sistemas que usam a mesma Wuzapi (ex: EstimaFood) de aparecer ou ser
    // desconectados/excluídos pelo painel do CRM.
    const allowedNames = opts.allowedInstances || null;   // async () => Set<string> (minúsculas)
    async function isAllowed(name) {
        if (!allowedNames) return true;
        const key = String(name || '').trim().toLowerCase();
        if ((await allowedNames()).has(key)) return true;
        return (await allowedNames(true)).has(key);   // licença recém-criada: recarrega
    }

    const TOKENS_FILE = pathMod.join(DATA_DIR, 'wuzapi_tokens.json');
    const CHATS_FILE = pathMod.join(DATA_DIR, 'wuzapi_chats.json');

    // ── Estado local ────────────────────────────────────────────────────────
    let tokenMap = {};
    try { tokenMap = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) || {}; } catch (e) { tokenMap = {}; }
    const saveTokens = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokenMap, null, 2)); } catch (e) {} };

    let chatStore = {};
    try { chatStore = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) || {}; } catch (e) { chatStore = {}; }
    let chatSaveTimer = null;
    const saveChats = () => {
        clearTimeout(chatSaveTimer);
        chatSaveTimer = setTimeout(() => {
            try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CHATS_FILE, JSON.stringify(chatStore)); } catch (e) {}
        }, 1500);
    };

    const mediaCache = new Map();   // msgId -> { base64, mimetype, at }
    const phoneCache = new Map();   // inst:digits -> { phone, at, ok }
    const webhookChecked = new Set();
    let usersCache = { at: 0, list: [] };

    // Caminho do ffmpeg: o do sistema (Dockerfile) ou o embutido no npm (ffmpeg-static).
    // Sem ffmpeg, áudio gravado no navegador (webm/mp4) não é entregue pelo WhatsApp.
    let FFMPEG = null;
    function ffmpegPath() {
        if (FFMPEG === null) {
            FFMPEG = false;
            const ok = bin => { try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; } };
            if (ok('ffmpeg')) FFMPEG = 'ffmpeg';
            else {
                try { const p = require('ffmpeg-static'); if (p && ok(p)) FFMPEG = p; } catch (e) {}
            }
            if (FFMPEG) log('sistema', 'ok', `[Wuzapi] ffmpeg disponível (${FFMPEG === 'ffmpeg' ? 'sistema' : 'ffmpeg-static'})`);
            else log('sistema', 'erro', '[Wuzapi] ffmpeg NÃO encontrado — áudios gravados não serão entregues no WhatsApp');
        }
        return FFMPEG;
    }
    const hasFfmpeg = () => !!ffmpegPath();

    const isConfigured = () => !!WUZ && !!(ADMIN || SINGLE_TOKEN);
    const hookUrl = inst => `${WEBHOOK_BASE}/webhook/${encodeURIComponent(inst)}`;

    // ── HTTP baixo nível ────────────────────────────────────────────────────
    async function raw(method, path, body, headers = {}, timeoutMs = 30000) {
        if (!WUZ) throw Object.assign(new Error('WUZAPI_URL não configurada'), { status: 500 });
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await _fetch(WUZ + path, {
                method,
                headers: { 'Content-Type': 'application/json', ...headers },
                ...(body !== undefined && body !== null && method !== 'GET' ? { body: JSON.stringify(body) } : {}),
                signal: ctrl.signal,
            });
            const text = await r.text();
            let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
            const data = (json && typeof json === 'object' && 'data' in json) ? json.data : json;
            const success = r.ok && (json?.success !== false);
            const error = success ? null : (json?.error || json?.message || json?.raw || `HTTP ${r.status}`);
            return { status: r.status, ok: success, data, error, json };
        } finally { clearTimeout(t); }
    }

    // ── Usuários (instâncias) ───────────────────────────────────────────────
    async function listUsers(force = false) {
        if (!ADMIN) return [];
        if (!force && Date.now() - usersCache.at < 20000) return usersCache.list;
        const r = await raw('GET', '/admin/users', null, { Authorization: ADMIN });
        if (!r.ok) throw Object.assign(new Error('Wuzapi admin: ' + r.error), { status: r.status });
        let list = r.data;
        if (!Array.isArray(list)) list = Array.isArray(list?.users) ? list.users : (Array.isArray(r.json) ? r.json : []);
        usersCache = { at: Date.now(), list };
        for (const u of list) {
            const name = pick(u, 'name'); const token = pick(u, 'token');
            if (name && token && tokenMap[name] !== token) { tokenMap[name] = token; saveTokens(); }
        }
        return list;
    }

    async function findUser(inst, force = false) {
        const list = await listUsers(force);
        return list.find(u => pick(u, 'name') === inst) || null;
    }

    async function createUser(inst, webhook) {
        if (!ADMIN) throw Object.assign(new Error('WUZAPI_ADMIN_TOKEN não configurado — não é possível criar instâncias'), { status: 500 });
        const token = crypto.randomBytes(16).toString('hex');
        const r = await raw('POST', '/admin/users', {
            name: inst, token, webhook: webhook || hookUrl(inst), events: 'All',
        }, { Authorization: ADMIN });
        if (!r.ok) {
            const u = await findUser(inst, true).catch(() => null);
            if (u) return pick(u, 'token');
            throw Object.assign(new Error('Wuzapi: falha ao criar usuário — ' + r.error), { status: r.status || 500 });
        }
        tokenMap[inst] = token; saveTokens();
        usersCache.at = 0;
        log(inst, 'ok', `[Wuzapi] Instância criada na Wuzapi`);
        return token;
    }

    async function tokenFor(inst, { create = false } = {}) {
        if (SINGLE_TOKEN && (!SINGLE_INST || SINGLE_INST === inst)) return SINGLE_TOKEN;
        if (ADMIN) {
            try {
                let u = await findUser(inst);
                if (!u) u = await findUser(inst, true);
                if (u) return pick(u, 'token');
                // Usuário não existe mais na Wuzapi → descarta token antigo
                if (tokenMap[inst]) { delete tokenMap[inst]; saveTokens(); }
            } catch (e) {
                // API admin fora do ar → usa o token salvo localmente
                if (tokenMap[inst]) return tokenMap[inst];
                throw e;
            }
            if (create) return createUser(inst);
            return null;
        }
        return tokenMap[inst] || null;
    }

    const call = (token, method, path, body, timeoutMs) => raw(method, path, body, { Token: token }, timeoutMs);

    // Versões antigas da Wuzapi usam GET com corpo JSON (ex: /user/avatar). fetch não
    // permite corpo em GET, então usamos o módulo http/https direto.
    function getWithBody(token, path, body, timeoutMs = 15000) {
        return new Promise(resolve => {
            try {
                const u = new URL(WUZ + path);
                const mod = u.protocol === 'https:' ? require('https') : require('http');
                const payload = Buffer.from(JSON.stringify(body || {}));
                const rq = mod.request(u, { method: 'GET', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Token: token }, timeout: timeoutMs }, res => {
                    const out = [];
                    res.on('data', d => out.push(d));
                    res.on('end', () => {
                        let json; try { json = JSON.parse(Buffer.concat(out).toString()); } catch (e) { json = {}; }
                        const data = (json && 'data' in json) ? json.data : json;
                        resolve({ ok: res.statusCode < 400 && json?.success !== false, status: res.statusCode, data, error: json?.error || null });
                    });
                });
                rq.on('error', e => resolve({ ok: false, status: 0, data: null, error: e.message }));
                rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, status: 0, data: null, error: 'timeout' }); });
                rq.end(payload);
            } catch (e) { resolve({ ok: false, status: 0, data: null, error: e.message }); }
        });
    }

    async function sessionStatus(token) {
        const r = await call(token, 'GET', '/session/status', null, 10000);
        if (!r.ok) return { connected: false, loggedIn: false, jid: null, name: null };
        const d = r.data || {};
        return {
            connected: !!pick(d, 'Connected', 'connected'),
            loggedIn: !!pick(d, 'LoggedIn', 'loggedIn', 'logged_in'),
            jid: pick(d, 'jid', 'JID') || null,
            name: pick(d, 'name', 'pushName', 'PushName') || null,
        };
    }

    const stateOf = s => (s.connected && s.loggedIn) ? 'open' : (s.connected ? 'connecting' : 'close');

    async function ensureWebhook(inst, token, force = false, url = null) {
        if (!force && webhookChecked.has(inst)) return;
        try {
            if (!force) {
                const cur = await call(token, 'GET', '/webhook', null, 10000);
                const curUrl = pick(cur.data || {}, 'webhook', 'webhookURL', 'url');
                if (cur.ok && curUrl) { webhookChecked.add(inst); return; }
            }
            const target = url || hookUrl(inst);
            const r = await call(token, 'POST', '/webhook', { webhookURL: target, webhook: target, events: ['All'] }, 10000);
            if (r.ok) { webhookChecked.add(inst); log(inst, 'ok', `[Wuzapi] Webhook → ${target}`); }
            else log(inst, 'warn', `[Wuzapi] Falha ao configurar webhook: ${r.error}`);
        } catch (e) { log(inst, 'warn', `[Wuzapi] Webhook: ${e.message}`); }
    }

    async function ensureSession(inst, token) {
        await ensureWebhook(inst, token);
        const s = await sessionStatus(token);
        if (!s.connected) {
            const r = await call(token, 'POST', '/session/connect', { Subscribe: ['All'], Immediate: true }, 20000);
            if (!r.ok && !/already/i.test(String(r.error))) log(inst, 'warn', `[Wuzapi] session/connect: ${r.error}`);
        }
        return s;
    }

    // ── Telefones ───────────────────────────────────────────────────────────
    // Usa /user/check para descobrir o número real no WhatsApp (resolve o
    // problema do 9º dígito em números brasileiros).
    async function resolvePhone(inst, token, number) {
        let n = String(number || '').trim();
        if (/@(g\.us|lid|newsletter|broadcast)$/.test(n)) return n;
        n = n.replace(/@.*$/, '').replace(/:\d+$/, '').replace(/\D/g, '');
        if (!n) throw Object.assign(new Error('Número inválido'), { status: 400 });
        const key = `${inst}:${n}`;
        const c = phoneCache.get(key);
        if (c && Date.now() - c.at < (c.ok ? 86400000 : 600000)) return c.phone;
        try {
            const r = await call(token, 'POST', '/user/check', { Phone: [n] }, 10000);
            const users = pick(r.data || {}, 'Users') || [];
            const u = users[0];
            if (u && pick(u, 'IsInWhatsapp', 'isInWhatsapp') && pick(u, 'JID', 'jid')) {
                const phone = String(pick(u, 'JID', 'jid')).split('@')[0].split(':')[0];
                phoneCache.set(key, { phone, at: Date.now(), ok: true });
                return phone;
            }
        } catch (e) {}
        phoneCache.set(key, { phone: n, at: Date.now(), ok: false });
        return n;
    }

    const toJid = p => p.includes('@') ? p : `${p}@s.whatsapp.net`;

    // Contatos do celular (nome de perfil) — cache de 5 min por instância
    const contactsCache = new Map();
    async function contactsCached(inst, token) {
        const c = contactsCache.get(inst);
        if (c && Date.now() - c.at < 300000) return c.data;
        try {
            const r = await call(token, 'GET', '/user/contacts', null, 30000);
            if (r.ok && r.data && typeof r.data === 'object') {
                contactsCache.set(inst, { at: Date.now(), data: r.data });   // só guarda quando deu certo
                return r.data;
            }
        } catch (e) {}
        return c ? c.data : {};
    }

    // ── Mídia ───────────────────────────────────────────────────────────────
    function localUploadPath(sub) {
        const clean = decodeURIComponent(sub.split('?')[0]);
        const full = pathMod.resolve(UPLOADS_DIR, clean);
        if (!full.startsWith(pathMod.resolve(UPLOADS_DIR) + pathMod.sep)) return null;
        return full;
    }

    async function loadMedia(src, hintMime) {
        if (!src) throw Object.assign(new Error('Mídia vazia'), { status: 400 });
        const s = String(src).trim();
        let buf = null, mime = null, fileName = null;

        const dm = s.match(/^data:([^;,]+)?((?:;[^;,]+)*),([\s\S]*)$/);
        if (dm) {
            mime = dm[1] || null;
            buf = /;base64/i.test(dm[2]) ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]));
        } else {
            let localPath = null;
            if (s.startsWith('/uploads/')) localPath = localUploadPath(s.slice('/uploads/'.length));
            else if (PUBLIC_URL && s.startsWith(PUBLIC_URL + '/uploads/')) localPath = localUploadPath(s.slice((PUBLIC_URL + '/uploads/').length));

            if (localPath && fs.existsSync(localPath)) {
                buf = fs.readFileSync(localPath);
                fileName = pathMod.basename(localPath);
            } else if (/^https?:\/\//i.test(s) || s.startsWith('/')) {
                const url = s.startsWith('/') ? LOCAL_BASE + s : s;
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 60000);
                try {
                    const r = await _fetch(url, { signal: ctrl.signal });
                    if (!r.ok) throw Object.assign(new Error(`Falha ao baixar mídia (HTTP ${r.status}): ${url}`), { status: 400 });
                    buf = Buffer.from(await r.arrayBuffer());
                    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
                    if (ct && ct !== 'application/octet-stream' && !ct.startsWith('text/html')) mime = ct;
                } finally { clearTimeout(t); }
                try { fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || null; } catch (e) {}
            } else if (s.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(s)) {
                buf = Buffer.from(s, 'base64');
            } else {
                throw Object.assign(new Error('Formato de mídia não reconhecido'), { status: 400 });
            }
        }
        if (!mime && fileName && fileName.includes('.')) mime = EXT_MIME[fileName.split('.').pop().toLowerCase()] || null;
        if (!mime || mime === 'application/octet-stream') mime = sniffMime(buf) || hintMime || 'application/octet-stream';
        return { buf, mime, fileName };
    }

    // Converte qualquer áudio para OGG/Opus (formato de mensagem de voz do WhatsApp)
    function toOggOpus(buf, mime) {
        const isOgg = buf.slice(0, 4).toString() === 'OggS';
        if (isOgg) return Promise.resolve(buf);
        if (!hasFfmpeg()) return Promise.resolve(null);
        return new Promise(resolve => {
            const ff = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
                '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1']);
            const out = [];
            let done = false;
            const finish = b => { if (!done) { done = true; resolve(b); } };
            ff.stdout.on('data', d => out.push(d));
            ff.on('error', () => finish(null));
            ff.on('close', code => finish(code === 0 && out.length ? Buffer.concat(out) : null));
            ff.stdin.on('error', () => {});
            ff.stdin.end(buf);
            setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} finish(null); }, 60000);
        });
    }

    // Converte imagem para WEBP 512x512 (formato de figurinha do WhatsApp)
    function toWebpSticker(buf) {
        if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return Promise.resolve(buf);
        if (!hasFfmpeg()) return Promise.resolve(buf);
        return new Promise(resolve => {
            const ff = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                '-frames:v', '1', '-c:v', 'libwebp', '-f', 'webp', 'pipe:1']);
            const out = [];
            let done = false;
            const finish = b => { if (!done) { done = true; resolve(b); } };
            ff.stdout.on('data', d => out.push(d));
            ff.on('error', () => finish(buf));
            ff.on('close', code => finish(code === 0 && out.length ? Buffer.concat(out) : buf));
            ff.stdin.on('error', () => {});
            ff.stdin.end(buf);
            setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} finish(buf); }, 30000);
        });
    }

    // ── Respostas no formato Evolution ──────────────────────────────────────
    function sentResponse(phone, r) {
        const d = r.data || {};
        const id = pick(d, 'Id', 'ID', 'id') || null;
        const ts = pick(d, 'Timestamp', 'timestamp');
        return {
            key: { remoteJid: toJid(phone), fromMe: true, id },
            message: {},
            messageTimestamp: ts ? Math.floor(new Date(ts).getTime() / 1000) || Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000),
            status: 'PENDING',
        };
    }

    function fail(status, message, extra = {}) {
        return { status, body: { status, error: message, message, response: { message: [message] }, ...extra } };
    }

    async function sendResult(inst, phone, r, kind) {
        if (!r.ok) {
            log(inst, 'erro', `[Wuzapi] Falha ao enviar ${kind} para ${phone}: ${r.error}`);
            return fail(r.status >= 400 ? r.status : 500, String(r.error));
        }
        return { status: 201, body: sentResponse(phone, r) };
    }

    async function doPresence(token, phone, presence, delayMs) {
        const p = String(presence || 'composing').toLowerCase();
        const body = { Phone: phone, State: (p === 'composing' || p === 'recording') ? 'composing' : 'paused' };
        if (p === 'recording') body.Media = 'audio';
        await call(token, 'POST', '/chat/presence', body, 10000).catch(() => {});
        const d = Math.min(Math.max(parseInt(delayMs) || 0, 0), 20000);
        if (d > 0 && body.State === 'composing') {
            await sleep(d);
            await call(token, 'POST', '/chat/presence', { Phone: phone, State: 'paused' }, 10000).catch(() => {});
        }
    }

    async function sendMediaCore(inst, token, phone, { type, src, caption, fileName, mimetype }) {
        const media = await loadMedia(src, mimetype);
        let mime = (mimetype && mimetype !== 'application/octet-stream') ? mimetype : media.mime;
        let t = type;
        if (!t) t = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';

        if (t === 'audio' || t === 'ptt') {
            const ogg = await toOggOpus(media.buf, mime);
            if (!ogg) {
                log(inst, 'erro', `[Wuzapi] Áudio não convertido para OGG/Opus (ffmpeg ausente ou arquivo inválido) — ${mime}`);
                return fail(500, 'Não foi possível converter o áudio para o formato do WhatsApp (ffmpeg indisponível no servidor)');
            }
            const r = await call(token, 'POST', '/chat/send/audio', { Phone: phone, Audio: 'data:audio/ogg;base64,' + ogg.toString('base64'), PTT: true }, 120000);
            return sendResult(inst, phone, r, 'áudio');
        }
        if (t === 'sticker') {
            const webp = await toWebpSticker(media.buf);
            const r = await call(token, 'POST', '/chat/send/sticker', { Phone: phone, Sticker: 'data:image/webp;base64,' + webp.toString('base64') }, 60000);
            return sendResult(inst, phone, r, 'figurinha');
        }
        if (t === 'image') {
            if (!mime.startsWith('image/')) mime = sniffMime(media.buf) || 'image/jpeg';
            const r = await call(token, 'POST', '/chat/send/image', { Phone: phone, Image: `data:${mime};base64,` + media.buf.toString('base64'), Caption: caption || '' }, 120000);
            return sendResult(inst, phone, r, 'imagem');
        }
        if (t === 'video' || t === 'ptv') {
            if (!mime.startsWith('video/')) mime = 'video/mp4';
            const r = await call(token, 'POST', '/chat/send/video', { Phone: phone, Video: `data:${mime};base64,` + media.buf.toString('base64'), Caption: caption || '' }, 180000);
            return sendResult(inst, phone, r, 'vídeo');
        }
        // documento
        let fn = fileName || media.fileName || 'arquivo';
        if (!/\.[a-z0-9]{2,5}$/i.test(fn)) fn += '.' + extFromMime(mime);
        const r = await call(token, 'POST', '/chat/send/document', {
            Phone: phone, Document: 'data:application/octet-stream;base64,' + media.buf.toString('base64'),
            FileName: fn, MimeType: mime, Caption: caption || '',
        }, 180000);
        return sendResult(inst, phone, r, 'documento');
    }

    // Descobre tipo + campos de download de uma mensagem (proto do WhatsApp)
    function mediaInfo(message) {
        const map = [['imageMessage', 'image'], ['stickerMessage', 'image'], ['videoMessage', 'video'], ['ptvMessage', 'video'],
            ['audioMessage', 'audio'], ['documentMessage', 'document']];
        for (const [k, t] of map) {
            const m = message?.[k];
            if (m) return { kind: t, m };
        }
        return null;
    }

    async function downloadMedia(inst, token, key, message) {
        const id = key?.id;
        if (id && mediaCache.has(id)) return mediaCache.get(id);
        const info = mediaInfo(message);
        if (!info) return null;
        const m = info.m;
        const body = {
            Url: pick(m, 'URL', 'url') || '',
            DirectPath: pick(m, 'directPath', 'DirectPath') || '',
            MediaKey: pick(m, 'mediaKey', 'MediaKey'),
            Mimetype: pick(m, 'mimetype', 'Mimetype') || '',
            FileEncSHA256: pick(m, 'fileEncSHA256', 'FileEncSHA256'),
            FileSHA256: pick(m, 'fileSHA256', 'FileSHA256'),
            FileLength: Number(pick(m, 'fileLength', 'FileLength') || 0),
        };
        const r = await call(token, 'POST', `/chat/download${info.kind}`, body, 120000);
        if (!r.ok) { log(inst, 'warn', `[Wuzapi] Download de mídia falhou: ${r.error}`); return null; }
        const dataStr = String(pick(r.data || {}, 'Data', 'data', 'base64') || '');
        const mm = dataStr.match(/^data:([^,]*?);base64,(.*)$/s);   // aceita "audio/ogg; codecs=opus"
        return { base64: mm ? mm[2] : dataStr, mimetype: mm ? mm[1].split(';')[0].trim() : (pick(r.data || {}, 'Mimetype', 'mimetype') || body.Mimetype) };
    }

    // ── Emulação dos endpoints Evolution ───────────────────────────────────
    async function handle(method, pathname, query, body) {
        body = body || {};
        query = query || new URLSearchParams();
        const parts = pathname.replace(/^\/+/, '').split('/').map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } });
        const [group, action, instRaw] = parts;
        const inst = instRaw || query.get('instanceName') || body.instanceName || '';
        const route = `${group}/${action}`;

        if (!isConfigured()) return fail(503, 'Wuzapi não configurada: defina WUZAPI_URL e WUZAPI_ADMIN_TOKEN (ou WUZAPI_TOKEN)');

        // ── INSTÂNCIAS ──
        if (route === 'instance/fetchInstances') {
            let users = [];
            if (ADMIN) users = await listUsers(true);
            else if (SINGLE_TOKEN) users = [{ name: SINGLE_INST || 'default', token: SINGLE_TOKEN }];
            const filter = query.get('instanceName');
            if (filter) users = users.filter(u => pick(u, 'name') === filter);
            if (allowedNames) {
                const set = await allowedNames();
                users = users.filter(u => set.has(String(pick(u, 'name') || '').trim().toLowerCase()));
            }
            const out = await Promise.all(users.map(async u => {
                const name = pick(u, 'name');
                const tk = pick(u, 'token');
                const s = tk ? await sessionStatus(tk).catch(() => ({ connected: false, loggedIn: false })) : { connected: false, loggedIn: false };
                const state = stateOf(s);
                const jid = s.jid || pick(u, 'jid') || null;
                const id = String(pick(u, 'id') || name);
                return {
                    id, name, connectionStatus: state, ownerJid: jid, profileName: s.name, integration: 'WUZAPI',
                    number: jid ? String(jid).split('@')[0].split(':')[0] : null,
                    instance: { instanceName: name, instanceId: id, status: state, state, owner: jid, profileName: s.name },
                };
            }));
            return { status: 200, body: out };
        }

        if (route === 'instance/create') {
            const name = body.instanceName || inst;
            if (!name) return fail(400, 'instanceName obrigatório');
            if (!(await isAllowed(name))) return fail(403, `Não existe licença para "${name}". Cadastre o cliente no painel antes de conectar.`);
            if (SINGLE_TOKEN && !ADMIN) return { status: 201, body: { instance: { instanceName: name, status: 'created', integration: 'WUZAPI' } } };
            const exists = await findUser(name, true);
            if (exists) return fail(403, 'The instance already exists');
            const wh = (typeof body.webhook === 'string' ? body.webhook : body.webhook?.url) || null;
            const token = await createUser(name, wh || hookUrl(name));
            await ensureWebhook(name, token, true, wh || hookUrl(name));
            await call(token, 'POST', '/session/connect', { Subscribe: ['All'], Immediate: true }, 20000).catch(() => {});
            let qr = null;
            await sleep(1500);
            const q = await call(token, 'GET', '/session/qr', null, 10000).catch(() => null);
            if (q?.ok) qr = pick(q.data || {}, 'QRCode', 'qrcode') || null;
            return { status: 201, body: { instance: { instanceName: name, instanceId: name, status: 'created', integration: 'WUZAPI' }, hash: { apikey: '***' }, qrcode: qr ? { base64: qr } : {} } };
        }

        if (!inst) return fail(400, 'Nome da instância obrigatório');
        if (!(await isAllowed(inst))) return fail(404, `The "${inst}" instance does not exist`);

        if (route === 'instance/connectionState') {
            const token = await tokenFor(inst);
            if (!token) return fail(404, `The "${inst}" instance does not exist`);
            const s = await sessionStatus(token);
            return { status: 200, body: { instance: { instanceName: inst, state: stateOf(s) } } };
        }

        if (route === 'instance/connect') {
            const token = await tokenFor(inst, { create: true });
            if (!token) return fail(404, `The "${inst}" instance does not exist`);
            const before = await ensureSession(inst, token);
            if (before.connected && before.loggedIn) return { status: 200, body: { instance: { instanceName: inst, state: 'open' } } };

            // Código de pareamento por número (opcional): /instance/connect/x?number=55...
            const number = query.get('number') || body.number;
            if (number) {
                const pr = await call(token, 'POST', '/session/pairphone', { Phone: String(number).replace(/\D/g, '') }, 20000);
                const code = pick(pr.data || {}, 'LinkingCode', 'linkingCode', 'code');
                if (code) return { status: 200, body: { pairingCode: code, code: null, base64: null, count: 1 } };
            }
            let qr = null;
            for (let i = 0; i < 3 && !qr; i++) {
                const q = await call(token, 'GET', '/session/qr', null, 10000).catch(() => null);
                if (q?.ok) qr = pick(q.data || {}, 'QRCode', 'qrcode') || null;
                if (!qr) {
                    if (q && /logged/i.test(String(q.error))) return { status: 200, body: { instance: { instanceName: inst, state: 'open' } } };
                    await sleep(1000);
                }
            }
            if (qr) return { status: 200, body: { base64: qr, code: qr, pairingCode: null, count: 1 } };
            const s = await sessionStatus(token);
            return { status: 200, body: { instance: { instanceName: inst, state: stateOf(s) } } };
        }

        if (route === 'instance/logout') {
            const token = await tokenFor(inst);
            if (!token) return fail(404, `The "${inst}" instance does not exist`);
            await call(token, 'POST', '/session/logout', {}, 15000).catch(() => {});
            return { status: 200, body: { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } } };
        }

        if (route === 'instance/restart') {
            const token = await tokenFor(inst);
            if (!token) return fail(404, `The "${inst}" instance does not exist`);
            await call(token, 'POST', '/session/disconnect', {}, 15000).catch(() => {});
            await call(token, 'POST', '/session/connect', { Subscribe: ['All'], Immediate: true }, 20000).catch(() => {});
            return { status: 200, body: { instance: { instanceName: inst, state: 'connecting' } } };
        }

        if (route === 'instance/delete') {
            if (!ADMIN) return fail(400, 'WUZAPI_ADMIN_TOKEN necessário para excluir instâncias');
            const u = await findUser(inst, true);
            if (!u) return fail(404, `The "${inst}" instance does not exist`);
            const tk = pick(u, 'token');
            if (tk) await call(tk, 'POST', '/session/logout', {}, 15000).catch(() => {});
            const id = pick(u, 'id');
            let r = await raw('DELETE', `/admin/users/${encodeURIComponent(id)}/full`, null, { Authorization: ADMIN });
            if (!r.ok) r = await raw('DELETE', `/admin/users/${encodeURIComponent(id)}`, null, { Authorization: ADMIN });
            delete tokenMap[inst]; saveTokens(); usersCache.at = 0; webhookChecked.delete(inst);
            if (!r.ok) return fail(r.status || 500, 'Wuzapi: ' + r.error);
            return { status: 200, body: { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } } };
        }

        // ── WEBHOOK ──
        if (route === 'webhook/set') {
            const token = await tokenFor(inst);
            if (!token) return fail(404, `The "${inst}" instance does not exist`);
            const url = body.url || body.webhook?.url || (typeof body.webhook === 'string' ? body.webhook : '') || hookUrl(inst);
            await ensureWebhook(inst, token, true, url);
            return { status: 201, body: { id: inst, url, enabled: true, events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'], webhookByEvents: false, webhookBase64: false } };
        }
        if (route === 'webhook/find') {
            const token = await tokenFor(inst);
            if (!token) return fail(404, `The "${inst}" instance does not exist`);
            const r = await call(token, 'GET', '/webhook', null, 10000);
            const url = pick(r.data || {}, 'webhook', 'webhookURL', 'url') || '';
            return { status: 200, body: { url, enabled: !!url, events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'] } };
        }

        // Daqui pra baixo precisa de token válido
        const token = await tokenFor(inst);
        if (!token) return fail(404, `The "${inst}" instance does not exist`);

        // ── MENSAGENS ──
        if (group === 'message') {
            const number = body.number || body.remoteJid || '';
            if (!number && action !== 'sendPresence') return fail(400, 'number obrigatório');
            const phone = await resolvePhone(inst, token, number);
            const dly = body.delay ?? body.options?.delay;

            if (action === 'sendText') {
                const text = body.text ?? body.textMessage?.text ?? '';
                if (!String(text).trim()) return fail(400, 'text obrigatório');
                if (dly) await doPresence(token, phone, 'composing', dly);
                const payload = { Phone: phone, Body: String(text) };
                const qid = body.quoted?.key?.id;
                if (qid) payload.ContextInfo = { StanzaId: qid, Participant: body.quoted?.key?.participant || body.quoted?.key?.remoteJid || toJid(phone) };
                const r = await call(token, 'POST', '/chat/send/text', payload, 30000);
                return sendResult(inst, phone, r, 'texto');
            }
            if (action === 'sendMedia') {
                const mm = body.mediaMessage || {};
                const mediatype = body.mediatype || mm.mediatype;
                const type = body.isSticker ? 'sticker' : mediatype;
                if (dly) await doPresence(token, phone, type === 'audio' ? 'recording' : 'composing', dly);
                return sendMediaCore(inst, token, phone, {
                    type, src: body.media || mm.media, caption: body.caption ?? mm.caption,
                    fileName: body.fileName || mm.fileName, mimetype: body.mimetype || mm.mimetype,
                });
            }
            if (action === 'sendWhatsAppAudio') {
                if (dly) await doPresence(token, phone, 'recording', dly);
                return sendMediaCore(inst, token, phone, { type: 'audio', src: body.audio || body.audioMessage?.audio });
            }
            if (action === 'sendPtv') return sendMediaCore(inst, token, phone, { type: 'video', src: body.video || body.media });
            if (action === 'sendSticker') return sendMediaCore(inst, token, phone, { type: 'sticker', src: body.sticker || body.media });
            if (action === 'sendPresence') {
                await doPresence(token, phone, body.presence || body.options?.presence, dly);
                return { status: 201, body: { presence: body.presence || 'composing' } };
            }
            if (action === 'sendReaction') {
                const k = body.key || body.reactionMessage?.key || {};
                const r = await call(token, 'POST', '/chat/react', { Phone: phone, Body: body.reaction || body.reactionMessage?.reaction || '', Id: (k.fromMe ? 'me:' : '') + (k.id || '') }, 15000);
                return sendResult(inst, phone, r, 'reação');
            }
            return fail(404, `Endpoint message/${action} não suportado pelo adaptador Wuzapi`);
        }

        // ── CHAT ──
        if (group === 'chat') {
            if (action === 'updatePresence' || action === 'sendPresence') {
                const phone = await resolvePhone(inst, token, body.number || body.remoteJid);
                await doPresence(token, phone, body.presence || body.options?.presence, body.delay ?? body.options?.delay);
                return { status: 201, body: { presence: body.presence || 'composing' } };
            }
            if (action === 'whatsappNumbers') {
                const nums = (Array.isArray(body.numbers) ? body.numbers : []).map(n => String(n).replace(/@.*$/, '').replace(/\D/g, '')).filter(Boolean);
                if (!nums.length) return { status: 200, body: [] };
                const contatos = await contactsCached(inst, token);
                const out = [];
                for (let i = 0; i < nums.length; i += 50) {
                    const chunk = nums.slice(i, i + 50);
                    const r = await call(token, 'POST', '/user/check', { Phone: chunk }, 30000);
                    const users = r.ok ? (pick(r.data || {}, 'Users') || []) : [];
                    for (const n of chunk) {
                        const u = users.find(x => String(pick(x, 'Query', 'query') || '').replace(/\D/g, '') === n);
                        const exists = !!(u && pick(u, 'IsInWhatsapp', 'isInWhatsapp'));
                        const jid = exists ? String(pick(u, 'JID', 'jid')) : `${n}@s.whatsapp.net`;
                        if (exists) phoneCache.set(`${inst}:${n}`, { phone: jid.split('@')[0].split(':')[0], at: Date.now(), ok: true });
                        const c = contatos[jid] || contatos[`${n}@s.whatsapp.net`] || null;
                        const pushName = (c && (pick(c, 'PushName') || pick(c, 'BusinessName'))) || (u && pick(u, 'VerifiedName', 'verifiedName')) || undefined;
                        out.push({ exists, jid, number: n, pushName, name: (c && pick(c, 'FullName')) || pushName });
                    }
                }
                return { status: 200, body: out };
            }
            if (action === 'fetchProfilePictureUrl') {
                const number = body.number || query.get('number');
                if (!number) return fail(400, 'number obrigatório');
                const phone = await resolvePhone(inst, token, number);
                let r = await call(token, 'POST', '/user/avatar', { Phone: phone, Preview: false }, 15000);
                if (!r.ok && (r.status === 404 || r.status === 405)) r = await getWithBody(token, '/user/avatar', { Phone: phone, Preview: false });
                const url = r.ok ? (pick(r.data || {}, 'URL', 'url') || null) : null;
                if (!r.ok && !/no profile|not.*found|401|privacy/i.test(String(r.error))) log(inst, 'warn', `[Wuzapi] Foto de perfil ${phone}: ${r.error}`);
                return { status: 200, body: { wuid: toJid(phone), profilePictureUrl: url } };
            }
            if (action === 'findContacts') {
                const r = await call(token, 'GET', '/user/contacts', null, 30000);
                const d = (r.ok && r.data && typeof r.data === 'object') ? r.data : {};
                const out = Object.entries(d).map(([jid, c]) => ({
                    id: jid, remoteJid: jid,
                    pushName: pick(c, 'PushName') || pick(c, 'FullName') || pick(c, 'FirstName') || pick(c, 'BusinessName') || null,
                    name: pick(c, 'FullName') || null, profilePicUrl: null,
                }));
                return { status: 200, body: out };
            }
            if (action === 'findChats') {
                const chats = Object.values(chatStore[inst] || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                return { status: 200, body: chats };
            }
            if (action === 'findMessages') {
                return { status: 200, body: { messages: { total: 0, pages: 0, currentPage: 1, records: [] } } };
            }
            if (action === 'getBase64FromMediaMessage') {
                const msg = body.message || {};
                const res = await downloadMedia(inst, token, msg.key, msg.message);
                if (!res) return fail(400, 'Mídia não encontrada nesta mensagem');
                return { status: 201, body: { base64: res.base64, mimetype: res.mimetype, mediaType: mediaInfo(msg.message)?.kind || null } };
            }
            if (action === 'markMessageAsRead' || action === 'readMessages') {
                const list = body.readMessages || body.read_messages || [];
                const byChat = {};
                for (const m of list) { if (m?.id && m?.remoteJid && !m.fromMe) (byChat[m.remoteJid] = byChat[m.remoteJid] || []).push(m.id); }
                for (const [jid, ids] of Object.entries(byChat)) {
                    await call(token, 'POST', '/chat/markread', { Id: ids, Chat: jid, Sender: jid, ChatPhone: jid.split('@')[0], SenderPhone: jid.split('@')[0] }, 15000).catch(() => {});
                }
                return { status: 201, body: { message: 'Read messages', read: 'success' } };
            }
        }

        return fail(404, `Endpoint ${route} não suportado pelo adaptador Wuzapi`);
    }

    // ── Webhook: Wuzapi → formato Evolution ────────────────────────────────
    function parseWebhookBody(rawBody, contentType) {
        const ct = String(contentType || '').toLowerCase();
        let obj = null;
        if (ct.includes('application/x-www-form-urlencoded')) {
            const p = new URLSearchParams(rawBody);
            const jd = p.get('jsonData');
            obj = jd ? JSON.parse(jd) : Object.fromEntries(p);
            if (p.get('token') && obj && typeof obj === 'object') obj.__token = p.get('token');
        } else if (ct.includes('multipart/form-data')) {
            const m = rawBody.match(/name="jsonData"\r?\n(?:[^\r\n]*\r?\n)*?\r?\n([\s\S]*?)\r?\n--/);
            obj = m ? JSON.parse(m[1]) : null;
            const tk = rawBody.match(/name="token"\r?\n\r?\n([^\r\n]*)/);
            if (obj && tk) obj.__token = tk[1];
        } else {
            obj = JSON.parse(rawBody);
            if (obj && typeof obj.jsonData === 'string') {
                const tk = obj.token;
                obj = JSON.parse(obj.jsonData);
                if (tk) obj.__token = tk;
            } else if (obj && typeof obj.jsonData === 'object' && obj.jsonData) {
                const tk = obj.token;
                obj = obj.jsonData;
                if (tk) obj.__token = tk;
            }
        }
        return obj;
    }

    // Wuzapi: { type: "Message", event: {...} } | Evolution: { event: "messages.upsert", data: {...} }
    function isWuzapiPayload(obj) {
        return !!obj && typeof obj === 'object' && typeof obj.type === 'string' && typeof obj.event !== 'string';
    }

    function tokenMatches(inst, obj) {
        const tk = obj.__token || obj.token;
        if (!tk) return true;
        if (SINGLE_TOKEN && (!SINGLE_INST || SINGLE_INST === inst)) return tk === SINGLE_TOKEN;
        if (tokenMap[inst]) return tk === tokenMap[inst];
        return true;
    }

    // ── LID (@lid): ID que o WhatsApp usa para esconder o número ──────────────
    // Muitos contatos (principalmente de anúncios) chegam como "123456789012345@lid".
    // Quando o WhatsApp manda o número junto (campos *Alt), guardamos o par
    // LID → número para reconhecer o contato nas próximas mensagens.
    const LID_FILE = pathMod.join(DATA_DIR, 'wuzapi_lids.json');
    let lidMap = {};
    try { lidMap = JSON.parse(fs.readFileSync(LID_FILE, 'utf8')) || {}; } catch (e) { lidMap = {}; }
    let lidSaveTimer = null;
    const semDevice = j => String(j || '').replace(/:\d+@/, '@');
    function aprenderLid(lid, pn) {
        lid = semDevice(lid); pn = semDevice(pn);
        if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net') || lidMap[lid] === pn) return;
        lidMap[lid] = pn;
        clearTimeout(lidSaveTimer);
        lidSaveTimer = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LID_FILE, JSON.stringify(lidMap)); } catch (e) {} }, 1500);
    }

    // Devolve { jid, lid } — jid é o número real quando der para descobrir
    function pickJid(info, fromMe) {
        const chat = semDevice(pick(info, 'Chat'));
        if (chat.endsWith('@g.us') || chat.endsWith('@s.whatsapp.net')) {
            // Aproveita para aprender o LID do contato, se vier junto
            const altLid = [pick(info, 'ChatAlt'), fromMe ? pick(info, 'RecipientAlt') : pick(info, 'SenderAlt')].map(semDevice).find(x => x.endsWith('@lid'));
            if (altLid && chat.endsWith('@s.whatsapp.net')) aprenderLid(altLid, chat);
            return { jid: chat, lid: null };
        }
        if (!chat.endsWith('@lid')) return { jid: chat, lid: null };
        // Mensagem minha → o contato é o destinatário; recebida → o contato é o remetente
        const cands = fromMe
            ? [pick(info, 'RecipientAlt'), pick(info, 'ChatAlt')]
            : [pick(info, 'SenderAlt'), pick(info, 'ChatAlt'), pick(info, 'Sender')];
        for (const c of cands) {
            const s = semDevice(c);
            if (s.endsWith('@s.whatsapp.net')) { aprenderLid(chat, s); return { jid: s, lid: chat }; }
        }
        if (lidMap[chat]) return { jid: lidMap[chat], lid: chat };
        return { jid: chat, lid: chat };   // número oculto pelo WhatsApp — responde pelo próprio LID
    }

    function cleanMessage(msg) {
        let m = msg || {};
        for (let i = 0; i < 4; i++) {
            const w = WRAPPER_KEYS.find(k => m[k]?.message);
            if (!w) break;
            m = m[w].message;
        }
        const keys = Object.keys(m).filter(k => !META_KEYS.has(k) && m[k] !== null && m[k] !== undefined);
        if (!keys.length) return null;
        if (keys.every(k => SKIP_KEYS.has(k))) return null;
        const primary = keys.find(k => !SKIP_KEYS.has(k));
        const out = { [primary]: m[primary] };
        for (const k of keys) if (k !== primary) out[k] = m[k];
        return { message: out, type: primary };
    }

    function rememberChat(inst, jid, ts, name) {
        if (!jid || !jid.endsWith('@s.whatsapp.net')) return;
        const store = chatStore[inst] = chatStore[inst] || {};
        const prev = store[jid];
        store[jid] = { id: jid, remoteJid: jid, name: name || prev?.name || null, updatedAt: Math.max(ts || 0, prev?.updatedAt || 0) };
        const keys = Object.keys(store);
        if (keys.length > 5000) {
            keys.sort((a, b) => (store[a].updatedAt || 0) - (store[b].updatedAt || 0)).slice(0, keys.length - 5000).forEach(k => delete store[k]);
        }
        saveChats();
    }

    function normalizeWebhook(inst, obj) {
        if (!tokenMatches(inst, obj)) { log(inst, 'warn', '[Wuzapi] Webhook com token inválido — ignorado'); return null; }
        const type = obj.type;
        const ev = obj.event || {};

        if (type === 'Message') {
            const info = pick(ev, 'Info') || {};
            const fromMeInfo = !!pick(info, 'IsFromMe');
            const { jid, lid } = pickJid(info, fromMeInfo);
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null;
            const cleaned = cleanMessage(pick(ev, 'Message') || {});
            if (!cleaned) return null;
            const id = pick(info, 'ID', 'Id') || null;
            const tsRaw = pick(info, 'Timestamp');
            const ts = tsRaw ? Math.floor(new Date(tsRaw).getTime() / 1000) || Math.floor(Date.now() / 1000) : Math.floor(Date.now() / 1000);
            const b64 = obj.base64 || obj.Base64;
            if (id && b64) {
                const mm = String(b64).match(/^data:([^,]*?);base64,(.*)$/s);
                mediaCache.set(id, { base64: mm ? mm[2] : String(b64), mimetype: obj.mimeType || obj.mimetype || (mm ? mm[1].split(';')[0].trim() : null), at: Date.now() });
                if (mediaCache.size > 200) mediaCache.delete(mediaCache.keys().next().value);
            }
            const fromMe = !!pick(info, 'IsFromMe');
            const isGroup = jid.endsWith('@g.us');
            return {
                event: 'messages.upsert', instance: inst, source: 'wuzapi',
                data: {
                    key: { remoteJid: jid, fromMe, id, ...(isGroup ? { participant: pick(info, 'Sender') || undefined } : {}), ...(lid ? { lid } : {}) },
                    pushName: fromMe ? '' : (pick(info, 'PushName') || null),
                    message: cleaned.message, messageType: cleaned.type, messageTimestamp: ts,
                },
            };
        }

        if (type === 'ReadReceipt' || type === 'Receipt') {
            const ids = pick(ev, 'MessageIDs', 'MessageIds') || [];
            const rt = String(pick(ev, 'Type') ?? obj.state ?? '').toLowerCase();
            if (rt === 'read-self' || rt === 'sender' || rt === 'retry') return null;
            const status = (rt === 'read' || rt === 'played') ? 'READ' : (rt === '' || rt === 'delivered') ? 'DELIVERY_ACK' : null;
            if (!status || !ids.length) return null;
            const chat = String(pick(ev, 'Chat') || '');
            return { event: 'messages.update', instance: inst, source: 'wuzapi', data: ids.map(id => ({ key: { id, remoteJid: chat }, update: { status } })) };
        }

        if (['Connected', 'PairSuccess'].includes(type)) {
            return { event: 'connection.update', instance: inst, source: 'wuzapi', data: { instance: inst, state: 'open', statusReason: 200 } };
        }
        if (['LoggedOut', 'Disconnected', 'StreamReplaced', 'TemporaryBan', 'ConnectFailure', 'ClientOutdated', 'StreamError'].includes(type)) {
            return { event: 'connection.update', instance: inst, source: 'wuzapi', data: { instance: inst, state: 'close', reason: type } };
        }
        if (type === 'QR') {
            return { event: 'connection.update', instance: inst, source: 'wuzapi', data: { instance: inst, state: 'connecting' } };
        }

        if (type === 'HistorySync') {
            try {
                const data = pick(ev, 'Data', 'data') || ev;
                const convs = pick(data, 'conversations', 'Conversations') || [];
                for (const c of convs) {
                    const jid = String(pick(c, 'ID', 'id') || '');
                    const ts = Number(pick(c, 'conversationTimestamp', 'lastMsgTimestamp') || 0);
                    rememberChat(inst, jid, ts, pick(c, 'name', 'displayName') || null);
                }
                if (convs.length) log(inst, 'info', `[Wuzapi] Histórico: ${convs.length} conversas recebidas`);
            } catch (e) {}
            return null;
        }
        return null;
    }

    // ── Envio direto por QUALQUER usuário da Wuzapi (ex: o do EstimaFood) ──
    // Usado só para mandar texto (cobranças). Não passa pela lista de licenças,
    // não altera webhook nem sessão — o usuário continua exatamente como está.
    async function tokenQualquer(nome) {
        if (SINGLE_TOKEN && (!SINGLE_INST || SINGLE_INST === nome)) return SINGLE_TOKEN;
        const u = await findUser(nome, true).catch(() => null);
        return u ? pick(u, 'token') : null;
    }
    async function enviarTextoDireto(nome, numero, texto) {
        const token = await tokenQualquer(nome);
        if (!token) throw new Error(`Usuário "${nome}" não encontrado na Wuzapi`);
        const s = await sessionStatus(token);
        if (!s.loggedIn) throw new Error(`O WhatsApp "${nome}" não está conectado na Wuzapi`);
        const phone = await resolvePhone(nome, token, numero);
        const r = await call(token, 'POST', '/chat/send/text', { Phone: phone, Body: String(texto) }, 30000);
        if (!r.ok) throw new Error(String(r.error || 'Falha ao enviar'));
        return true;
    }
    async function listarUsuarios() {
        const users = ADMIN ? await listUsers(true) : (SINGLE_TOKEN ? [{ name: SINGLE_INST || 'default', token: SINGLE_TOKEN }] : []);
        return Promise.all(users.map(async u => {
            const tk = pick(u, 'token');
            const s = tk ? await sessionStatus(tk).catch(() => ({})) : {};
            let webhook = pick(u, 'webhook') || '';
            if (tk) {
                const w = await call(tk, 'GET', '/webhook', null, 8000).catch(() => null);
                if (w?.ok) webhook = pick(w.data || {}, 'webhook', 'webhookURL', 'url') || '';   // valor atual vale mais que o da lista
            }
            const ev = pick(u, 'events');
            return { nome: pick(u, 'name'), conectado: !!(s.connected && s.loggedIn), webhook: String(webhook || ''), eventos: Array.isArray(ev) ? ev.join(',') : String(ev || '') };
        }));
    }
    // Tira o webhook do CRM de um usuário que não é do CRM (devolve o controle ao outro sistema)
    async function limparWebhook(nome) {
        const token = await tokenQualquer(nome);
        if (!token) throw new Error(`Usuário "${nome}" não encontrado`);
        let r = await call(token, 'DELETE', '/webhook', null, 10000).catch(() => null);
        if (!r?.ok) r = await call(token, 'POST', '/webhook', { webhookURL: '', webhook: '' }, 10000);
        if (!r?.ok) throw new Error(String(r?.error || 'Falha ao limpar webhook'));
        webhookChecked.delete(nome);
        return true;
    }

    return { handle, parseWebhookBody, isWuzapiPayload, normalizeWebhook, isConfigured, hasFfmpeg, ffmpegPath, enviarTextoDireto, listarUsuarios, limparWebhook };
}

module.exports = { createWuzapi };
