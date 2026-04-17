// ═══════════════════════════════════════════════════════
// WA-CHAT.JS — Chat WhatsApp (Evolution API 2.7)
// Realtime SSE · Mídia sob demanda · Cache de sessão
// ═══════════════════════════════════════════════════════
'use strict';

/* ─── Estado global ─────────────────────────────────── */
const WA = {
  open:         false,
  chats:        [],          // lista de conversas
  activeJid:    null,        // JID da conversa aberta
  activeName:   '',
  messages:     [],          // msgs da conversa ativa
  mediaCache:   {},          // msgId → {base64,mimetype,fileName}
  nameCache:    {},          // jid → nome (do pushName das msgs)
  msgCache:     {},          // jid → { msgId → msg } — persiste msgs SSE entre aberturas
  pendingFile:  null,
  mediaRecorder:null,
  audioChunks:  [],
  recTimer:     null,
  recSeconds:   0,
  pollTimer:    null,
  sseConn:      null,
  lastMsgTs:    0,
  deptJids:     null,        // Set de JIDs permitidos para supervisor/atendente (null = sem filtro)
  atendentesMap:{},          // jid → {atendente_id, atendente_nome}
};

/* ─── Helpers ────────────────────────────────────────── */

// Número limpo (sem @domínio e não-dígitos)
function waNum(jid) {
  return (jid || '').replace(/@.*/,'').replace(/\D/g,'');
}

// Verifica se é JID real (não LID interno do WhatsApp)
// LIDs são IDs curtos sem código de país ou terminados em @lid
function waIsRealJid(jid) {
  if (!jid) return false;
  if (jid.endsWith('@lid')) return false;          // LID interno
  if (jid.includes('@g.us')) return false;         // grupo
  if (jid.startsWith('status@')) return false;     // status
  if (jid.includes('@broadcast')) return false;    // broadcast
  const n = waNum(jid);
  if (n.length < 10) return false;                 // número inválido
  return true;
}

// Número para envio — garante código de país
function waSendNum(jid) {
  let n = waNum(jid);
  // Se for número BR sem código: adiciona 55
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return n;
}

// Formata número BR para exibição
function waFmtPhone(jid) {
  const n = waNum(jid);
  if (!n) return jid || '';
  if (n.startsWith('55') && n.length >= 12) {
    const ddd = n.slice(2,4), r = n.slice(4);
    if (r.length === 9) return `+55 (${ddd}) ${r.slice(0,5)}-${r.slice(5)}`;
    if (r.length === 8) return `+55 (${ddd}) ${r.slice(0,4)}-${r.slice(4)}`;
  }
  return '+' + n;
}

// Nome do contato — prioriza nameCache (preenchido via pushName das msgs)
function waGetName(jid, fallbackName) {
  return WA.nameCache[jid] || fallbackName || waFmtPhone(jid);
}

// Iniciais para avatar
function waInitials(name) {
  if (!name) return '?';
  const stripped = name.replace(/[\s()+\-]/g,'');
  if (/^\d{6,}$/.test(stripped)) return stripped.slice(-2); // telefone
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length >= 2) return (p[0][0] + p[p.length-1][0]).toUpperCase();
  return (p[0]?.[0] || '?').toUpperCase();
}

// Formata timestamp → hora ou data
function waFmtTime(ts) {
  if (!ts) return '';
  const ms = +ts > 9999999999 ? +ts : +ts * 1000;
  const d = new Date(ms);
  if (isNaN(d)) return '';
  const now = new Date(), diff = now - d;
  if (d.getDate() === now.getDate() && diff < 86400000)
    return d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
  if (diff < 604800000)
    return d.toLocaleDateString('pt-BR', {weekday:'short'});
  return d.toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit'});
}

function waFmtDate(ts) {
  if (!ts) return '';
  const ms = +ts > 9999999999 ? +ts : +ts * 1000;
  const d = new Date(ms);
  if (isNaN(d)) return '';
  const now = new Date(), diff = now - d;
  if (d.getDate() === now.getDate() && diff < 86400000) return 'Hoje';
  if (diff < 172800000) return 'Ontem';
  return d.toLocaleDateString('pt-BR', {day:'2-digit',month:'long',year:'numeric'});
}

function waFmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

// Extrai preview de texto da última mensagem
function waGetPreview(lm) {
  if (!lm) return '';
  const m = lm.message || {};
  if (lm.conversation)               return lm.conversation;
  if (m.conversation)                return m.conversation;
  if (m.extendedTextMessage?.text)   return m.extendedTextMessage.text;
  if (m.imageMessage)                return '📷 Imagem' + (m.imageMessage.caption ? ': '+m.imageMessage.caption : '');
  if (m.videoMessage)                return '🎥 Vídeo' + (m.videoMessage.caption ? ': '+m.videoMessage.caption : '');
  if (m.audioMessage || m.pttMessage)return '🎵 Áudio';
  if (m.documentMessage)             return '📎 ' + (m.documentMessage.fileName || 'Documento');
  if (m.stickerMessage)              return '🎭 Figurinha';
  if (m.locationMessage)             return '📍 Localização';
  if (Object.keys(m).length)        return '📎 Mídia';
  return '';
}

// Escape HTML
function waEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function waSbToast(t,m) { if (typeof sbToast==='function') sbToast(t,m); }

/* ─── Filtro de departamento (supervisor/atendente) ──── */
async function waLoadDeptFilter() {
  try {
    const sess = JSON.parse(sessionStorage.getItem('sys_session') || '{}');
    const role = sess.role || '';
    const tid  = sess.tenant_id || '';

    if (role === 'atendente' && sess.id) {
      // atendente: só as conversas atribuídas a ele
      const r = await fetch(`/api/wa/conv-por-dept?atendente_id=${sess.id}`, {
        headers: { 'x-tenant-id': tid }
      });
      const jids = r.ok ? await r.json().catch(() => []) : [];
      WA.deptJids = new Set(Array.isArray(jids) ? jids : []);
    } else if (role === 'supervisor' && sess.dept_id) {
      // supervisor: todas as convs do dept
      const r = await fetch(`/api/wa/conv-por-dept?dept_id=${sess.dept_id}`, {
        headers: { 'x-tenant-id': tid }
      });
      const jids = r.ok ? await r.json().catch(() => []) : [];
      WA.deptJids = new Set(Array.isArray(jids) ? jids : []);
    } else {
      WA.deptJids = null; // gestor/admin: vê tudo
    }

    // Carrega mapa jid→atendente para exibir badges (gestor e supervisor)
    if (role !== 'atendente') {
      const deptId = sess.dept_id ? `?dept_id=${sess.dept_id}` : '';
      const r2 = await fetch(`/api/wa/conv-atendentes${deptId}`, {
        headers: { 'x-tenant-id': tid }
      });
      WA.atendentesMap = r2.ok ? await r2.json().catch(() => ({})) : {};
    }
  } catch(e) {
    WA.deptJids = new Set();
    console.warn('[WA] deptFilter:', e.message);
  }
}

/* ─── Abrir / Fechar painel ─────────────────────────── */
function waOpenPanel() {
  const el = document.getElementById('wa-panel');
  if (!el) return;
  el.style.display = 'flex';
  WA.open = true;
  if (typeof closeNotif === 'function') closeNotif();

  // Se já tem chats carregados, só re-renderiza (não descarta estado)
  if (WA.chats.length > 0) {
    waRenderList();
    // Restaura conversa ativa se houver
    if (WA.activeJid) {
      document.getElementById('wa-conv-empty').style.display  = 'none';
      document.getElementById('wa-conv-active').style.display = 'flex';
      // Recarrega msgs mesclando com cache (pega novas sem perder as do SSE)
      waLoadMessages(false);
    }
  } else {
    waCheckConn().then(() => waLoadDeptFilter().then(() => waLoadChats()));
  }

  if (!WA.pollTimer) {
    WA.pollTimer = setInterval(() => {
      if (WA.open && WA.activeJid) waLoadMessages(true);
    }, 12000);
  }
}

function waClosePanel() {
  const el = document.getElementById('wa-panel');
  if (el) el.style.display = 'none';
  WA.open = false;
  if (WA.pollTimer) { clearInterval(WA.pollTimer); WA.pollTimer = null; }
}

function waBackToList() {
  document.getElementById('wa-list-col')?.classList.remove('hidden');
}

/* ─── Verificar conexão ─────────────────────────────── */
async function waCheckConn() {
  const inst = EVO.instance;
  const el   = document.getElementById('wa-conn-status');
  if (!inst) { if(el) el.textContent='⚠️ Configure instância no Robô'; return false; }
  try {
    const r = await EVO.req('GET', `/instance/connectionState/${inst}`);
    const state = r.data?.instance?.state || r.data?.state || '';
    const ok = state === 'open';
    if (el) el.textContent = ok ? '🟢 Conectado' : `🔴 ${state||'Desconectado'}`;
    return ok;
  } catch { if(el) el.textContent='⚠️ Erro'; return false; }
}

/* ─── SSE — tempo real ──────────────────────────────── */
function waConnectSSE() {
  if (WA.sseConn) return;
  try {
    const tid = (typeof _sessao!=='undefined') ? _sessao?.tenant_id : null;
    if (!tid) return;
    const sse = new EventSource(`/sse/wa-msgs:${tid}`);
    WA.sseConn = sse;
    sse.addEventListener('wa:msg', e => {
      try { waOnSseMsg(JSON.parse(e.data)); } catch {}
    });
    // Atualiza badge de atendente em tempo real quando atribuição muda
    sse.addEventListener('wa:atribuicao', e => {
      try {
        const d = JSON.parse(e.data);
        if (d.jid) {
          if (d.atendente_id && d.atendente_nome) {
            WA.atendentesMap[d.jid] = { atendente_id: d.atendente_id, atendente_nome: d.atendente_nome };
          } else {
            delete WA.atendentesMap[d.jid];
          }
          waRenderList();
          // Se a conversa aberta foi atribuída, atualiza o header
          if (WA.activeJid === d.jid) waAtualizarHeaderAtendente(d.jid);
        }
      } catch {}
    });
    sse.onerror = () => {
      sse.close(); WA.sseConn = null;
      setTimeout(waConnectSSE, 5000);
    };
  } catch(e) { console.warn('[WA]SSE:', e.message); }
}

function waOnSseMsg(msg) {
  if (!msg?.key?.remoteJid || !msg?.message) return;
  const jid = msg.key.remoteJid;
  if (jid.startsWith('status@') || jid.endsWith('@lid')) return;

  const fromMe = msg.key.fromMe === true || msg.key.fromMe === 'true';
  const mid    = msg.key?.id;
  const ts     = +msg.messageTimestamp || +msg.key?.timestamp || 0;

  // Deduplica por msgId — já está no cache em memória
  if (mid && WA.msgCache[jid]?.[mid]) return;

  // Normaliza
  const normalized = {
    ...msg,
    key: { ...msg.key, fromMe },
    messageTimestamp: ts || agora
  };

  // Salva no banco (INSERT OR IGNORE — não duplica)
  if (mid) {
    if (!WA.msgCache[jid]) WA.msgCache[jid] = {};
    WA.msgCache[jid][mid] = normalized;
    waCacheSave([normalized]);
  }

  // pushName de recebidas
  if (!fromMe && msg.pushName?.trim()) {
    WA.nameCache[jid] = msg.pushName.trim();
  }

  // Badge só para mensagens RECEBIDAS e quando não está visualizando essa conversa
  if (!fromMe && (!WA.open || WA.activeJid !== jid)) waBadgeInc();

  // Notifica cards do kanban (açougue: ajuste de peso pendente)
  if (!fromMe && typeof _verificarRespostaWACliente === 'function') {
    _verificarRespostaWACliente(msg);
  }

  // Atualiza preview da lista
  waUpdatePreview(jid, normalized, fromMe);

  // Insere em tempo real se a conversa estiver aberta
  if (WA.activeJid === jid) {
    const msgsEl = document.getElementById('wa-messages');
    if (!msgsEl) return;
    if (mid && msgsEl.querySelector(`[data-mid="${CSS.escape(mid)}"]`)) return;
    const el = waBuildMsgEl(normalized);
    if (el) { msgsEl.appendChild(el); msgsEl.scrollTop = msgsEl.scrollHeight; }
  }
}

/* ─── Atendente no header da conversa ───────────────── */
function waAtualizarHeaderAtendente(jid) {
  const el = document.getElementById('wa-atendente-badge');
  if (!el) return;
  const at = WA.atendentesMap[jid || WA.activeJid];
  if (at?.atendente_nome) {
    el.textContent = '👤 ' + at.atendente_nome;
    el.style.display = 'inline-flex';
  } else {
    el.textContent = '👤 Sem atendente';
    el.style.display = 'inline-flex';
  }
}

async function waAtribuirAtendente(atendenteId) {
  const jid = WA.activeJid;
  if (!jid) return;
  const tid = _waTid();
  try {
    await fetch('/api/wa/atribuir-atendente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': tid },
      body: JSON.stringify({ jid, atendente_id: atendenteId || null })
    });
    // Atualiza mapa local imediatamente
    const sel = document.getElementById('wa-atendente-select');
    const nome = sel?.options[sel.selectedIndex]?.text || '';
    if (atendenteId) {
      WA.atendentesMap[jid] = { atendente_id: atendenteId, atendente_nome: nome };
    } else {
      delete WA.atendentesMap[jid];
    }
    waAtualizarHeaderAtendente(jid);
    waRenderList();
    waSbToast('ok', atendenteId ? `Atribuído para ${nome}` : 'Atendente removido');
    // Fecha o dropdown
    const dd = document.getElementById('wa-atendente-dropdown');
    if (dd) dd.style.display = 'none';
  } catch(e) { waSbToast('err', 'Erro: ' + e.message); }
}

async function waToggleAtendenteDropdown() {
  const dd  = document.getElementById('wa-atendente-dropdown');
  const sel = document.getElementById('wa-atendente-select');
  if (!dd || !sel) return;
  if (dd.style.display !== 'none') { dd.style.display = 'none'; return; }
  // Carrega atendentes do dept desta conversa
  const tid  = _waTid();
  const sess = JSON.parse(sessionStorage.getItem('sys_session') || '{}');
  const deptId = sess.dept_id || '';
  try {
    const r = await fetch(`/api/wa/atendentes${deptId ? '?dept_id='+deptId : ''}`, {
      headers: { 'x-tenant-id': tid }
    });
    const ats = r.ok ? await r.json().catch(() => []) : [];
    const atual = WA.atendentesMap[WA.activeJid]?.atendente_id || '';
    sel.innerHTML = `<option value="">— Sem atendente —</option>` +
      ats.map(a => `<option value="${a.id}" ${a.id === atual ? 'selected' : ''}>${a.nome} (${a.total_convs} conv)</option>`).join('');
    dd.style.display = 'block';
  } catch(e) { waSbToast('err', 'Erro ao carregar atendentes'); }
}

function waBadgeInc() {
  const b = document.getElementById('wa-unread-badge');
  if (!b) return;
  b.textContent = (parseInt(b.textContent)||0) + 1;
  b.style.display = 'flex';
}

function waBadgeClear() {
  const b = document.getElementById('wa-unread-badge');
  if (b) { b.textContent='0'; b.style.display='none'; }
}

function waUpdatePreview(jid, msg, fromMe) {
  // ── Supervisor: ignora msgs de conversas fora do seu dept ──
  if (WA.deptJids !== null && !WA.deptJids.has(jid)) return;

  const chat = WA.chats.find(c => c._jid === jid);
  if (chat) {
    chat.lastMessage = msg;
    chat._ts = msg.messageTimestamp || Date.now()/1000;
    if (!fromMe) chat._unread = (chat._unread||0) + 1;
    WA.chats.sort((a,b) => (b._ts||0)-(a._ts||0));
    waRenderList();
  } else {
    waLoadChats();
  }
}

/* ─── Carregar chats (POST /chat/findChats) ─────────── */
async function waLoadChats() {
  const listEl = document.getElementById('wa-chat-list');
  if (!listEl) return;
  const inst = EVO.instance;
  if (!inst) {
    listEl.innerHTML = `<div class="wa-empty-state"><p style="color:#94a3b8;font-size:13px;text-align:center">⚠️ Configure a instância no painel <b>Robô</b>.</p></div>`;
    return;
  }
  listEl.innerHTML = `<div class="wa-empty-state"><div class="wa-typing-dots"><span></span><span></span><span></span></div><p style="color:#64748b;font-size:12px;margin-top:10px">Carregando...</p></div>`;

  try {
    // Evolution API 2.7 — POST com body vazio retorna todos os chats
    const r = await EVO.req('POST', `/chat/findChats/${inst}`, {});
    let raw = r.data;

    // Normaliza resposta (pode vir como array, {chats:[]}, {data:[]}, etc.)
    let chats = Array.isArray(raw) ? raw
              : Array.isArray(raw?.chats) ? raw.chats
              : Array.isArray(raw?.data) ? raw.data
              : Array.isArray(raw?.records) ? raw.records
              : [];

    // Filtra: só JIDs reais (sem LID, grupos, broadcast, status)
    chats = chats.filter(c => {
      const jid = c.remoteJid || c.id || '';
      return waIsRealJid(jid);
    });

    // Normaliza cada chat e extrai campos relevantes
    chats = chats.map(c => {
      const jid = c.remoteJid || c.id || '';
      const ts  = c.updatedAt
                ? new Date(c.updatedAt).getTime()/1000
                : (c.lastMessage?.messageTimestamp || 0);
      // profilePicUrl já vem do findChats na v2.7
      const pic = c.profilePicUrl || c.profilePictureUrl || null;
      const name = c.name || c.pushName || '';
      if (name && jid) WA.nameCache[jid] = name; // guarda no cache
      return {
        _jid:    jid,
        _ts:     ts,
        _unread: c.unreadCount || 0,
        _pic:    pic,
        _name:   name,
        ...c
      };
    });

    // Ordena mais recente primeiro
    chats.sort((a,b) => (b._ts||0) - (a._ts||0));

    WA.chats = chats;

    // ── Filtro supervisor: só mostra conversas do seu departamento ──
    if (WA.deptJids !== null) {
      WA.chats = WA.chats.filter(c => WA.deptJids.has(c._jid));
    }

    waRenderList();

  } catch(e) {
    listEl.innerHTML = `<div class="wa-empty-state"><p style="color:#ef4444;font-size:12px">Erro: ${waEsc(e.message)}</p><button class="wa-btn-primary" style="margin-top:12px" onclick="waLoadChats()">Tentar novamente</button></div>`;
  }
}

/* ─── Renderizar lista ──────────────────────────────── */
function waRenderList(filter) {
  const listEl = document.getElementById('wa-chat-list');
  if (!listEl) return;

  const q = filter !== undefined ? filter : (document.getElementById('wa-search')?.value || '');
  const chats = q
    ? WA.chats.filter(c => {
        const n = (c._name || waFmtPhone(c._jid)).toLowerCase();
        return n.includes(q.toLowerCase()) || (c._jid||'').includes(q);
      })
    : WA.chats;

  if (!chats.length) {
    listEl.innerHTML = `<div class="wa-empty-state"><p style="color:#64748b;font-size:13px;text-align:center">Nenhuma conversa encontrada.</p><button class="wa-btn-primary" style="margin-top:12px" onclick="waLoadChats()">Atualizar</button></div>`;
    return;
  }

  listEl.innerHTML = chats.map((c, i) => {
    const jid     = c._jid;
    const name    = waGetName(jid, c._name);
    const phone   = waFmtPhone(jid);
    const preview = waGetPreview(c.lastMessage);
    const time    = waFmtTime(c._ts);
    const unread  = c._unread || 0;
    const active  = jid === WA.activeJid;
    const sj      = waEsc(jid);
    const sn      = waEsc(name);
    const atInfo  = WA.atendentesMap[jid];
    const atBadge = atInfo?.atendente_nome
      ? `<div style="font-size:10px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">👤 ${waEsc(atInfo.atendente_nome)}</div>`
      : '';

    return `<div class="wa-chat-item${active?' waci-active':''}" onclick="waOpenConv('${jid.replace(/'/g,"\\'")}','${name.replace(/'/g,"\\'")}')" data-jid="${sj}">
      <div class="wa-chat-avatar" id="wa-av-${i}"
        style="${c._pic ? `background:url('${waEsc(c._pic)}') center/cover` : ''}">
        ${c._pic ? '' : waInitials(name)}
      </div>
      <div class="wa-chat-meta">
        <div class="wa-chat-name">${sn || phone}</div>
        <div class="wa-chat-preview">${preview ? waEsc(preview) : '<i style="opacity:.4">Sem mensagens</i>'}</div>
        ${atBadge}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
        ${time ? `<div class="wa-chat-time">${time}</div>` : ''}
        ${unread > 0 ? `<div class="wa-unread-dot">${unread > 99 ? '99+' : unread}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Avatares com proxy do servidor (evita CORS)
  chats.forEach((c, i) => {
    if (!c._pic) return;
    const el = document.getElementById(`wa-av-${i}`);
    if (!el) return;
    const proxied = `/api/wa/avatar?url=${encodeURIComponent(c._pic)}`;
    el.style.backgroundImage = `url('${proxied}')`;
    el.style.backgroundSize  = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
  });
}

// Busca filtrada
function waFilterChats(q) { waRenderList(q); }

/* ─── Abrir conversa ────────────────────────────────── */
async function waOpenConv(jid, name) {
  WA.activeJid  = jid;
  WA.activeName = name;
  WA.lastMsgTs  = 0;
  waBadgeClear();

  const nameEl   = document.getElementById('wa-conv-name');
  const phoneEl  = document.getElementById('wa-conv-phone');
  const avatarEl = document.getElementById('wa-conv-avatar');

  const displayName = waGetName(jid, name);
  if (nameEl)   nameEl.textContent  = displayName || waFmtPhone(jid);
  if (phoneEl)  phoneEl.textContent = waFmtPhone(jid);
  if (avatarEl) {
    avatarEl.textContent = waInitials(displayName);
    avatarEl.style.backgroundImage = '';
    // Usa foto do chat se disponível
    const chat = WA.chats.find(c => c._jid === jid);
    if (chat?._pic) {
      const proxied = `/api/wa/avatar?url=${encodeURIComponent(chat._pic)}`;
      avatarEl.style.backgroundImage = `url('${proxied}')`;
      avatarEl.style.backgroundSize  = 'cover';
      avatarEl.style.backgroundPosition = 'center';
      avatarEl.textContent = '';
    }
  }

  document.getElementById('wa-conv-empty').style.display  = 'none';
  document.getElementById('wa-conv-active').style.display = 'flex';

  // Mostra atendente atual no header (só para gestor/supervisor)
  const _sessAtend = JSON.parse(sessionStorage.getItem('sys_session') || '{}');
  const _atnEl = document.getElementById('wa-atendente-wrap');
  if (_atnEl) {
    const _showAtend = _sessAtend.role !== 'atendente';
    _atnEl.style.display = _showAtend ? 'flex' : 'none';
    if (_showAtend) waAtualizarHeaderAtendente(jid);
  }

  if (window.innerWidth <= 640)
    document.getElementById('wa-list-col')?.classList.add('hidden');

  document.querySelectorAll('.wa-chat-item').forEach(e => e.classList.remove('waci-active'));
  document.querySelector(`.wa-chat-item[data-jid="${CSS.escape(jid)}"]`)?.classList.add('waci-active');

  const chat = WA.chats.find(c => c._jid === jid);
  if (chat) { chat._unread = 0; waRenderList(); }

  // Carrega cache do banco primeiro (aparece instantaneamente)
  await waCacheLoad(jid);
  await waLoadMessages();
}

/* ─── Carregar mensagens ────────────────────────────── */
async function waLoadMessages(silent = false) {
  if (!WA.activeJid) return;
  const inst   = EVO.instance;
  const msgsEl = document.getElementById('wa-messages');
  const loadEl = document.getElementById('wa-msgs-loading');
  if (!msgsEl) return;

  // ── 1. Renderiza cache do banco imediatamente (antes da API) ──
  if (!silent) {
    const cached = WA.msgCache[WA.activeJid] || {};
    const cachedMsgs = Object.values(cached)
      .sort((a,b) => (a.messageTimestamp||0) - (b.messageTimestamp||0));

    if (cachedMsgs.length > 0) {
      msgsEl.innerHTML = '';
      waRenderMsgs(msgsEl, cachedMsgs);
    } else {
      // Sem cache ainda — mostra loading
      msgsEl.innerHTML = '';
      if (loadEl) { loadEl.style.display = 'flex'; msgsEl.appendChild(loadEl); }
    }
  }

  // ── 2. Busca da API EVO em paralelo ──────────────────
  if (!inst) return;

  try {
    const r = await EVO.req('POST', `/chat/findMessages/${inst}`, {
      where:  { key: { remoteJid: WA.activeJid } },
      page:   1,
      offset: 60
    });

    let apiMsgs = [];
    const d = r.data;
    if      (Array.isArray(d))                    apiMsgs = d;
    else if (Array.isArray(d?.records))           apiMsgs = d.records;
    else if (Array.isArray(d?.messages?.records)) apiMsgs = d.messages.records;
    else if (Array.isArray(d?.messages))          apiMsgs = d.messages;

    // Filtro client-side (bug EVO 2.7)
    const targetJid = WA.activeJid.toLowerCase();
    apiMsgs = apiMsgs.filter(m => (m.key?.remoteJid||'').toLowerCase() === targetJid);

    // Normaliza
    apiMsgs = apiMsgs.map(m => ({
      ...m,
      key: { ...m.key, fromMe: m.key?.fromMe === true || m.key?.fromMe === 'true' },
      messageTimestamp: +m.messageTimestamp || 0
    }));

    // ── 3. Mescla API + cache (cache tem msgs que API não retornou) ──
    const cached  = WA.msgCache[WA.activeJid] || {};
    const apiIds  = new Set(apiMsgs.map(m => m.key?.id).filter(Boolean));
    Object.values(cached).forEach(cm => {
      if (cm.key?.id && !apiIds.has(cm.key.id)) apiMsgs.push(cm);
    });

    // Salva tudo no cache em memória e no banco
    apiMsgs.forEach(m => {
      const mid = m.key?.id;
      if (mid) {
        if (!WA.msgCache[WA.activeJid]) WA.msgCache[WA.activeJid] = {};
        WA.msgCache[WA.activeJid][mid] = m;
      }
    });
    waCacheSave(apiMsgs);

    // pushNames
    apiMsgs.forEach(m => {
      if (!m.key.fromMe && m.pushName?.trim())
        WA.nameCache[m.key.remoteJid] = m.pushName.trim();
    });

    // Ordena crescente
    apiMsgs.sort((a,b) => (a.messageTimestamp||0) - (b.messageTimestamp||0));

    // Polling: nada novo?
    if (silent && apiMsgs.length > 0) {
      const lts = apiMsgs[apiMsgs.length-1].messageTimestamp || 0;
      if (lts === WA.lastMsgTs) return;
      WA.lastMsgTs = lts;
    } else if (apiMsgs.length > 0) {
      WA.lastMsgTs = apiMsgs[apiMsgs.length-1].messageTimestamp || 0;
    }

    if (loadEl) loadEl.style.display = 'none';

    if (!apiMsgs.length) {
      if (!silent) msgsEl.innerHTML = '<div style="text-align:center;color:#64748b;font-size:12px;padding:30px">Sem mensagens nesta conversa.</div>';
      return;
    }

    // ── 4. Re-renderiza com resultado final (API + cache) ──
    msgsEl.innerHTML = '';
    waRenderMsgs(msgsEl, apiMsgs);

  } catch(e) {
    if (loadEl) loadEl.style.display = 'none';
    // API falhou — mantém o que já está na tela (cache) e avisa discretamente
    if (!silent) {
      const err = document.createElement('div');
      err.style.cssText = 'text-align:center;color:#64748b;font-size:11px;padding:8px';
      err.textContent = '⚠️ Sem conexão com WhatsApp — exibindo mensagens salvas';
      msgsEl.prepend(err);
    }
  }
}

// Renderiza lista de mensagens num elemento
function waRenderMsgs(container, msgs) {
  let lastDate = '';
  msgs.forEach(msg => {
    const ds = waFmtDate(msg.messageTimestamp);
    if (ds && ds !== lastDate) {
      lastDate = ds;
      const sep = document.createElement('div');
      sep.className = 'wa-date-sep';
      sep.innerHTML = `<span>${ds}</span>`;
      container.appendChild(sep);
    }
    const el = waBuildMsgEl(msg);
    if (el) container.appendChild(el);
  });
  container.scrollTop = container.scrollHeight;
}

/* ─── Construir elemento de mensagem ────────────────── */
function waBuildMsgEl(msg) {
  // ── fromMe: ÚNICO campo confiável é key.fromMe (boolean ou string "true"/"false")
  // Quando fromMe=true, a Evolution API define pushName='' explicitamente
  // NÃO usar pushName para inferir fromMe — é ambíguo e causa erros
  const rawFromMe = msg.key?.fromMe;
  const fromMe = rawFromMe === true || rawFromMe === 'true';

  const rawTs  = msg.messageTimestamp || msg.key?.timestamp || 0;
  const tsNum  = +rawTs; // converte string "1717689097" para número
  const ts     = tsNum > 9999999999 ? tsNum : tsNum * 1000; // ms
  const time   = tsNum ? new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '';

  const m      = msg.message || {};
  const msgId  = msg.key?.id || '';
  const remJid = msg.key?.remoteJid || WA.activeJid || '';

  const text     = m.conversation || m.extendedTextMessage?.text || '';
  const imgMsg   = m.imageMessage;
  const vidMsg   = m.videoMessage;
  const audMsg   = m.audioMessage || m.pttMessage;
  const docMsg   = m.documentMessage
                 || m.documentWithCaptionMessage?.message?.documentMessage;
  const stkMsg   = m.stickerMessage;
  const locMsg   = m.locationMessage;
  const reactMsg = m.reactionMessage;
  const btnMsg   = m.buttonsResponseMessage || m.templateButtonReplyMessage;
  const listMsg  = m.listResponseMessage;

  const wrap = document.createElement('div');
  wrap.className = `wa-msg ${fromMe ? 'sent' : 'recv'}`;
  if (msgId) wrap.dataset.mid = msgId;

  const bubble = document.createElement('div');
  bubble.className = 'wa-bubble';

  /* Botão de download ─────────────────────────────── */
  function dlBtn(type, label, fname='') {
    return `<button class="wa-dl-btn" onclick="waDlMedia('${waEsc(msgId)}','${waEsc(remJid)}','${type}',this,'${waEsc(fname)}')">
      <svg viewBox="0 0 16 16" fill="none" width="12" height="12"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      ${waEsc(label)}
    </button>`;
  }

  /* Thumb genérico de mídia ────────────────────────── */
  function thumb(icon, title, sub, type, fname='') {
    const cached = msgId ? WA.mediaCache[msgId] : null;
    if (cached) return null; // já baixado — renderiza diferente
    return `<div class="wa-media-thumb" id="wamt-${waEsc(msgId)}">
      <span class="wa-micon">${icon}</span>
      <div class="wa-minfo">
        <div style="font-size:12.5px;color:#f1f5f9;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${waEsc(title)}</div>
        ${sub ? `<div style="font-size:11px;color:#64748b">${waEsc(sub)}</div>` : ''}
      </div>
      ${dlBtn(type, type==='audio'?'Ouvir':'Baixar', fname)}
    </div>`;
  }

  /* Imagem ─────────────────────────────────────────── */
  if (imgMsg) {
    const cap = imgMsg.caption || '';
    const c   = msgId && WA.mediaCache[msgId];
    if (c) {
      bubble.innerHTML = `<img src="data:${c.mimetype};base64,${c.base64}" onclick="waViewImg(this.src)" style="max-width:220px;max-height:180px;border-radius:8px;display:block;cursor:zoom-in">${cap?`<div style="margin-top:4px;font-size:13px">${waEsc(cap)}</div>`:''}`;
    } else {
      bubble.innerHTML = thumb('🖼️', cap||'Imagem', imgMsg.fileLength?waFmtBytes(imgMsg.fileLength):'', 'image') || '';
    }
  }

  /* Vídeo ──────────────────────────────────────────── */
  else if (vidMsg) {
    const cap = vidMsg.caption || '';
    const c   = msgId && WA.mediaCache[msgId];
    if (c) {
      bubble.innerHTML = `<video controls style="max-width:220px;max-height:180px;border-radius:8px;display:block"><source src="data:${c.mimetype};base64,${c.base64}" type="${c.mimetype}"></video>${cap?`<div style="margin-top:4px;font-size:13px">${waEsc(cap)}</div>`:''}`;
    } else {
      bubble.innerHTML = thumb('🎥', cap||'Vídeo', vidMsg.fileLength?waFmtBytes(vidMsg.fileLength):'', 'video') || '';
    }
  }

  /* Áudio / PTT ────────────────────────────────────── */
  else if (audMsg) {
    const c   = msgId && WA.mediaCache[msgId];
    const dur = audMsg.seconds ? audMsg.seconds+'s' : '';
    if (c) {
      bubble.innerHTML = `<div class="wa-audio-player"><audio controls style="height:32px;width:200px"><source src="data:${c.mimetype};base64,${c.base64}" type="${c.mimetype}"></audio></div>`;
    } else {
      bubble.innerHTML = thumb('🎵', audMsg.ptt?'Mensagem de voz':'Áudio', dur, 'audio') || '';
    }
  }

  /* Documento ──────────────────────────────────────── */
  else if (docMsg) {
    const fname = docMsg.fileName || docMsg.title || 'Documento';
    const mime  = docMsg.mimetype || '';
    const icon  = mime.includes('pdf')?'📄':mime.includes('sheet')||mime.includes('excel')?'📊':mime.includes('word')?'📝':'📎';
    const c     = msgId && WA.mediaCache[msgId];
    if (c) {
      bubble.innerHTML = `<div class="wa-doc-bubble" onclick="waOpenDoc('${waEsc(msgId)}')">
        <span style="font-size:22px">${icon}</span>
        <div><div style="font-size:12.5px;color:#f1f5f9">${waEsc(fname)}</div><div style="font-size:11px;color:#25D366">Toque para abrir</div></div>
      </div>`;
    } else {
      bubble.innerHTML = thumb(icon, fname, docMsg.fileLength?waFmtBytes(docMsg.fileLength):mime, 'document', fname) || '';
    }
  }

  /* Sticker ────────────────────────────────────────── */
  else if (stkMsg) { bubble.innerHTML = '<span style="font-size:28px">🎭</span>'; }

  /* Localização ────────────────────────────────────── */
  else if (locMsg) {
    const lat = (locMsg.degreesLatitude||0).toFixed(5);
    const lng = (locMsg.degreesLongitude||0).toFixed(5);
    bubble.innerHTML = `<a href="https://maps.google.com/?q=${lat},${lng}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:6px;color:#25D366;text-decoration:none;font-size:13px">📍 Ver localização</a>`;
  }

  /* Reação ─────────────────────────────────────────── */
  else if (reactMsg) { bubble.innerHTML = `<span style="font-size:26px">${waEsc(reactMsg.text||'👍')}</span>`; }

  /* Resposta de botão / lista ──────────────────────── */
  else if (btnMsg||listMsg) {
    bubble.textContent = btnMsg?.selectedButtonId || btnMsg?.title
                      || listMsg?.title || listMsg?.singleSelectReply?.selectedRowId || '(Resposta)';
  }

  /* Texto ──────────────────────────────────────────── */
  else if (text) {
    bubble.innerHTML = waEsc(text)
      .replace(/\*([^*\n]+)\*/g,'<b>$1</b>')
      .replace(/_([^_\n]+)_/g,'<i>$1</i>')
      .replace(/~([^~\n]+)~/g,'<s>$1</s>')
      .replace(/\n/g,'<br>');
  }

  else { return null; }

  const timeDiv = document.createElement('div');
  timeDiv.className = 'wa-msg-time';
  timeDiv.innerHTML = time + (fromMe ? ' <span class="wa-check">✓✓</span>' : '');

  wrap.appendChild(bubble);
  wrap.appendChild(timeDiv);
  return wrap;
}

/* ─── Visualizar imagem fullscreen ──────────────────── */
function waViewImg(src) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  ov.onclick = () => ov.remove();
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:92vw;max-height:92vh;border-radius:10px;object-fit:contain';
  ov.appendChild(img);
  document.body.appendChild(ov);
}

/* ─── Download de mídia sob demanda ─────────────────── */
async function waDlMedia(msgId, remoteJid, type, btn, fileName) {
  if (!msgId || !remoteJid) return;
  if (WA.mediaCache[msgId]) { waApplyMedia(msgId, type, fileName); return; }

  const orig = btn?.innerHTML;
  if (btn) { btn.disabled=true; btn.innerHTML='<span class="wa-dl-spin"></span>'; }

  try {
    const tid = (typeof _sessao!=='undefined') ? (_sessao?.tenant_id||'') : '';
    const r   = await fetch('/api/wa/media', {
      method:  'POST',
      headers: {'Content-Type':'application/json','x-tenant-id':tid},
      body:    JSON.stringify({ messageId: msgId, remoteJid })
    });
    const data = await r.json().catch(()=>({}));
    if (!r.ok || !data.base64) {
      waSbToast('err', data.error||'Erro ao baixar mídia');
      if (btn) { btn.disabled=false; btn.innerHTML=orig; }
      return;
    }
    WA.mediaCache[msgId] = {
      base64:   data.base64,
      mimetype: data.mimetype || 'application/octet-stream',
      fileName: data.fileName || fileName || 'arquivo'
    };
    waApplyMedia(msgId, type, fileName);
  } catch(e) {
    waSbToast('err','Erro: '+e.message);
    if (btn) { btn.disabled=false; btn.innerHTML=orig; }
  }
}

function waApplyMedia(msgId, type, fileName) {
  const c     = WA.mediaCache[msgId];
  if (!c) return;
  const src   = `data:${c.mimetype};base64,${c.base64}`;
  const thumb = document.getElementById(`wamt-${msgId}`);
  if (!thumb) return;

  if (type === 'image') {
    thumb.outerHTML = `<img src="${src}" onclick="waViewImg('${src}')" style="max-width:220px;max-height:180px;border-radius:8px;display:block;cursor:zoom-in">`;
  } else if (type === 'video') {
    thumb.outerHTML = `<video controls style="max-width:220px;max-height:180px;border-radius:8px;display:block"><source src="${src}" type="${c.mimetype}"></video>`;
  } else if (type === 'audio') {
    thumb.outerHTML = `<div class="wa-audio-player"><audio controls style="height:32px;width:200px"><source src="${src}" type="${c.mimetype}"></audio></div>`;
  } else if (type === 'document') {
    const fn   = c.fileName || fileName || 'arquivo';
    const mime = c.mimetype;
    const icon = mime.includes('pdf')?'📄':mime.includes('sheet')?'📊':mime.includes('word')?'📝':'📎';
    thumb.outerHTML = `<div class="wa-doc-bubble" onclick="waOpenDoc('${waEsc(msgId)}')">
      <span style="font-size:22px">${icon}</span>
      <div><div style="font-size:12.5px;color:#f1f5f9">${waEsc(fn)}</div><div style="font-size:11px;color:#25D366">Toque para abrir</div></div>
    </div>`;
  }
}

function waOpenDoc(msgId) {
  const c = WA.mediaCache[msgId];
  if (!c) return;
  const a = document.createElement('a');
  a.href     = `data:${c.mimetype};base64,${c.base64}`;
  a.download = c.fileName || 'arquivo';
  a.click();
}

/* ─── Enviar texto ───────────────────────────────────── */
async function waSendMessage() {
  const inp  = document.getElementById('wa-msg-input');
  const text = (inp?.value||'').trim();
  const inst = EVO.instance;
  if (!inst||!WA.activeJid) { waSbToast('err','Nenhuma conversa selecionada'); return; }
  if (WA.pendingFile) { await waSendMedia(); return; }
  if (!text) return;

  inp.value = '';
  waToggleSendMic(false);

  // Mensagem otimista
  const fake = {
    key: { fromMe:true, id:'tmp_'+Date.now(), remoteJid:WA.activeJid },
    messageTimestamp: Math.floor(Date.now()/1000),
    message: { conversation: text }
  };
  const msgsEl = document.getElementById('wa-messages');
  const el = waBuildMsgEl(fake);
  if (el&&msgsEl) { msgsEl.appendChild(el); msgsEl.scrollTop=msgsEl.scrollHeight; }

  try {
    // EVO 2.7: POST /message/sendText/{instance} — body: { number, text }
    const r = await EVO.req('POST', `/message/sendText/${inst}`, {
      number: waSendNum(WA.activeJid),
      text
    });
    if (!r.ok) waSbToast('err', r.data?.message || r.data?.error || 'Erro ao enviar');
    else {
      // Pausa a IA: humano assumiu esta conversa
      const _phone = waSendNum(WA.activeJid);
      const _tid   = (()=>{ try { return JSON.parse(sessionStorage.getItem('sys_session')||'{}').tenant_id||'' } catch(e){ return '' } })();
      if (_phone && _tid) fetch('/api/ia-humano-assumiu', { method:'POST', headers:{'Content-Type':'application/json','x-tenant-id':_tid}, body: JSON.stringify({ phone: _phone, tenant_id: _tid }) }).catch(()=>{});
      setTimeout(() => waLoadMessages(true), 2000);
    }
  } catch(e) { waSbToast('err','Erro: '+e.message); }
}

function waOnTyping(inp) { waToggleSendMic(inp.value.trim().length>0 || !!WA.pendingFile); }

function waToggleSendMic(has) {
  const s = document.getElementById('wa-send-btn');
  const m = document.getElementById('wa-mic-btn');
  if (s) s.style.display = has ? 'flex' : 'none';
  if (m) m.style.display = has ? 'none'  : 'flex';
}

/* ─── Seleção de arquivo ────────────────────────────── */
function waOnFileSelect(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;
  WA.pendingFile = file;
  const prev  = document.getElementById('wa-media-preview');
  const prevI = document.getElementById('wa-preview-img');
  const prevN = document.getElementById('wa-preview-name');
  if (prev)  prev.style.display = 'block';
  if (prevN) prevN.textContent  = file.name;
  if (prevI) {
    if (file.type.startsWith('image/')) {
      const fr = new FileReader();
      fr.onload = e => { prevI.src=e.target.result; prevI.style.display='block'; };
      fr.readAsDataURL(file);
    } else prevI.style.display='none';
  }
  waToggleSendMic(true);
}

function waClearMedia() {
  WA.pendingFile = null;
  const prev = document.getElementById('wa-media-preview');
  const fi   = document.getElementById('wa-file-input');
  if (prev) prev.style.display = 'none';
  if (fi)   fi.value = '';
  waToggleSendMic((document.getElementById('wa-msg-input')?.value?.trim().length||0)>0);
}

/* ─── Enviar mídia ──────────────────────────────────── */
async function waSendMedia() {
  const file = WA.pendingFile;
  if (!file||!WA.activeJid||!EVO.instance) return;
  const fr = new FileReader();
  fr.onload = async (e) => {
    const b64     = e.target.result.split(',')[1];
    const mime    = file.type || 'application/octet-stream';
    const caption = document.getElementById('wa-msg-input')?.value?.trim() || '';
    let mt = 'document';
    if (mime.startsWith('image/')) mt='image';
    else if (mime.startsWith('video/')) mt='video';
    else if (mime.startsWith('audio/')) mt='audio';
    waClearMedia();
    if (document.getElementById('wa-msg-input')) document.getElementById('wa-msg-input').value='';
    waToggleSendMic(false);
    try {
      // EVO 2.7: POST /message/sendMedia/{instance}
      const r = await EVO.req('POST', `/message/sendMedia/${EVO.instance}`, {
        number:    waSendNum(WA.activeJid),
        mediatype: mt,
        mimetype:  mime,
        caption,
        media:     b64,
        fileName:  file.name
      });
      if (r.ok) {
        // Pausa a IA: humano assumiu esta conversa
        const _phone = waSendNum(WA.activeJid);
        const _tid   = (()=>{ try { return JSON.parse(sessionStorage.getItem('sys_session')||'{}').tenant_id||'' } catch(e){ return '' } })();
        if (_phone && _tid) fetch('/api/ia-humano-assumiu', { method:'POST', headers:{'Content-Type':'application/json','x-tenant-id':_tid}, body: JSON.stringify({ phone: _phone, tenant_id: _tid }) }).catch(()=>{});
        waSbToast('ok','Enviado!'); setTimeout(()=>waLoadMessages(true),2000);
      } else waSbToast('err', r.data?.message||r.data?.error||'Erro ao enviar mídia');
    } catch(err) { waSbToast('err','Erro: '+err.message); }
  };
  fr.readAsDataURL(file);
}

/* ─── Gravação de áudio ─────────────────────────────── */
async function waStartAudio() {
  if (WA.mediaRecorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    WA.audioChunks=[]; WA.recSeconds=0;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
               ? 'audio/webm;codecs=opus' : 'audio/webm';
    WA.mediaRecorder = new MediaRecorder(stream,{mimeType:mime});
    WA.mediaRecorder.ondataavailable = e => { if(e.data?.size>0) WA.audioChunks.push(e.data); };
    WA.mediaRecorder.start(100);
    document.getElementById('wa-audio-recording').style.display='flex';
    document.getElementById('wa-mic-btn')?.classList.add('recording');
    WA.recTimer = setInterval(()=>{
      WA.recSeconds++;
      const el=document.getElementById('wa-rec-time');
      if(el) el.textContent=`${Math.floor(WA.recSeconds/60)}:${String(WA.recSeconds%60).padStart(2,'0')}`;
    },1000);
  } catch { waSbToast('err','Permita acesso ao microfone'); }
}

async function waStopAudio() {
  if (!WA.mediaRecorder) return;
  clearInterval(WA.recTimer); WA.recTimer=null;
  document.getElementById('wa-audio-recording').style.display='none';
  document.getElementById('wa-mic-btn')?.classList.remove('recording');
  const rec = WA.mediaRecorder; WA.mediaRecorder=null;
  rec.stream?.getTracks().forEach(t=>t.stop());
  await new Promise(res=>{rec.onstop=res; rec.stop();});
  const chunks=[...WA.audioChunks]; WA.audioChunks=[];
  if (!chunks.length||WA.recSeconds<1) return;
  const blob=new Blob(chunks,{type:rec.mimeType||'audio/webm'});
  const fr=new FileReader();
  fr.onload=async(e)=>{
    try {
      // EVO 2.7: POST /message/sendWhatsAppAudio/{instance}
      const r=await EVO.req('POST',`/message/sendWhatsAppAudio/${EVO.instance}`,{
        number:   waSendNum(WA.activeJid),
        audio:    e.target.result.split(',')[1],
        encoding: true
      });
      if(r.ok){
        // Pausa a IA: humano assumiu esta conversa
        const _phone = waSendNum(WA.activeJid);
        const _tid   = (()=>{ try { return JSON.parse(sessionStorage.getItem('sys_session')||'{}').tenant_id||'' } catch(e){ return '' } })();
        if (_phone && _tid) fetch('/api/ia-humano-assumiu', { method:'POST', headers:{'Content-Type':'application/json','x-tenant-id':_tid}, body: JSON.stringify({ phone: _phone, tenant_id: _tid }) }).catch(()=>{});
        waSbToast('ok','Áudio enviado!'); setTimeout(()=>waLoadMessages(true),2000);
      }
      else waSbToast('err',r.data?.message||r.data?.error||'Erro ao enviar áudio');
    } catch(err){waSbToast('err','Erro: '+err.message);}
  };
  fr.readAsDataURL(blob);
}

function waCancelAudio() {
  if(WA.mediaRecorder){
    clearInterval(WA.recTimer); WA.recTimer=null;
    WA.mediaRecorder.stream?.getTracks().forEach(t=>t.stop());
    try{WA.mediaRecorder.stop();}catch{}
    WA.mediaRecorder=null; WA.audioChunks=[];
  }
  document.getElementById('wa-audio-recording').style.display='none';
  document.getElementById('wa-mic-btn')?.classList.remove('recording');
}

/* ─── CSS extra injetado ────────────────────────────── */
(function waCSS(){
  const s = document.createElement('style');
  s.textContent=`
.wa-chat-avatar{background-size:cover!important;background-position:center!important;font-size:15px}
.wa-contact-avatar{background-size:cover!important;background-position:center!important}
.wa-media-thumb{display:flex;align-items:center;gap:8px;padding:4px 0;min-width:190px}
.wa-micon{font-size:22px;flex-shrink:0}
.wa-minfo{flex:1;min-width:0}
.wa-doc-bubble{display:flex;align-items:center;gap:10px;padding:4px 0;cursor:pointer}
.wa-dl-btn{display:flex;align-items:center;gap:5px;background:#25D366;color:#fff;border:none;border-radius:20px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;font-family:'Outfit',sans-serif;transition:background .15s}
.wa-dl-btn:hover{background:#22c55e}
.wa-dl-btn:disabled{background:#374151;cursor:wait}
.wa-dl-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:waSpin .6s linear infinite}
@keyframes waSpin{to{transform:rotate(360deg)}}
.wa-audio-player{display:flex;align-items:center;gap:8px;padding:3px 0}
`;
  document.head.appendChild(s);
  // Fecha dropdown de atendente ao clicar fora
  document.addEventListener('click', e => {
    const dd = document.getElementById('wa-atendente-dropdown');
    const btn = document.getElementById('wa-atendente-badge');
    if (dd && dd.style.display !== 'none' && !dd.contains(e.target) && e.target !== btn) {
      dd.style.display = 'none';
    }
  });
})();

/* ─── Persistência no banco de dados ─────────────────── */

function _waTid() {
  try { return (typeof _sessao !== 'undefined' ? _sessao?.tenant_id : null) || ''; } catch { return ''; }
}

// Salva array de mensagens no banco (INSERT OR IGNORE — nunca duplica)
async function waCacheSave(msgs) {
  if (!msgs?.length) return;
  const tid = _waTid();
  if (!tid) return;
  try {
    await fetch('/api/wa/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': tid },
      body:    JSON.stringify(msgs)
    });
  } catch(e) { console.warn('[WA] save:', e.message); }
}

// Carrega msgs de um JID do banco e mescla no WA.msgCache
async function waCacheLoad(jid) {
  const tid = _waTid();
  if (!tid || !jid) return;
  try {
    const r    = await fetch(`/api/wa/messages?jid=${encodeURIComponent(jid)}`, {
      headers: { 'x-tenant-id': tid }
    });
    if (!r.ok) return;
    const msgs = await r.json().catch(() => []);
    if (!Array.isArray(msgs) || !msgs.length) return;
    if (!WA.msgCache[jid]) WA.msgCache[jid] = {};
    msgs.forEach(m => { if (m.key?.id) WA.msgCache[jid][m.key.id] = m; });
  } catch(e) { console.warn('[WA] load:', e.message); }
}

/* ─── Init ───────────────────────────────────────────── */
(function waInit(){
  const run = () => { waToggleSendMic(false); waConnectSSE(); };
  document.readyState==='loading'
    ? document.addEventListener('DOMContentLoaded', run)
    : run();
})();

// ── Fim WA-CHAT ───────────────────────────────────────
