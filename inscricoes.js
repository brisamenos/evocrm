// ═══════════════════════════════════════════════════════════════════════════════
// INSCRIÇÕES DO SITE
// ───────────────────────────────────────────────────────────────────────────────
// Um site (ou vários) manda cada inscrição para o CRM com um "código de conexão".
// O CRM cria/atualiza o contato, avisa a equipe e dispara o fluxo configurado
// na aba "Inscrições do site" (mensagens, áudio, mídia, botões, agenda ou o Menu
// com Botões).
//
// O fluxo roda por uma fila gravada no banco (tabela inscricoes_site): sobrevive a
// reinício/redeploy, respeita horário de envio, para se o cliente responder e
// tenta de novo se o WhatsApp estiver fora.
//
// Rotas públicas (usadas pelo Admin do site, com Authorization: Bearer <token>):
//   GET  /api/inscricoes/ping
//   POST /api/inscricoes/receber
//   POST /api/inscricoes/consultar   { ids: [externo_id...] }
// Rotas do CRM (tela "Inscrições do site"):
//   GET  /api/inscricoes/fontes?inst=
//   POST /api/inscricoes/fontes            { inst, fonte }
//   POST /api/inscricoes/fontes/token      { inst, id }
//   POST /api/inscricoes/fontes/excluir    { inst, id }
//   GET  /api/inscricoes/lista?inst=&fonte=&q=&status=&de=&ate=&pagina=
//   GET  /api/inscricoes/exportar?inst=&fonte=
//   POST /api/inscricoes/acao              { inst, id, acao, valor }
//   POST /api/inscricoes/simular           { inst, fonte_id, nome, telefone, cidade }
// ═══════════════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const STATUS_INSCRICAO = ['novo', 'em_contato', 'agendado', 'cliente', 'descartado'];
const TIPOS_ETAPA = ['texto', 'audio', 'imagem', 'video', 'documento', 'botoes', 'agenda', 'menu'];
const ACOES_BOTAO = ['ia', 'agenda', 'humano', 'texto'];
const RETENTATIVAS_MIN = [1, 3, 10, 30, 60]; // espera entre tentativas quando o envio falha

function configPadrao() {
    return {
        atraso_seg: 20,                 // espera antes da 1ª mensagem (parece humano, não robô)
        horario: { ativo: false, inicio: '08:00', fim: '20:00', dias: [1, 2, 3, 4, 5, 6] },
        reenvio_dias: 7,                // mesma pessoa se inscrevendo de novo nesse prazo não recebe o fluxo outra vez
        parar_se_responder: true,       // cliente respondeu no meio → as próximas mensagens não saem (a IA assume)
        apos_fluxo: 'ia',               // 'ia' = IA continua | 'pausar_ia' = espera um atendente
        contexto_ia: 'Este contato se inscreveu no site "{site}" em {data}. Nome: {nome}. Cidade/Estado: {cidade}. Use isso para personalizar o atendimento e não peça de novo dados que ele já informou.',
        coluna: '',                     // coluna do Kanban ('' = primeira coluna)
        mover_existente: false,         // contato que já existia também muda de coluna
        etiqueta: 'site',
        notificar: true,
        etapas: [
            { id: 'e1', tipo: 'texto', espera_seg: 0, texto: 'Olá, {primeiro_nome}! 👋 Recebemos sua inscrição pelo site e já vamos te ajudar por aqui.' },
        ],
    };
}

module.exports = function criarInscricoes(d) {
    const { db, log } = d;
    const emAndamento = new Set();          // inscrições sendo processadas agora (evita envio duplo)
    const ultimasOpcoes = new Map();        // lead.id -> { opcoes:[{id,titulo}], at } (respostas "1", "2"...)
    const limiteIp = new Map();             // proteção simples contra abuso da rota pública

    // ── utilidades ─────────────────────────────────────────────────────────────
    const agoraISO = () => new Date().toISOString();
    const novoToken = () => 'ins_' + crypto.randomBytes(24).toString('hex');
    const jsonParse = (s, pad) => { if (s && typeof s === 'object') return s; try { return s ? JSON.parse(s) : pad; } catch (e) { return pad; } };
    const soDigitos = v => String(v || '').replace(/\D/g, '');
    const limpar = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

    function lerCorpo(req, max = 256 * 1024) {
        return new Promise((resolve, reject) => {
            let tam = 0; const partes = [];
            req.on('data', c => { tam += c.length; if (tam > max) { reject(Object.assign(new Error('Requisição muito grande'), { status: 413 })); req.destroy(); } else partes.push(c); });
            req.on('end', () => {
                const txt = Buffer.concat(partes).toString('utf8');
                if (!txt) return resolve({});
                try { resolve(JSON.parse(txt)); } catch (e) { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
            });
            req.on('error', reject);
        });
    }
    function responder(res, status, obj) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
    }
    function urlPublica(req) {
        const env = String(d.publicUrl || '').replace(/\/+$/, '');
        if (env) return env;
        const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return host ? `${proto}://${host}` : '';
    }
    const codigoConexao = (url, token) => 'EVO-' + Buffer.from(JSON.stringify({ v: 1, u: url, t: token })).toString('base64url');

    // Número brasileiro no formato 55 + DDD + número
    function normalizarNumero(tel) {
        let n = soDigitos(tel).replace(/^0+/, '');
        if (n.length === 10 || n.length === 11) n = '55' + n;
        return n;
    }
    // Com e sem o 9º dígito (o WhatsApp de alguns números antigos não tem o 9)
    function variantes(n) {
        const out = [n];
        const m = n.match(/^55(\d{2})(\d{8,9})$/);
        if (m) {
            const [, ddd, num] = m;
            if (num.length === 9 && num[0] === '9') out.push(`55${ddd}${num.slice(1)}`);
            if (num.length === 8 && /[6-9]/.test(num[0])) out.push(`55${ddd}9${num}`);
        }
        return out;
    }

    // Variáveis disponíveis nas mensagens
    function preencher(texto, ins, fonte) {
        const campos = jsonParse(ins.campos, {});
        const nome = limpar(ins.nome, 120);
        const primeiro = nome.split(/\s+/)[0] || '';
        const data = new Date(ins.created_at || Date.now()).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        let t = String(texto || '')
            .replace(/\{primeiro_nome\}/gi, primeiro)
            .replace(/\{nome\}/gi, nome)
            .replace(/\{cidade\}/gi, limpar(ins.cidade, 120))
            .replace(/\{telefone\}/gi, limpar(ins.telefone, 40))
            .replace(/\{email\}/gi, limpar(ins.email, 120))
            .replace(/\{site\}/gi, limpar(fonte?.nome, 80))
            .replace(/\{data\}/gi, data);
        t = t.replace(/\{campo:([a-z0-9_\-]+)\}/gi, (_, k) => limpar(campos[k] ?? '', 300));
        // "Olá, !" quando não há nome
        return t.replace(/,\s*([!?.])/g, '$1').replace(/ +([,!?.])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
    }

    // ── fontes (cada site/formulário conectado) ────────────────────────────────
    async function listarFontes(inst) {
        const { data } = await db.from('inscricoes_fontes').select('*').eq('instance_name', inst).order('created_at', { ascending: true });
        return (data || []).map(f => ({ ...f, ativo: !!f.ativo, config: { ...configPadrao(), ...jsonParse(f.config, {}) } }));
    }
    async function fontePorToken(token) {
        if (!token || !/^ins_[a-f0-9]{48}$/.test(token)) return null;
        const { data } = await db.from('inscricoes_fontes').select('*').eq('token', token).single();
        if (!data) return null;
        return { ...data, ativo: !!data.ativo, config: { ...configPadrao(), ...jsonParse(data.config, {}) } };
    }
    function tokenDaRequisicao(req) {
        const h = String(req.headers.authorization || '');
        if (/^bearer /i.test(h)) return h.slice(7).trim();
        return String(req.headers['x-token'] || '').trim();
    }

    function sanitizarConfig(c) {
        const p = configPadrao();
        const cfg = { ...p, ...(c || {}) };
        const hhmm = v => (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
        cfg.atraso_seg = Math.min(Math.max(parseInt(cfg.atraso_seg) || 0, 0), 86400);
        cfg.reenvio_dias = Math.min(Math.max(parseInt(cfg.reenvio_dias) || 0, 0), 365);
        cfg.parar_se_responder = cfg.parar_se_responder !== false;
        cfg.apos_fluxo = cfg.apos_fluxo === 'pausar_ia' ? 'pausar_ia' : 'ia';
        cfg.mover_existente = !!cfg.mover_existente;
        cfg.notificar = cfg.notificar !== false;
        cfg.coluna = limpar(cfg.coluna, 80);
        cfg.etiqueta = limpar(cfg.etiqueta, 40).replace(/,/g, ' ');
        cfg.contexto_ia = limpar(cfg.contexto_ia, 2000);
        const h = cfg.horario || {};
        cfg.horario = {
            ativo: !!h.ativo,
            inicio: hhmm(h.inicio) || p.horario.inicio,
            fim: hhmm(h.fim) || p.horario.fim,
            dias: (Array.isArray(h.dias) ? h.dias : p.horario.dias).map(Number).filter(n => n >= 0 && n <= 6),
        };
        if (!cfg.horario.dias.length) cfg.horario.dias = p.horario.dias;
        cfg.etapas = (Array.isArray(cfg.etapas) ? cfg.etapas : []).slice(0, 30).map((e, i) => {
            const tipo = TIPOS_ETAPA.includes(e.tipo) ? e.tipo : 'texto';
            const etapa = { id: limpar(e.id, 40) || `e${i + 1}_${Date.now().toString(36)}`, tipo, espera_seg: Math.min(Math.max(parseInt(e.espera_seg) || 0, 0), 30 * 86400) };
            if (tipo === 'texto') etapa.texto = limpar(e.texto, 4000);
            if (['audio', 'imagem', 'video', 'documento'].includes(tipo)) { etapa.url = limpar(e.url, 1000); etapa.legenda = limpar(e.legenda, 1000); etapa.nome_arquivo = limpar(e.nome_arquivo, 120); }
            if (tipo === 'agenda') etapa.texto = limpar(e.texto, 1000);
            if (tipo === 'botoes') {
                etapa.texto = limpar(e.texto, 1000);
                etapa.opcoes = (Array.isArray(e.opcoes) ? e.opcoes : []).filter(o => limpar(o.titulo, 40)).slice(0, 6).map(o => ({
                    titulo: [...limpar(o.titulo, 60)].slice(0, 20).join(''),
                    acao: ACOES_BOTAO.includes(o.acao) ? o.acao : 'ia',
                    resposta: limpar(o.resposta, 2000),
                    contexto_ia: limpar(o.contexto_ia, 1000),
                }));
            }
            return etapa;
        }).filter(e => {
            if (e.tipo === 'texto') return !!e.texto;
            if (['audio', 'imagem', 'video', 'documento'].includes(e.tipo)) return !!e.url;
            if (e.tipo === 'botoes') return e.opcoes.length > 0;
            return true;
        });
        return cfg;
    }

    // ── horário de envio ───────────────────────────────────────────────────────
    // Devolve a data em que a mensagem pode sair (a própria data se já estiver dentro da janela)
    function ajustarHorario(quando, horario) {
        if (!horario?.ativo) return quando;
        const [hi, mi] = horario.inicio.split(':').map(Number);
        const [hf, mf] = horario.fim.split(':').map(Number);
        const ini = hi * 60 + mi, fim = hf * 60 + mf;
        const d0 = new Date(quando);
        for (let i = 0; i < 8; i++) {
            const dia = new Date(d0); dia.setDate(d0.getDate() + i);
            if (!horario.dias.includes(dia.getDay())) continue;
            const minAgora = i === 0 ? d0.getHours() * 60 + d0.getMinutes() : -1;
            if (i === 0 && minAgora >= ini && minAgora < fim) return d0;
            if (minAgora < ini) { dia.setHours(hi, mi, Math.floor(Math.random() * 50), 0); return dia; }
        }
        return d0; // configuração estranha (janela vazia): não trava o envio
    }

    // ── WhatsApp ───────────────────────────────────────────────────────────────
    async function evo(inst, rota, body) {
        const r = await fetch(`${d.evoUrl()}/${rota}/${encodeURIComponent(inst)}`, {
            method: 'POST', headers: { apikey: d.evoKey(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.response?.message || data?.message || data?.error || `HTTP ${r.status}`);
        return data;
    }
    // Descobre o número exato do WhatsApp (com ou sem o 9º dígito).
    // { numero, existe: true|false|null } — null = não deu para conferir agora (WhatsApp fora)
    async function resolverWhatsApp(inst, numero) {
        try {
            const vs = variantes(numero);
            const r = await evo(inst, 'chat/whatsappNumbers', { numbers: vs });
            const achou = (Array.isArray(r) ? r : []).find(x => x && x.exists);
            if (achou) return { numero: String(achou.jid || achou.number).split('@')[0].split(':')[0], existe: true };
            return { numero, existe: false };
        } catch (e) {
            log(inst, 'warn', `[Inscrições] Não consegui conferir o WhatsApp de ${numero}: ${e.message}`);
            return { numero, existe: null };
        }
    }

    async function salvarMsg(inst, leadId, id, content, type) {
        await d.fluxoSalvar(inst, leadId, id, content, type);
    }
    async function enviarEtapa(inst, lead, ins, fonte, etapa, passo) {
        const numero = lead.numero;
        if (etapa.tipo === 'texto') {
            const txt = preencher(etapa.texto, ins, fonte);
            if (!txt) return;
            const r = await evo(inst, 'message/sendText', { number: numero, text: txt, delay: 1200 });
            await salvarMsg(inst, lead.id, r?.key?.id, txt, 'text');
            return;
        }
        if (etapa.tipo === 'audio') {
            await evo(inst, 'chat/sendPresence', { number: numero, presence: 'recording', delay: 2000 }).catch(() => {});
            const r = await evo(inst, 'message/sendWhatsAppAudio', { number: numero, audio: etapa.url });
            await salvarMsg(inst, lead.id, r?.key?.id, etapa.url, 'audio');
            return;
        }
        if (['imagem', 'video', 'documento'].includes(etapa.tipo)) {
            const mediatype = { imagem: 'image', video: 'video', documento: 'document' }[etapa.tipo];
            const legenda = preencher(etapa.legenda, ins, fonte);
            const nomeArq = etapa.nome_arquivo || decodeURIComponent(String(etapa.url).split('?')[0].split('/').pop() || 'arquivo');
            const r = await evo(inst, 'message/sendMedia', { number: numero, mediatype, media: etapa.url, caption: legenda, fileName: nomeArq, delay: 1200 });
            await salvarMsg(inst, lead.id, r?.key?.id, etapa.url, mediatype === 'image' ? 'image' : mediatype === 'video' ? 'video' : 'document');
            return;
        }
        if (etapa.tipo === 'botoes') {
            const texto = preencher(etapa.texto, ins, fonte) || 'Como posso te ajudar?';
            const opcoes = etapa.opcoes.map((o, j) => ({ id: `insb:${ins.id}:${passo}:${j}`, titulo: o.titulo }));
            ultimasOpcoes.set(lead.id, { opcoes, at: Date.now() });
            if (ultimasOpcoes.size > 2000) ultimasOpcoes.delete(ultimasOpcoes.keys().next().value);
            await d.enviarOpcoes(inst, lead, texto, opcoes);
            return;
        }
        if (etapa.tipo === 'agenda') {
            const ok = await d.oferecerAgenda(inst, lead, { intro: preencher(etapa.texto, ins, fonte), forcar: true });
            if (!ok) throw Object.assign(new Error('Agenda indisponível para esta conta (ative o recurso Agenda)'), { definitivo: true });
            return;
        }
        if (etapa.tipo === 'menu') {
            const cfgMenu = await d.carregarMenu(inst, true);
            if (!cfgMenu?.ativo && !(cfgMenu?.etapas || []).length) throw Object.assign(new Error('O Menu com Botões não está configurado'), { definitivo: true });
            d.marcarMenuInicio(lead.id, true);
            try { await d.iniciarMenu(inst, lead, cfgMenu); } finally { d.marcarMenuInicio(lead.id, false); }
        }
    }

    // ── contato no CRM ─────────────────────────────────────────────────────────
    async function acharLead(inst, numero) {
        let { data } = await db.from('leads').select('*').eq('instance_name', inst).eq('numero', numero).single();
        if (data) return data;
        for (const v of variantes(numero).slice(1)) {
            ({ data } = await db.from('leads').select('*').eq('instance_name', inst).eq('numero', v).single());
            if (data) return data;
        }
        // Mesmo DDD + mesmos 8 últimos dígitos (cobre o 9º dígito e formatos antigos)
        const m = numero.match(/^55(\d{2})\d*(\d{8})$/);
        if (m) {
            const todos = Object.values(d.getState(inst).leads || {});
            const achado = todos.find(l => { const n = soDigitos(l.numero); return n.startsWith('55' + m[1]) && n.endsWith(m[2]); });
            if (achado) return achado;
        }
        return null;
    }
    const nomeGenerico = n => !n || /^\d+$/.test(n) || /@lid$/.test(n) || ['Contato WhatsApp', 'Lead Avulso', 'Lead Importado', 'Desconhecido', 'Teste do menu'].includes(n);

    async function prepararLead(inst, fonte, ins, numero) {
        const cfg = fonte.config;
        let lead = await acharLead(inst, numero);
        const colunaDestino = cfg.coluna || await d.getPrimeiraColuna(inst);
        const etiquetas = l => String(l?.etiquetas || '').split(',').map(t => t.trim()).filter(Boolean);
        if (!lead) {
            const { data: novo, error } = await db.from('leads').insert({
                instance_name: inst, numero, nome: ins.nome || numero, push_name: null,
                status: colunaDestino, departamento: 'ADM Principal', unread: 0,
                last_msg: `📝 Inscrição pelo site: ${fonte.nome}`, last_interaction: agoraISO(),
                etiquetas: cfg.etiqueta || '', fluxo_feito: 1,
            });
            if (error) throw new Error(error.message || String(error));
            lead = Array.isArray(novo) ? novo[0] : novo;
            return { lead, novo: true };
        }
        const upd = { fluxo_feito: 1 };
        if (ins.nome && nomeGenerico(lead.nome)) upd.nome = ins.nome;
        if (cfg.etiqueta && !etiquetas(lead).includes(cfg.etiqueta)) upd.etiquetas = [...etiquetas(lead), cfg.etiqueta].join(',');
        if (cfg.mover_existente || !lead.status) upd.status = colunaDestino;
        const { data: atual } = await db.from('leads').update(upd).eq('id', lead.id);
        return { lead: (Array.isArray(atual) ? atual[0] : atual) || { ...lead, ...upd }, novo: false };
    }

    async function notificar(inst, titulo, corpo, tipo, leadId) {
        await db.from('dash_notifs').insert({ instance_name: inst, title: titulo, body: corpo, type: tipo || 'info', read: false, criado_por_ia: true, lead_id: leadId || null }).catch(() => {});
    }
    function registrarLog(ins, texto) {
        const lst = jsonParse(ins.fluxo_log, []);
        lst.push({ em: agoraISO(), t: String(texto).slice(0, 300) });
        return JSON.stringify(lst.slice(-40));
    }
    async function atualizar(id, campos) {
        await db.from('inscricoes_site').update({ ...campos, updated_at: agoraISO() }).eq('id', id);
    }
    function emitir(inst, ev) { try { d.wsEmit(inst, { type: 'inscricoes', ...ev }); } catch (e) {} }

    // ── receber uma inscrição ──────────────────────────────────────────────────
    async function receber(fonte, dados, { simulacao = false } = {}) {
        const inst = fonte.instance_name;
        const nome = limpar(dados.nome, 120);
        const telefone = limpar(dados.telefone || dados.whatsapp || dados.celular, 40);
        const numeroDigitado = normalizarNumero(telefone);
        if (!/^55\d{10,11}$/.test(numeroDigitado) && !/^\d{11,15}$/.test(numeroDigitado)) {
            throw Object.assign(new Error('Telefone inválido: informe DDD + número'), { status: 422 });
        }
        const externoId = limpar(dados.externo_id || dados.id, 80) || null;

        // Idempotência: o site pode reenviar a mesma inscrição (rede caiu, retentativa)
        if (externoId) {
            const { data: ja } = await db.from('inscricoes_site').select('*').eq('fonte_id', fonte.id).eq('externo_id', externoId).single();
            if (ja) return { ok: true, id: ja.id, lead_id: ja.lead_id, fluxo_status: ja.fluxo_status, repetida: true };
        }

        // Campos extras do formulário (tudo que não é campo conhecido)
        const conhecidos = ['nome', 'telefone', 'whatsapp', 'celular', 'cidade', 'cidade_estado', 'email', 'externo_id', 'id', 'utm', 'pagina', 'criado_em', 'campos'];
        const campos = {};
        for (const [k, v] of Object.entries(dados.campos && typeof dados.campos === 'object' ? dados.campos : {})) campos[limpar(k, 40)] = limpar(v, 1000);
        for (const [k, v] of Object.entries(dados)) if (!conhecidos.includes(k) && (typeof v === 'string' || typeof v === 'number')) campos[limpar(k, 40)] = limpar(v, 1000);
        const utm = {};
        for (const [k, v] of Object.entries(dados.utm && typeof dados.utm === 'object' ? dados.utm : {})) utm[limpar(k, 40)] = limpar(v, 300);

        const cfg = fonte.config;
        const zap = await resolverWhatsApp(inst, numeroDigitado);
        const numero = zap.numero;

        const ins = {
            instance_name: inst, fonte_id: fonte.id, externo_id: externoId,
            nome, telefone, numero, cidade: limpar(dados.cidade || dados.cidade_estado, 120), email: limpar(dados.email, 160),
            campos: JSON.stringify(campos), utm: JSON.stringify(utm), origem_url: limpar(dados.pagina, 500),
            status: 'novo', fluxo_status: 'agendado', fluxo_passo: 0, fluxo_tentativas: 0, fluxo_erro: null,
            fluxo_snapshot: JSON.stringify({ etapas: cfg.etapas, horario: cfg.horario, parar_se_responder: cfg.parar_se_responder, apos_fluxo: cfg.apos_fluxo }),
            simulacao: simulacao ? 1 : 0,
            created_at: agoraISO(), updated_at: agoraISO(),
        };
        if (dados.criado_em && !isNaN(new Date(dados.criado_em))) ins.criado_no_site = new Date(dados.criado_em).toISOString();

        const { lead, novo } = await prepararLead(inst, fonte, ins, numero);
        ins.lead_id = lead.id;

        // Decide se o fluxo sai e quando
        let motivo = '';
        if (zap.existe === false) { ins.fluxo_status = 'sem_whatsapp'; motivo = 'Número sem WhatsApp'; }
        else if (!fonte.ativo) { ins.fluxo_status = 'desativado'; motivo = 'Fonte desativada no CRM'; }
        else if (!cfg.etapas.length) { ins.fluxo_status = 'sem_fluxo'; motivo = 'Nenhuma mensagem configurada no fluxo'; }
        else if (cfg.reenvio_dias > 0) {
            const desde = new Date(Date.now() - cfg.reenvio_dias * 86400000).toISOString();
            const { data: anteriores } = await db.from('inscricoes_site').select('id,fluxo_status,created_at')
                .eq('lead_id', lead.id).eq('fonte_id', fonte.id).gte('created_at', desde);
            if ((anteriores || []).some(a => ['agendado', 'enviando', 'concluido', 'respondeu', 'aguardando_clique'].includes(a.fluxo_status))) {
                ins.fluxo_status = 'repetida'; motivo = `Já recebeu o fluxo nos últimos ${cfg.reenvio_dias} dia(s)`;
            }
        }
        if (ins.fluxo_status === 'agendado') {
            const quando = ajustarHorario(new Date(Date.now() + cfg.atraso_seg * 1000), cfg.horario);
            ins.fluxo_proximo_em = quando.toISOString();
            ins.fluxo_log = registrarLog(ins, quando.getTime() - Date.now() > 120000
                ? `Fluxo agendado para ${quando.toLocaleString('pt-BR')}` : 'Fluxo agendado');
        } else {
            ins.fluxo_erro = motivo;
            ins.fluxo_log = registrarLog(ins, motivo);
        }

        const { data: criada, error } = await db.from('inscricoes_site').insert(ins);
        if (error) throw new Error(error.message || String(error));
        const row = Array.isArray(criada) ? criada[0] : criada;

        log(inst, 'ok', `[Inscrições] 📝 ${nome || numero} (${fonte.nome}) → ${ins.fluxo_status}${motivo ? ' — ' + motivo : ''}`);
        if (cfg.notificar && !simulacao) {
            const tel = numero.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
            const extra = ins.fluxo_status === 'agendado' ? '' : `\n⚠️ Fluxo não enviado: ${motivo}`;
            await notificar(inst, `📝 Nova inscrição — ${nome || tel}`, `Site: ${fonte.nome}\nWhatsApp: ${tel}${ins.cidade ? `\nCidade: ${ins.cidade}` : ''}${extra}`, ins.fluxo_status === 'sem_whatsapp' ? 'warning' : 'success', lead.id);
        }
        emitir(inst, { event: 'nova', id: row.id, fonte_id: fonte.id, nome, lead_id: lead.id, novo_lead: novo });
        setTimeout(() => processarFila().catch(() => {}), 1500);
        return { ok: true, id: row.id, lead_id: lead.id, fluxo_status: ins.fluxo_status, motivo: motivo || undefined, whatsapp: zap.existe };
    }

    // ── fila do fluxo ──────────────────────────────────────────────────────────
    async function clienteRespondeuDesde(leadId, desdeISO) {
        try {
            const { data } = await db.from('messages').select('id').eq('lead_id', leadId).eq('from_me', false).gte('created_at', desdeISO).limit(1);
            return (data || []).length > 0;
        } catch (e) { return false; }
    }

    async function processarUma(ins) {
        if (emAndamento.has(ins.id)) return;
        emAndamento.add(ins.id);
        const inst = ins.instance_name;
        try {
            const { data: fonteRow } = await db.from('inscricoes_fontes').select('*').eq('id', ins.fonte_id).single();
            if (!fonteRow) { await atualizar(ins.id, { fluxo_status: 'cancelado', fluxo_erro: 'Fonte excluída', fluxo_log: registrarLog(ins, 'Cancelado: fonte excluída') }); return; }
            const fonte = { ...fonteRow, config: { ...configPadrao(), ...jsonParse(fonteRow.config, {}) } };
            const snap = jsonParse(ins.fluxo_snapshot, null) || fonte.config;
            const etapas = snap.etapas || [];
            const passo = parseInt(ins.fluxo_passo) || 0;

            const { data: lead } = await db.from('leads').select('*').eq('id', ins.lead_id).single();
            if (!lead) { await atualizar(ins.id, { fluxo_status: 'cancelado', fluxo_erro: 'Contato excluído do CRM', fluxo_log: registrarLog(ins, 'Cancelado: contato excluído') }); return; }

            // Horário de envio
            const permitido = ajustarHorario(new Date(), snap.horario);
            if (permitido.getTime() - Date.now() > 60000) {
                await atualizar(ins.id, { fluxo_proximo_em: permitido.toISOString(), fluxo_log: registrarLog(ins, `Fora do horário de envio — reagendado para ${permitido.toLocaleString('pt-BR')}`) });
                return;
            }
            // Atendente assumiu a conversa → não manda mais nada automático
            if (d.getState(inst).humanoAtivo?.[lead.id]) {
                await atualizar(ins.id, { fluxo_status: 'interrompido', fluxo_erro: 'Atendente assumiu a conversa', fluxo_log: registrarLog(ins, 'Interrompido: atendente assumiu a conversa') });
                emitir(inst, { event: 'atualizada', id: ins.id });
                return;
            }
            // Cliente já respondeu → as próximas mensagens não saem (a conversa segue com a IA/equipe)
            if (passo > 0 && snap.parar_se_responder !== false && ins.fluxo_iniciado_em && await clienteRespondeuDesde(lead.id, ins.fluxo_iniciado_em)) {
                await atualizar(ins.id, { fluxo_status: 'respondeu', fluxo_log: registrarLog(ins, `Cliente respondeu — ${etapas.length - passo} mensagem(ns) restante(s) não enviada(s)`) });
                emitir(inst, { event: 'atualizada', id: ins.id });
                return;
            }
            const etapa = etapas[passo];
            if (!etapa) { await concluir(ins, lead, snap); return; }

            await atualizar(ins.id, { fluxo_status: 'enviando', ...(passo === 0 ? { fluxo_iniciado_em: agoraISO() } : {}) });
            if (passo === 0) ins.fluxo_iniciado_em = agoraISO();
            try {
                await enviarEtapa(inst, lead, ins, fonte, etapa, passo);
            } catch (e) {
                const tent = (parseInt(ins.fluxo_tentativas) || 0) + 1;
                if (e.definitivo || tent > RETENTATIVAS_MIN.length) {
                    await atualizar(ins.id, { fluxo_status: 'erro', fluxo_tentativas: tent, fluxo_erro: e.message, fluxo_log: registrarLog(ins, `Erro na mensagem ${passo + 1}: ${e.message}`) });
                    await notificar(inst, `⚠️ Fluxo do site não enviado — ${ins.nome || lead.numero}`, `Mensagem ${passo + 1}: ${e.message}`, 'warning', lead.id);
                    log(inst, 'erro', `[Inscrições] Fluxo de ${ins.nome || lead.numero} parou: ${e.message}`);
                } else {
                    const min = RETENTATIVAS_MIN[tent - 1];
                    await atualizar(ins.id, { fluxo_status: 'agendado', fluxo_tentativas: tent, fluxo_erro: e.message,
                        fluxo_proximo_em: new Date(Date.now() + min * 60000).toISOString(),
                        fluxo_log: registrarLog(ins, `Falha na mensagem ${passo + 1} (${e.message}) — nova tentativa em ${min} min`) });
                    log(inst, 'warn', `[Inscrições] Falha ao enviar para ${ins.nome || lead.numero}: ${e.message} — tentando de novo em ${min} min`);
                }
                emitir(inst, { event: 'atualizada', id: ins.id });
                return;
            }

            const proximo = passo + 1;
            const logTxt = registrarLog(ins, `Mensagem ${proximo}/${etapas.length} enviada (${etapa.tipo})`);
            if (proximo >= etapas.length) {
                ins.fluxo_log = logTxt;
                await concluir({ ...ins, fluxo_passo: proximo }, lead, snap, etapa);
                return;
            }
            const espera = Math.max(parseInt(etapas[proximo].espera_seg) || 0, 0);
            const quando = ajustarHorario(new Date(Date.now() + Math.max(espera, 2) * 1000), snap.horario);
            await atualizar(ins.id, { fluxo_status: 'agendado', fluxo_passo: proximo, fluxo_tentativas: 0, fluxo_erro: null, fluxo_proximo_em: quando.toISOString(), fluxo_log: logTxt });
            emitir(inst, { event: 'atualizada', id: ins.id });
            // Próxima mensagem em menos de 1 min: não espera a volta da fila (10 s)
            const ms = quando.getTime() - Date.now();
            if (ms < 60000) setTimeout(() => processarFila().catch(() => {}), Math.max(ms, 0) + 300);
        } catch (e) {
            log(inst, 'erro', `[Inscrições] Erro inesperado no fluxo ${ins.id}: ${e.message}`);
            await atualizar(ins.id, { fluxo_status: 'agendado', fluxo_proximo_em: new Date(Date.now() + 5 * 60000).toISOString(), fluxo_erro: e.message }).catch(() => {});
        } finally {
            emAndamento.delete(ins.id);
        }
    }

    async function concluir(ins, lead, snap, ultimaEtapa) {
        const inst = ins.instance_name;
        const aguardando = ultimaEtapa && ultimaEtapa.tipo === 'botoes';
        await atualizar(ins.id, { fluxo_status: aguardando ? 'aguardando_clique' : 'concluido', fluxo_passo: ins.fluxo_passo, fluxo_tentativas: 0, fluxo_erro: null, fluxo_concluido_em: agoraISO(),
            fluxo_log: ins.fluxo_log || registrarLog(ins, 'Fluxo concluído') });
        if (snap.apos_fluxo === 'pausar_ia') {
            const s = d.getState(inst);
            s.humanoAtivo = s.humanoAtivo || {};
            s.humanoAtivo[lead.id] = true;
            d.salvarPausaDB(inst, lead.id, true, 'Inscrição do site: aguardando atendente');
        }
        log(inst, 'ok', `[Inscrições] ✅ Fluxo concluído — ${ins.nome || lead.numero}`);
        emitir(inst, { event: 'atualizada', id: ins.id });
    }

    let rodando = false;
    async function processarFila() {
        if (rodando) return;
        rodando = true;
        try {
            const agora = agoraISO();
            const { data } = await db.from('inscricoes_site').select('*').eq('fluxo_status', 'agendado').lte('fluxo_proximo_em', agora).order('fluxo_proximo_em', { ascending: true }).limit(20);
            for (const ins of data || []) await processarUma(ins);
            // Envios que travaram no meio (servidor reiniciou durante o envio) voltam para a fila
            const limite = new Date(Date.now() - 10 * 60000).toISOString();
            const { data: presos } = await db.from('inscricoes_site').select('id,updated_at').eq('fluxo_status', 'enviando').lte('updated_at', limite).limit(20);
            for (const p of presos || []) if (!emAndamento.has(p.id)) await atualizar(p.id, { fluxo_status: 'agendado', fluxo_proximo_em: agoraISO() });
        } catch (e) {
            console.error('[Inscrições] fila:', e.message);
        } finally { rodando = false; }
    }

    // ── cliques nos botões do fluxo ────────────────────────────────────────────
    // Retorna { consumida: true } ou { consumida: false, contexto } ou null (não é deste módulo)
    async function processarResposta(inst, lead, msg) {
        if (!lead || msg.type !== 'text') return null;
        let id = msg.id ? d.botaoId(msg.id) : null;
        if (!id || !String(id).startsWith('insb:')) {
            const ult = ultimasOpcoes.get(lead.id);
            if (!ult || Date.now() - ult.at > 3 * 86400000) return null;
            const t = String(msg.content || '').trim().toLowerCase();
            const n = t.match(/^(\d{1,2})$/);
            const op = (n && ult.opcoes[parseInt(n[1]) - 1]) || ult.opcoes.find(o => o.titulo.toLowerCase() === t);
            if (!op) return null;
            id = op.id;
        }
        const [, insId, passoTxt, optTxt] = String(id).split(':');
        const { data: ins } = await db.from('inscricoes_site').select('*').eq('id', insId).single();
        if (!ins || ins.instance_name !== inst) return null;
        const snap = jsonParse(ins.fluxo_snapshot, {});
        const etapa = (snap.etapas || [])[parseInt(passoTxt)];
        const op = etapa?.opcoes?.[parseInt(optTxt)];
        if (!op) return null;
        const { data: fonteRow } = await db.from('inscricoes_fontes').select('*').eq('id', ins.fonte_id).single();
        const fonte = fonteRow ? { ...fonteRow, config: { ...configPadrao(), ...jsonParse(fonteRow.config, {}) } } : { nome: 'site', config: configPadrao() };
        ultimasOpcoes.delete(lead.id);
        log(inst, 'ok', `[Inscrições] 👆 ${ins.nome || lead.numero} escolheu "${op.titulo}"`);
        await atualizar(ins.id, { fluxo_status: ins.fluxo_status === 'aguardando_clique' ? 'concluido' : ins.fluxo_status, escolha: op.titulo, fluxo_log: registrarLog(ins, `Cliente tocou em "${op.titulo}"`) });
        emitir(inst, { event: 'atualizada', id: ins.id });

        const resposta = preencher(op.resposta, ins, fonte);
        if (resposta) {
            try { const r = await evo(inst, 'message/sendText', { number: lead.numero, text: resposta, delay: 1000 }); await salvarMsg(inst, lead.id, r?.key?.id, resposta, 'text'); }
            catch (e) { log(inst, 'erro', `[Inscrições] Resposta do botão não enviada: ${e.message}`); }
        }
        if (op.acao === 'agenda') {
            const ok = await d.oferecerAgenda(inst, lead, { forcar: true }).catch(() => false);
            if (ok) return { consumida: true };
            return { consumida: false, contexto: `O cliente tocou em "${op.titulo}" (quer agendar). Ajude-o a marcar um horário.` };
        }
        if (op.acao === 'humano') {
            const s = d.getState(inst);
            s.humanoAtivo = s.humanoAtivo || {};
            s.humanoAtivo[lead.id] = true;
            d.salvarPausaDB(inst, lead.id, true, 'Inscrição do site: pediu atendente');
            await notificar(inst, `🙋 ${ins.nome || lead.numero} pediu atendimento`, `Tocou em "${op.titulo}" no fluxo do site ${fonte.nome}. A IA foi pausada para este contato.`, 'warning', lead.id);
            return { consumida: true };
        }
        if (op.acao === 'texto') return { consumida: true };
        return { consumida: false, contexto: [`O cliente tocou no botão "${op.titulo}".`, op.contexto_ia].filter(Boolean).join(' ') };
    }

    // Contexto que a IA recebe sobre a inscrição (até 90 dias depois)
    async function contextoIA(inst, lead) {
        try {
            const desde = new Date(Date.now() - 90 * 86400000).toISOString();
            const { data } = await db.from('inscricoes_site').select('*').eq('instance_name', inst).eq('lead_id', lead.id).gte('created_at', desde).order('created_at', { ascending: false }).limit(1);
            const ins = (data || [])[0];
            if (!ins) return '';
            const { data: fonteRow } = await db.from('inscricoes_fontes').select('*').eq('id', ins.fonte_id).single();
            if (!fonteRow) return '';
            const cfg = { ...configPadrao(), ...jsonParse(fonteRow.config, {}) };
            if (!String(cfg.contexto_ia || '').trim()) return '';
            const campos = jsonParse(ins.campos, {});
            const extras = Object.entries(campos).map(([k, v]) => `${k}: ${v}`).join('; ');
            return `INSCRIÇÃO PELO SITE (informação interna, não repita literalmente): ${preencher(cfg.contexto_ia, ins, fonteRow)}${extras ? ` Outros dados do formulário: ${extras}.` : ''}${ins.escolha ? ` No fluxo, ele tocou em "${ins.escolha}".` : ''}`;
        } catch (e) { return ''; }
    }

    // ── HTTP ───────────────────────────────────────────────────────────────────
    async function exigirConta(inst) {
        if (!inst) throw Object.assign(new Error('inst obrigatório'), { status: 400 });
        const { data } = await db.from('licenses').select('id').eq('instance_name', inst).single();
        if (!data) throw Object.assign(new Error('Conta não encontrada'), { status: 404 });
    }
    function limitarIp(req, max = 120, janelaMs = 60000) {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const agora = Date.now();
        const reg = (limiteIp.get(ip) || []).filter(t => agora - t < janelaMs);
        reg.push(agora); limiteIp.set(ip, reg);
        if (limiteIp.size > 5000) limiteIp.delete(limiteIp.keys().next().value);
        return reg.length <= max;
    }
    const ROTULO_FLUXO = {
        agendado: 'Agendado', enviando: 'Enviando', concluido: 'Concluído', aguardando_clique: 'Aguardando clique', respondeu: 'Cliente respondeu',
        interrompido: 'Atendente assumiu', erro: 'Erro', cancelado: 'Cancelado', sem_whatsapp: 'Sem WhatsApp', repetida: 'Repetida',
        desativado: 'Fonte desativada', sem_fluxo: 'Sem fluxo',
    };

    async function handle(req, res) {
        const url = new URL(req.url, 'http://x');
        const rota = url.pathname;
        if (!rota.startsWith('/api/inscricoes')) return false;
        try {
            // ── públicas (Admin do site) ──
            if (rota === '/api/inscricoes/ping' || rota === '/api/inscricoes/receber' || rota === '/api/inscricoes/consultar') {
                if (!limitarIp(req)) return responder(res, 429, { ok: false, error: 'Muitas requisições, aguarde um minuto' }), true;
                const fonte = await fontePorToken(tokenDaRequisicao(req));
                if (!fonte) return responder(res, 401, { ok: false, error: 'Código de conexão inválido ou revogado' }), true;
                if (rota === '/api/inscricoes/ping') {
                    return responder(res, 200, { ok: true, fonte: fonte.nome, ativo: fonte.ativo, conta: fonte.instance_name, etapas: fonte.config.etapas.length }), true;
                }
                if (req.method !== 'POST') return responder(res, 405, { ok: false, error: 'Use POST' }), true;
                const body = await lerCorpo(req);
                if (rota === '/api/inscricoes/consultar') {
                    const ids = (Array.isArray(body.ids) ? body.ids : []).map(x => limpar(x, 80)).filter(Boolean).slice(0, 200);
                    const out = {};
                    for (const eid of ids) {
                        const { data } = await db.from('inscricoes_site').select('id,externo_id,status,fluxo_status,fluxo_erro,escolha,lead_id').eq('fonte_id', fonte.id).eq('externo_id', eid).single();
                        if (data) out[eid] = { status: data.status, fluxo_status: data.fluxo_status, fluxo_rotulo: ROTULO_FLUXO[data.fluxo_status] || data.fluxo_status, erro: data.fluxo_erro || null, escolha: data.escolha || null };
                    }
                    return responder(res, 200, { ok: true, itens: out }), true;
                }
                const r = await receber(fonte, body);
                return responder(res, 200, r), true;
            }

            // ── internas (tela do CRM) ──
            if (rota === '/api/inscricoes/fontes' && req.method === 'GET') {
                const inst = url.searchParams.get('inst');
                await exigirConta(inst);
                const fontes = await listarFontes(inst);
                const base = urlPublica(req);
                const { data: todas } = await db.from('inscricoes_site').select('fonte_id,fluxo_status,created_at').eq('instance_name', inst);
                const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
                const out = fontes.map(f => {
                    const minhas = (todas || []).filter(x => x.fonte_id === f.id);
                    return {
                        ...f, codigo: codigoConexao(base, f.token), url_crm: base,
                        total: minhas.length,
                        hoje: minhas.filter(x => new Date(x.created_at) >= hoje).length,
                        erros: minhas.filter(x => ['erro', 'sem_whatsapp'].includes(x.fluxo_status)).length,
                        na_fila: minhas.filter(x => ['agendado', 'enviando'].includes(x.fluxo_status)).length,
                    };
                });
                return responder(res, 200, { ok: true, fontes: out, url_crm: base }), true;
            }
            if (rota === '/api/inscricoes/exportar' && req.method === 'GET') {
                const inst = url.searchParams.get('inst');
                await exigirConta(inst);
                let q = db.from('inscricoes_site').select('*').eq('instance_name', inst);
                if (url.searchParams.get('fonte')) q = q.eq('fonte_id', url.searchParams.get('fonte'));
                const { data } = await q.order('created_at', { ascending: false });
                const cols = ['created_at', 'nome', 'telefone', 'numero', 'cidade', 'email', 'status', 'fluxo_status', 'escolha', 'campos', 'utm', 'origem_url'];
                const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
                const linhas = [cols.join(';'), ...(data || []).map(r => cols.map(c => esc(c === 'created_at' ? new Date(r[c]).toLocaleString('pt-BR') : c === 'fluxo_status' ? (ROTULO_FLUXO[r[c]] || r[c]) : r[c])).join(';'))];
                res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inscricoes-${new Date().toISOString().slice(0, 10)}.csv"` });
                res.end('﻿' + linhas.join('\r\n'));
                return true;
            }
            if (rota === '/api/inscricoes/lista' && req.method === 'GET') {
                const inst = url.searchParams.get('inst');
                await exigirConta(inst);
                let q = db.from('inscricoes_site').select('*').eq('instance_name', inst);
                const fonte = url.searchParams.get('fonte'); if (fonte) q = q.eq('fonte_id', fonte);
                const status = url.searchParams.get('status'); if (status) q = q.eq('status', status);
                const fluxo = url.searchParams.get('fluxo'); if (fluxo) q = q.eq('fluxo_status', fluxo);
                const de = url.searchParams.get('de'); if (de) q = q.gte('created_at', new Date(de + 'T00:00:00').toISOString());
                const ate = url.searchParams.get('ate'); if (ate) q = q.lte('created_at', new Date(ate + 'T23:59:59').toISOString());
                let { data } = await q.order('created_at', { ascending: false });
                data = data || [];
                const busca = String(url.searchParams.get('q') || '').trim().toLowerCase();
                if (busca) {
                    const dig = soDigitos(busca);
                    data = data.filter(r => [r.nome, r.cidade, r.email, r.telefone].some(v => String(v || '').toLowerCase().includes(busca)) || (dig.length >= 4 && soDigitos(r.numero).includes(dig)));
                }
                const pagina = Math.max(parseInt(url.searchParams.get('pagina')) || 1, 1);
                const porPagina = 50;
                const itens = data.slice((pagina - 1) * porPagina, pagina * porPagina).map(r => ({
                    ...r, campos: jsonParse(r.campos, {}), utm: jsonParse(r.utm, {}), fluxo_log: jsonParse(r.fluxo_log, []), fluxo_snapshot: undefined,
                    fluxo_rotulo: ROTULO_FLUXO[r.fluxo_status] || r.fluxo_status,
                    total_etapas: (jsonParse(r.fluxo_snapshot, {}).etapas || []).length,
                }));
                return responder(res, 200, { ok: true, itens, total: data.length, pagina, paginas: Math.max(Math.ceil(data.length / porPagina), 1) }), true;
            }
            if (req.method === 'POST' && ['/api/inscricoes/fontes', '/api/inscricoes/fontes/token', '/api/inscricoes/fontes/excluir', '/api/inscricoes/acao', '/api/inscricoes/simular'].includes(rota)) {
                const b = await lerCorpo(req);
                const inst = limpar(b.inst, 80);
                await exigirConta(inst);
                if (rota === '/api/inscricoes/fontes') {
                    const f = b.fonte || {};
                    const nome = limpar(f.nome, 80) || 'Meu site';
                    const config = sanitizarConfig(f.config);
                    if (f.id) {
                        const { data: atual } = await db.from('inscricoes_fontes').select('*').eq('id', f.id).single();
                        if (!atual || atual.instance_name !== inst) throw Object.assign(new Error('Fonte não encontrada'), { status: 404 });
                        await db.from('inscricoes_fontes').update({ nome, ativo: f.ativo === false ? 0 : 1, config: JSON.stringify(config), updated_at: agoraISO() }).eq('id', f.id);
                        log(inst, 'ok', `[Inscrições] Fonte "${nome}" salva (${config.etapas.length} mensagem(ns))`);
                        return responder(res, 200, { ok: true, id: f.id }), true;
                    }
                    const { data: nova, error } = await db.from('inscricoes_fontes').insert({ instance_name: inst, nome, token: novoToken(), ativo: f.ativo === false ? 0 : 1, config: JSON.stringify(config), updated_at: agoraISO() });
                    if (error) throw new Error(error.message || String(error));
                    const row = Array.isArray(nova) ? nova[0] : nova;
                    log(inst, 'ok', `[Inscrições] Nova fonte "${nome}" criada`);
                    return responder(res, 200, { ok: true, id: row.id }), true;
                }
                const { data: fonteRow } = b.id || b.fonte_id ? await db.from('inscricoes_fontes').select('*').eq('id', b.fonte_id || b.id).single() : { data: null };
                if (rota === '/api/inscricoes/fontes/token') {
                    if (!fonteRow || fonteRow.instance_name !== inst) throw Object.assign(new Error('Fonte não encontrada'), { status: 404 });
                    await db.from('inscricoes_fontes').update({ token: novoToken(), updated_at: agoraISO() }).eq('id', fonteRow.id);
                    log(inst, 'warn', `[Inscrições] Código de conexão da fonte "${fonteRow.nome}" foi trocado`);
                    return responder(res, 200, { ok: true }), true;
                }
                if (rota === '/api/inscricoes/fontes/excluir') {
                    if (!fonteRow || fonteRow.instance_name !== inst) throw Object.assign(new Error('Fonte não encontrada'), { status: 404 });
                    await db.from('inscricoes_site').update({ fluxo_status: 'cancelado', fluxo_erro: 'Fonte excluída' }).eq('fonte_id', fonteRow.id).eq('fluxo_status', 'agendado');
                    if (b.apagar_inscricoes) await db.from('inscricoes_site').delete().eq('fonte_id', fonteRow.id);
                    await db.from('inscricoes_fontes').delete().eq('id', fonteRow.id);
                    return responder(res, 200, { ok: true }), true;
                }
                if (rota === '/api/inscricoes/simular') {
                    if (!fonteRow || fonteRow.instance_name !== inst) throw Object.assign(new Error('Fonte não encontrada'), { status: 404 });
                    const fonte = { ...fonteRow, ativo: !!fonteRow.ativo, config: { ...configPadrao(), ...jsonParse(fonteRow.config, {}) } };
                    const r = await receber(fonte, { nome: b.nome || 'Teste', telefone: b.telefone, cidade: b.cidade || '', campos: { teste: 'sim' } }, { simulacao: true });
                    return responder(res, 200, r), true;
                }
                if (rota === '/api/inscricoes/acao') {
                    const { data: ins } = await db.from('inscricoes_site').select('*').eq('id', b.id).single();
                    if (!ins || ins.instance_name !== inst) throw Object.assign(new Error('Inscrição não encontrada'), { status: 404 });
                    const acao = b.acao;
                    if (acao === 'status') {
                        if (!STATUS_INSCRICAO.includes(b.valor)) throw Object.assign(new Error('Status inválido'), { status: 400 });
                        await atualizar(ins.id, { status: b.valor });
                    } else if (acao === 'observacao') {
                        await atualizar(ins.id, { observacao: limpar(b.valor, 3000) });
                    } else if (acao === 'cancelar') {
                        if (!['agendado', 'enviando'].includes(ins.fluxo_status)) throw Object.assign(new Error('Este fluxo não está na fila'), { status: 400 });
                        await atualizar(ins.id, { fluxo_status: 'cancelado', fluxo_log: registrarLog(ins, 'Cancelado manualmente no CRM') });
                    } else if (acao === 'reenviar') {
                        // Recomeça do zero com o fluxo ATUAL da fonte
                        const { data: fr } = await db.from('inscricoes_fontes').select('*').eq('id', ins.fonte_id).single();
                        if (!fr) throw Object.assign(new Error('A fonte desta inscrição foi excluída'), { status: 400 });
                        const cfg = { ...configPadrao(), ...jsonParse(fr.config, {}) };
                        if (!cfg.etapas.length) throw Object.assign(new Error('O fluxo desta fonte não tem mensagens'), { status: 400 });
                        if (!ins.lead_id) throw Object.assign(new Error('Inscrição sem contato no CRM'), { status: 400 });
                        // Pode ter sido "sem WhatsApp" por instabilidade: confere de novo
                        const zap = await resolverWhatsApp(inst, ins.numero);
                        if (zap.existe === false) throw Object.assign(new Error('Este número não tem WhatsApp'), { status: 400 });
                        if (zap.numero !== ins.numero) await db.from('leads').update({ numero: zap.numero }).eq('id', ins.lead_id);
                        await atualizar(ins.id, { numero: zap.numero, fluxo_status: 'agendado', fluxo_passo: 0, fluxo_tentativas: 0, fluxo_erro: null, fluxo_iniciado_em: null,
                            fluxo_proximo_em: agoraISO(), fluxo_snapshot: JSON.stringify({ etapas: cfg.etapas, horario: cfg.horario, parar_se_responder: cfg.parar_se_responder, apos_fluxo: cfg.apos_fluxo }),
                            fluxo_log: registrarLog(ins, 'Reenvio solicitado no CRM') });
                        setTimeout(() => processarFila().catch(() => {}), 500);
                    } else if (acao === 'excluir') {
                        await db.from('inscricoes_site').delete().eq('id', ins.id);
                    } else throw Object.assign(new Error('Ação inválida'), { status: 400 });
                    emitir(inst, { event: 'atualizada', id: ins.id });
                    return responder(res, 200, { ok: true }), true;
                }
            }
            return responder(res, 404, { ok: false, error: 'Rota não encontrada' }), true;
        } catch (e) {
            if (!res.headersSent) responder(res, e.status || 500, { ok: false, error: e.message });
            if (!e.status || e.status >= 500) console.error('[Inscrições]', e);
            return true;
        }
    }

    let timer = null;
    function iniciar() {
        if (timer) return;
        timer = setInterval(() => processarFila().catch(() => {}), 10000);
        setTimeout(() => processarFila().catch(() => {}), 5000);
    }

    return { handle, processarResposta, contextoIA, iniciar, processarFila, _teste: { normalizarNumero, variantes, ajustarHorario, preencher, sanitizarConfig } };
};
