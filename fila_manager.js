// fila_manager.js — Fila de Atendimento, TMA/TME, Chat Interno
// Requer: db.js (já inicializado), wsClients compartilhado com server.js
// Uso no server.js:
//   const filaMgr = require('./fila_manager');
//   filaMgr.init({ wsClients, fetch, EVO_URL, EVO_KEY });
//   // No handler principal, antes do bloco "if (req.url.startsWith('/api/'))"
//   const handled = await filaMgr.handleRequest(req, res, body);
//   if (handled) return;

'use strict';

const { from }  = require('./db.js');
const crypto    = require('crypto');
const newId     = () => crypto.randomUUID();

// ── ESTADO COMPARTILHADO ─────────────────────────────────────────────────────
let _wsClients  = null;
let _fetch      = null;
let _EVO_URL    = '';
let _EVO_KEY    = '';

function init({ wsClients, fetch, EVO_URL, EVO_KEY }) {
    _wsClients = wsClients;
    _fetch     = fetch;
    _EVO_URL   = EVO_URL;
    _EVO_KEY   = EVO_KEY;
}

// ── BROADCAST WS ─────────────────────────────────────────────────────────────
function broadcast(inst, payload) {
    if (!_wsClients?.[inst]) return;
    const msg = JSON.stringify(payload);
    for (const ws of _wsClients[inst]) {
        try { ws.send(msg); } catch(e) {}
    }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function formatarTempo(segundos) {
    if (!segundos) return '0s';
    const h = Math.floor(segundos / 3600);
    const m = Math.floor((segundos % 3600) / 60);
    const s = segundos % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// ── POSIÇÃO NA FILA ──────────────────────────────────────────────────────────
async function calcularPosicao(inst, departamento) {
    const { data } = await from('fila_atendimento')
        .select('id')
        .eq('instance_name', inst)
        .eq('departamento', departamento)
        .eq('status', 'aguardando');
    return (data || []).length + 1;
}

// ── ENTRAR NA FILA ───────────────────────────────────────────────────────────
// Retorna: { id, posicao, jaEstava }
async function entrarNaFila(inst, lead, departamento, motivo) {
    // Já está aguardando neste departamento?
    const { data: exist } = await from('fila_atendimento')
        .select('id, posicao')
        .eq('instance_name', inst)
        .eq('lead_id', lead.id)
        .eq('status', 'aguardando');

    if (exist && exist.length > 0) {
        return { id: exist[0].id, posicao: exist[0].posicao, jaEstava: true };
    }

    const posicao = await calcularPosicao(inst, departamento);
    const id = newId();

    await from('fila_atendimento').insert({
        id,
        instance_name: inst,
        lead_id:       lead.id,
        numero:        lead.numero,
        nome:          lead.nome || lead.push_name || lead.numero,
        departamento,
        posicao,
        status:        'aguardando',
        motivo_entrada: motivo || '',
        entrada_em:    new Date().toISOString(),
    });

    broadcast(inst, {
        type:        'fila_update',
        departamento,
        acao:        'entrada',
        posicao,
        lead_id:     lead.id,
        nome:        lead.nome || lead.push_name || lead.numero,
        motivo:      motivo || '',
    });

    return { id, posicao, jaEstava: false };
}

// ── INICIAR ATENDIMENTO ──────────────────────────────────────────────────────
async function iniciarAtendimento(inst, filaId, agenteId, agenteNome) {
    const { data: fila } = await from('fila_atendimento')
        .select('*').eq('id', filaId).single();

    if (!fila) return { error: 'Entrada não encontrada' };
    // Idempotente: se já está em atendimento, retorna ok sem erro
    if (fila.status === 'em_atendimento') {
        return { ok: true, jaAtivo: true, tme: fila.tme_segundos || 0, tme_fmt: formatarTempo(fila.tme_segundos || 0) };
    }
    if (fila.status !== 'aguardando') return { error: 'Entrada já encerrada' };

    const agora   = new Date().toISOString();
    const entrada = new Date(fila.entrada_em || fila.created_at);
    const tme     = Math.round((Date.now() - entrada.getTime()) / 1000);

    await from('fila_atendimento').update({
        status:             'em_atendimento',
        agente_id:          agenteId,
        agente_nome:        agenteNome,
        inicio_atendimento: agora,
        tme_segundos:       tme,
    }).eq('id', filaId);

    try {
        await from('atendimentos').insert({
            id:            newId(),
            instance_name: inst,
            lead_id:       fila.lead_id,
            fila_id:       filaId,
            departamento:  fila.departamento,
            agente_id:     agenteId,
            agente_nome:   agenteNome,
            numero:        fila.numero,
            nome:          fila.nome,
            inicio:        agora,
            tme_segundos:  tme,
            status:        'ativo',
        });
    } catch(e) { /* tabela pode não existir, segue o fluxo */ }

    // Marca agente como ocupado (tolerante: tabela agents pode não existir)
    if (agenteId) {
        try {
            await from('agents').update({
                status:          'ocupado',
                current_lead_id: fila.lead_id,
            }).eq('id', agenteId);
        } catch(e) { /* ignora */ }
    }

    // Recalcula posições dos demais que estão aguardando no mesmo depto
    try {
        const { data: aguardando } = await from('fila_atendimento')
            .select('id, entrada_em, created_at')
            .eq('instance_name', inst)
            .eq('departamento', fila.departamento)
            .eq('status', 'aguardando');
        const lista = (aguardando || []).slice().sort((a,b) => {
            const ta = new Date(a.entrada_em || a.created_at).getTime();
            const tb = new Date(b.entrada_em || b.created_at).getTime();
            return ta - tb;
        });
        for (let i = 0; i < lista.length; i++) {
            await from('fila_atendimento').update({ posicao: i + 1 }).eq('id', lista[i].id);
        }
    } catch(e) { /* best effort */ }

    broadcast(inst, {
        type:         'fila_update',
        departamento: fila.departamento,
        acao:         'inicio',
        fila_id:      filaId,
        lead_id:      fila.lead_id,
        agente:       agenteNome,
        tme:          tme,
    });

    return { ok: true, tme, tme_fmt: formatarTempo(tme) };
}

// ── ENCERRAR ATENDIMENTO ─────────────────────────────────────────────────────
async function encerrarAtendimento(inst, filaId, agenteId) {
    const { data: fila } = await from('fila_atendimento')
        .select('*').eq('id', filaId).single();

    if (!fila) return { error: 'Entrada não encontrada' };
    if (fila.status !== 'em_atendimento') return { error: 'Atendimento não ativo' };

    const agora  = new Date().toISOString();
    const inicio = new Date(fila.inicio_atendimento);
    const tma    = Math.round((Date.now() - inicio.getTime()) / 1000);

    await from('fila_atendimento').update({
        status:         'encerrado',
        fim_atendimento: agora,
        tma_segundos:   tma,
    }).eq('id', filaId);

    // Atualiza registro de atendimento
    const { data: atends } = await from('atendimentos')
        .select('id').eq('fila_id', filaId).eq('status', 'ativo');

    if (atends && atends.length > 0) {
        await from('atendimentos').update({
            fim:          agora,
            tma_segundos: tma,
            status:       'encerrado',
        }).eq('id', atends[0].id);
    }

    // Libera agente
    const agId = agenteId || fila.agente_id;
    if (agId) {
        await from('agents').update({
            status:          'disponivel',
            current_lead_id: null,
        }).eq('id', agId);
    }

    broadcast(inst, {
        type:         'fila_update',
        departamento: fila.departamento,
        acao:         'encerrado',
        fila_id:      filaId,
        tma:          tma,
    });

    return { ok: true, tma, tma_fmt: formatarTempo(tma) };
}

// ── TRANSFERIR DEPARTAMENTO ──────────────────────────────────────────────────
async function transferirAtendimento(inst, filaId, novoDepartamento) {
    const posicao = await calcularPosicao(inst, novoDepartamento);
    await from('fila_atendimento').update({
        departamento:       novoDepartamento,
        status:             'aguardando',
        agente_id:          null,
        agente_nome:        null,
        inicio_atendimento: null,
        posicao,
    }).eq('id', filaId);

    broadcast(inst, {
        type:         'fila_update',
        departamento: novoDepartamento,
        acao:         'transferencia',
        fila_id:      filaId,
        posicao,
    });

    return { ok: true, posicao };
}

// ── MÉTRICAS TMA/TME ─────────────────────────────────────────────────────────
async function getMetricas(inst, periodo) {
    const dias   = periodo === '30d' ? 30 : periodo === '1d' ? 1 : 7;
    const desde  = new Date();
    desde.setDate(desde.getDate() - dias);
    const desdeStr = desde.toISOString();

    const { data: todos } = await from('atendimentos')
        .select('*')
        .eq('instance_name', inst)
        .eq('status', 'encerrado');

    const filtrado = (todos || []).filter(a => (a.created_at || '') >= desdeStr);

    // Agrega por departamento
    const porDepto = {};
    for (const a of filtrado) {
        const d = a.departamento || 'Geral';
        if (!porDepto[d]) porDepto[d] = { tma: [], tme: [], total: 0, agentes: new Set() };
        if (a.tma_segundos) porDepto[d].tma.push(a.tma_segundos);
        if (a.tme_segundos) porDepto[d].tme.push(a.tme_segundos);
        if (a.agente_nome)  porDepto[d].agentes.add(a.agente_nome);
        porDepto[d].total++;
    }

    const por_departamento = Object.entries(porDepto).map(([dept, d]) => {
        const tma_med = d.tma.length
            ? Math.round(d.tma.reduce((s, v) => s + v, 0) / d.tma.length) : 0;
        const tme_med = d.tme.length
            ? Math.round(d.tme.reduce((s, v) => s + v, 0) / d.tme.length) : 0;
        return {
            departamento:       dept,
            total_atendimentos: d.total,
            tma_medio:          tma_med,
            tme_medio:          tme_med,
            tma_fmt:            formatarTempo(tma_med),
            tme_fmt:            formatarTempo(tme_med),
            agentes_ativos:     d.agentes.size,
        };
    });

    // Tendência diária
    const tendencia = [];
    for (let i = dias - 1; i >= 0; i--) {
        const d    = new Date();
        d.setDate(d.getDate() - i);
        const day  = d.toISOString().slice(0, 10);
        const da   = filtrado.filter(a => (a.created_at || '').startsWith(day));
        const tmas = da.filter(a => a.tma_segundos).map(a => a.tma_segundos);
        const tmes = da.filter(a => a.tme_segundos).map(a => a.tme_segundos);
        const avg  = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
        tendencia.push({
            data:  day,
            label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
            total: da.length,
            tma:   avg(tmas),
            tme:   avg(tmes),
        });
    }

    // Fila atual em espera por departamento
    const { data: filaAtual } = await from('fila_atendimento')
        .select('departamento, status')
        .eq('instance_name', inst);

    const filaStatus = {};
    for (const f of (filaAtual || [])) {
        if (!filaStatus[f.departamento]) filaStatus[f.departamento] = { aguardando: 0, em_atendimento: 0 };
        if (f.status === 'aguardando')     filaStatus[f.departamento].aguardando++;
        if (f.status === 'em_atendimento') filaStatus[f.departamento].em_atendimento++;
    }

    return {
        por_departamento,
        tendencia,
        fila_atual: filaStatus,
        periodo,
        gerado_em: new Date().toISOString(),
    };
}

// ── DETECTAR DEPARTAMENTO VIA IA ─────────────────────────────────────────────
// Retorna nome do departamento ou null
async function detectarDepartamentoIA(inst, mensagem, apiKey, departamentos) {
    if (!apiKey || !_fetch || !departamentos?.length) return null;

    const deptsStr = departamentos
        .map(d => `- ${d.name}${d.descricao ? ': ' + d.descricao : ''}`)
        .join('\n');

    try {
        const res = await _fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model:       'gpt-4o-mini',
                temperature: 0,
                max_tokens:  30,
                messages: [{
                    role:    'system',
                    content: `Você é um roteador de atendimento. Baseado na mensagem do cliente e nos departamentos disponíveis abaixo, responda SOMENTE com o nome exato do departamento mais adequado (sem explicações, sem pontuação). Se não souber, responda: ADM Principal\n\nDepartamentos:\n${deptsStr}`,
                }, {
                    role:    'user',
                    content: mensagem,
                }],
            }),
        });

        const d    = await res.json().catch(() => ({}));
        const dept = (d?.choices?.[0]?.message?.content || '').trim().replace(/["'.]/g, '');
        const hit  = departamentos.find(dep =>
            dep.name.toLowerCase() === dept.toLowerCase()
        );
        return hit ? hit.name : null;
    } catch(e) {
        return null;
    }
}

// ── CHAT INTERNO ─────────────────────────────────────────────────────────────
async function sendInternalMsg(inst, from_dept, to_dept, from_nome, content) {
    if (!content?.trim()) return { error: 'Mensagem vazia' };

    const { data } = await from('internal_chat').insert({
        id:            newId(),
        instance_name: inst,
        from_dept,
        to_dept,
        from_nome,
        content:       content.trim(),
        read:          0,
    });

    broadcast(inst, {
        type:       'internal_msg',
        from_dept,
        to_dept,
        from_nome,
        content:    content.trim(),
        created_at: new Date().toISOString(),
    });

    return { ok: true };
}

async function getInternalMsgs(inst, dept, limit) {
    const { data } = await from('internal_chat')
        .select('*')
        .eq('instance_name', inst);

    return (data || [])
        .filter(m =>
            m.from_dept === dept ||
            m.to_dept   === dept ||
            m.to_dept   === 'all'
        )
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
        .slice(-(limit || 100));
}

async function marcarMsgLida(inst, dept) {
    const { data: msgs } = await from('internal_chat')
        .select('id')
        .eq('instance_name', inst)
        .eq('to_dept', dept)
        .eq('read', 0);

    for (const m of (msgs || [])) {
        await from('internal_chat').update({ read: 1 }).eq('id', m.id);
    }
    return { ok: true };
}

// ── HANDLER HTTP ──────────────────────────────────────────────────────────────
// Retorna true se a rota foi tratada, false caso contrário.
async function handleRequest(req, res, body) {
    const url  = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const inst = url.searchParams.get('inst') || body?.inst || '';

    function json(data, status) {
        res.writeHead(status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return true;
    }

    // ── FILA ─────────────────────────────────────────────────────────────────

    // GET /api/fila — lista fila (opcional ?dept=X ?status=aguardando)
    if (req.method === 'GET' && path === '/api/fila') {
        if (!inst) return json({ error: 'inst obrigatório' }, 400);
        const dept   = url.searchParams.get('dept');
        const status = url.searchParams.get('status');
        const { data: rows } = await from('fila_atendimento')
            .select('*')
            .eq('instance_name', inst);
        let result = rows || [];
        if (dept)   result = result.filter(r => r.departamento === dept);
        if (status) result = result.filter(r => r.status === status);
        result.sort((a, b) => (a.posicao || 0) - (b.posicao || 0));
        return json(result);
    }

    // POST /api/fila/entrar
    if (req.method === 'POST' && path === '/api/fila/entrar') {
        const { lead_id, departamento, motivo } = body || {};
        if (!inst || !lead_id || !departamento) return json({ error: 'inst, lead_id, departamento obrigatórios' }, 400);
        const { data: lead } = await from('leads').select('*').eq('id', lead_id).single();
        if (!lead) return json({ error: 'Lead não encontrado' }, 404);
        const result = await entrarNaFila(inst, lead, departamento, motivo);
        return json(result);
    }

    // POST /api/fila/iniciar
    if (req.method === 'POST' && path === '/api/fila/iniciar') {
        const { fila_id, agente_id, agente_nome } = body || {};
        if (!fila_id) return json({ error: 'fila_id obrigatório' }, 400);
        const result = await iniciarAtendimento(inst, fila_id, agente_id, agente_nome || 'Atendente');
        return json(result);
    }

    // POST /api/fila/encerrar
    if (req.method === 'POST' && path === '/api/fila/encerrar') {
        const { fila_id, agente_id } = body || {};
        if (!fila_id) return json({ error: 'fila_id obrigatório' }, 400);
        const result = await encerrarAtendimento(inst, fila_id, agente_id);
        return json(result);
    }

    // POST /api/fila/transferir
    if (req.method === 'POST' && path === '/api/fila/transferir') {
        const { fila_id, novo_departamento } = body || {};
        if (!fila_id || !novo_departamento) return json({ error: 'fila_id e novo_departamento obrigatórios' }, 400);
        const result = await transferirAtendimento(inst, fila_id, novo_departamento);
        return json(result);
    }

    // ── MÉTRICAS ──────────────────────────────────────────────────────────────

    // GET /api/metricas/tma
    if (req.method === 'GET' && path === '/api/metricas/tma') {
        if (!inst) return json({ error: 'inst obrigatório' }, 400);
        const periodo = url.searchParams.get('periodo') || '7d';
        const result  = await getMetricas(inst, periodo);
        return json(result);
    }

    // ── AGENTES ──────────────────────────────────────────────────────────────

    // GET /api/agentes
    if (req.method === 'GET' && path === '/api/agentes') {
        if (!inst) return json({ error: 'inst obrigatório' }, 400);
        const { data } = await from('agents').select('*').eq('instance_name', inst);
        return json(data || []);
    }

    // POST /api/agentes — criar agente
    if (req.method === 'POST' && path === '/api/agentes') {
        const { nome, departamento } = body || {};
        if (!inst || !nome || !departamento) return json({ error: 'inst, nome, departamento obrigatórios' }, 400);
        const { data } = await from('agents').insert({
            id: newId(), instance_name: inst, nome, departamento, status: 'disponivel',
        });
        return json(data);
    }

    // DELETE /api/agentes — remover agente
    if (req.method === 'DELETE' && path === '/api/agentes') {
        const { agente_id } = body || {};
        if (!agente_id) return json({ error: 'agente_id obrigatório' }, 400);
        await from('agents').delete().eq('id', agente_id);
        return json({ ok: true });
    }

    // PUT /api/agentes/status
    if (req.method === 'PUT' && path === '/api/agentes/status') {
        const { agente_id, status } = body || {};
        if (!agente_id || !status) return json({ error: 'agente_id e status obrigatórios' }, 400);
        await from('agents').update({ status }).eq('id', agente_id);
        broadcast(inst, { type: 'agente_status', agente_id, status });
        return json({ ok: true });
    }

    // ── CHAT INTERNO ──────────────────────────────────────────────────────────

    // GET /api/internal-chat
    if (req.method === 'GET' && path === '/api/internal-chat') {
        if (!inst) return json({ error: 'inst obrigatório' }, 400);
        const dept  = url.searchParams.get('dept') || 'ADM Principal';
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const msgs  = await getInternalMsgs(inst, dept, limit);
        return json(msgs);
    }

    // POST /api/internal-chat
    if (req.method === 'POST' && path === '/api/internal-chat') {
        const { from_dept, to_dept, from_nome, content } = body || {};
        if (!inst || !from_dept || !to_dept || !content) {
            return json({ error: 'inst, from_dept, to_dept, content obrigatórios' }, 400);
        }
        const result = await sendInternalMsg(inst, from_dept, to_dept, from_nome || from_dept, content);
        return json(result);
    }

    // POST /api/internal-chat/lido
    if (req.method === 'POST' && path === '/api/internal-chat/lido') {
        const { dept } = body || {};
        if (!inst || !dept) return json({ error: 'inst e dept obrigatórios' }, 400);
        await marcarMsgLida(inst, dept);
        return json({ ok: true });
    }

    return false; // Rota não tratada aqui
}

module.exports = {
    init,
    handleRequest,
    entrarNaFila,
    iniciarAtendimento,
    encerrarAtendimento,
    transferirAtendimento,
    getMetricas,
    detectarDepartamentoIA,
    sendInternalMsg,
    getInternalMsgs,
};
