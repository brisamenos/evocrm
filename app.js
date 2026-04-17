// ╔══════════════════════════════════════════════════════════════╗
// ║  EvoCRM — Storage Local via server.js                        ║
// ║  Configure apenas 1 variável:                                ║
// ║    SERVER_URL → URL pública do seu server.js no EasyPanel    ║
// ╚══════════════════════════════════════════════════════════════╝
const SERVER_URL = window.location.origin; // ✅ URL dinâmica — funciona em qualquer ambiente

// ─── CLIENTE REST LOCAL — substitui supabase-js no browser ───────────────────
// Emula a interface do supabase-js: client.from('table').select().eq().single() etc.
// Todas as chamadas vão para POST /api/db no server.js, que executa no PostgreSQL local.
function makeDbClient(serverUrl) {
    function from(table) {
        return new DbQueryBuilder(serverUrl, table);
    }
    return { from };
}

class DbQueryBuilder {
    constructor(serverUrl, table) {
        this._url = serverUrl;
        this._table = table;
        this._op = 'select';
        this._select = '*';
        this._filters = [];
        this._order = null;
        this._limit = null;
        this._single = false;
        this._data = null;
        this._upsertConflict = null;
    }

    select(cols = '*') { this._select = cols; return this; }
    eq(col, val)  { this._filters.push({ op: 'eq', col, val }); return this; }
    neq(col, val) { this._filters.push({ op: 'neq', col, val }); return this; }
    gte(col, val) { this._filters.push({ op: 'gte', col, val }); return this; }
    lte(col, val) { this._filters.push({ op: 'lte', col, val }); return this; }
    in(col, val)  { this._filters.push({ op: 'in', col, val }); return this; }
    order(col, opts = {}) { this._order = { col, ascending: opts.ascending ?? true }; return this; }
    limit(n)  { this._limit = n; return this; }
    single()  { this._single = true; return this; }

    insert(data)  { this._op = 'insert'; this._data = data; return this; }
    update(data)  { this._op = 'update'; this._data = data; return this; }
    delete()      { this._op = 'delete'; return this; }
    upsert(data, opts = {}) { this._op = 'upsert'; this._data = data; this._upsertConflict = opts.onConflict || null; return this; }

    async _execute() {
        const body = {
            table: this._table, op: this._op, select: this._select,
            filters: this._filters, data: this._data,
            order: this._order, limit: this._limit,
            single: this._single, upsertConflict: this._upsertConflict,
        };
        const res = await fetch(`${this._url}/api/db`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return res.json();
    }

    then(resolve, reject) { return this._execute().then(resolve, reject); }
    catch(reject) { return this._execute().catch(reject); }
}

// Monta a URL pública de um arquivo já salvo
function localPublicUrl(path) {
    return `${SERVER_URL}/uploads/${path.replace(/^\/+/, '')}`;
}

// Detecta se uma string é URL de storage (local ou Supabase legado)
function isStorageUrl(str) {
    return str && (str.includes(SERVER_URL) || str.includes('/uploads/') || str.includes('supabase.co/storage'));
}

// Faz upload de um File/Blob para o server.js via multipart e retorna a URL pública
async function localUpload(path, file, contentType) {
    const form = new FormData();
    form.append('path', path);
    form.append('file', file, file.name || path.split('/').pop());
    if (contentType) form.append('contentType', contentType);
    const res = await fetch(`${SERVER_URL}/local-upload`, { method: 'POST', body: form });
    if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`Upload falhou (${res.status}): ${msg}`);
    }
    const json = await res.json();
    return json.url;
}

function crmApp() {
            return {
                screen: 'chats',
                appState: 'login', 
                loginInput: '',
                loginKey: '',
                instanceName: localStorage.getItem('evo_instance') || '',
                clientePlano: localStorage.getItem('evo_plano') || 'basico',
                clienteFeatures: JSON.parse(localStorage.getItem('evo_features') || 'null'),
                clienteExpiresAt: localStorage.getItem('evo_expires_at') || null,
                clienteIsTrial: localStorage.getItem('evo_is_trial') === 'true',
                clienteRenewalUrl: localStorage.getItem('evo_renewal_url') || null,
                trialToastDismissed: false,

                // ── MODAL DE RENOVAÇÃO ──
                renewModal: false,
                renewStep: 'planos',       // planos | form | pix | sucesso | erro
                renewPlanos: [],
                renewPlanoSelecionado: null,
                renewLoading: false,
                renewErroForm: '',
                renewErroMsg: '',
                renewPedidoId: '',
                renewMpPaymentId: '',
                renewPixCopiaECola: '',
                renewPixQrBase64: '',
                renewValorPix: 0,
                renewPixCopiado: false,
                renewContadorPix: '30:00',
                renewContadorTimer: null,
                renewPollTimer: null,
                renewForm: { nome: '', email: '', whatsapp: '', cpf: '' },
                MP_ACCESS_TOKEN_RENEW: 'APP_USR-551634858809999-031000-b35ffaf8d2252b304ece7d763c723ec4-569868834',

                // ── PERMISSÕES POR PLANO / FEATURES ──
                // Quando features foi salvo explicitamente no banco → é a fonte da verdade.
                // Feature não listada = desativada. Sem features salvas → usa defaults do plano.
                _planoPadrao: {
                    basico:   [],
                    premium:  ['bot','disparo','agenda','setores'],
                    platinum: ['bot','disparo','agenda','setores','ia_atendimento','audio_ia'],
                },
                _temFeature(id) {
                    if (this.clienteFeatures && typeof this.clienteFeatures === 'object' && Object.keys(this.clienteFeatures).length > 0) {
                        return this.clienteFeatures[id] === true;
                    }
                    return (this._planoPadrao[this.clientePlano] || []).includes(id);
                },

                // Toast de upgrade para feature bloqueada
                _toastUpgrade(label) {
                    this.addNotification('🔒 Função bloqueada', `"${label}" requer upgrade. Fale com o proprietário.`, 'warn');
                },
                get planoBadge() {
                    const b = { basico: '🥉 Básico', premium: '🥈 Premium', platinum: '🥇 Platinum', custom: '⚙️ Personalizado' };
                    return b[this.clientePlano] || '⚙️ Personalizado';
                },

                get diasRestantes() {
                    if (!this.clienteExpiresAt) return null;
                    const diff = new Date(this.clienteExpiresAt) - new Date();
                    return Math.max(0, Math.ceil(diff / 86400000));
                },

                get trialAtivo() {
                    if (!this.clienteIsTrial) return false;
                    if (!this.clienteExpiresAt) return true;
                    return new Date(this.clienteExpiresAt) > new Date();
                },

                get mostrarToastTrial() {
                    if (!this.trialAtivo && !this.clienteIsTrial) return false;
                    if (this.trialToastDismissed) return false;
                    // Mostra sempre em trial; ou quando restam <= 7 dias
                    if (this.clienteIsTrial) return true;
                    return this.diasRestantes !== null && this.diasRestantes <= 7;
                },

                abrirRenovacao() {
                    // Carrega planos do Supabase para o modal
                    this.renewModal = true;
                    this.renewStep = 'planos';
                    this.renewPlanoSelecionado = null;
                    this.renewErroForm = '';
                    this.renewErroMsg = '';
                    this.renewForm = { nome: '', email: '', whatsapp: '', cpf: '' };
                    this._carregarPlanosRenovacao();
                    setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 80);
                },

                fecharRenovacaoModal() {
                    this.renewModal = false;
                    clearTimeout(this.renewPollTimer);
                    clearInterval(this.renewContadorTimer);
                },

                async _carregarPlanosRenovacao() {
                    // Planos padrão alinhados com Evolution
                    const planosDefault = [
                        {
                            id_slug: 'basico', nome: 'Básico', descricao: 'CRM apenas',
                            preco: 67, cor: '#94a3b8',
                            icon: 'shield',
                            features: [
                                { text: 'CRM de conversas WhatsApp', on: true },
                                { text: 'Funil Kanban de leads', on: true },
                                { text: '1 número WhatsApp', on: true },
                                { text: 'Histórico de mensagens', on: true },
                                { text: 'Departamentos / Setores', on: false },
                                { text: 'Automação (Bot)', on: false },
                                { text: 'Disparo em Massa', on: false },
                                { text: 'Agenda', on: false },
                                { text: 'IA de Atendimento 24/7', on: false },
                            ]
                        },
                        {
                            id_slug: 'premium', nome: 'Premium', descricao: '+ Automação',
                            preco: 97, cor: '#818cf8', popular: true,
                            icon: 'star',
                            features: [
                                { text: 'CRM de conversas WhatsApp', on: true },
                                { text: 'Funil Kanban de leads', on: true },
                                { text: '3 números WhatsApp', on: true },
                                { text: 'Departamentos / Setores', on: true },
                                { text: 'Automação (Bot)', on: true },
                                { text: 'Disparo em Massa', on: true },
                                { text: 'Agenda', on: true },
                                { text: 'IA de Atendimento 24/7', on: false },
                                { text: 'Áudio IA (TTS)', on: false },
                            ]
                        },
                        {
                            id_slug: 'platinum', nome: 'Platinum', descricao: 'Tudo liberado',
                            preco: 197, cor: '#c4b5fd',
                            icon: 'crown',
                            features: [
                                { text: 'CRM de conversas WhatsApp', on: true },
                                { text: 'Funil Kanban de leads', on: true },
                                { text: 'Números ilimitados', on: true },
                                { text: 'Departamentos / Setores', on: true },
                                { text: 'Automação (Bot)', on: true },
                                { text: 'Disparo em Massa', on: true },
                                { text: 'Agenda', on: true },
                                { text: 'IA de Atendimento 24/7', on: true },
                                { text: 'Áudio IA (TTS)', on: true },
                            ]
                        },
                    ];
                    try {
                        const { data, error } = await this.client.from('planos').select('*').order('ordem', { ascending: true });
                        if (!error && data?.length > 0) {
                            this.renewPlanos = data;
                            return;
                        }
                    } catch(e) {}
                    this.renewPlanos = planosDefault;
                },

                renewSelecionarPlano(plano) {
                    this.renewPlanoSelecionado = plano;
                    this.renewStep = 'form';
                    setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 80);
                },

                async renewGerarPix() {
                    this.renewErroForm = '';
                    const { nome, email, whatsapp, cpf } = this.renewForm;
                    if (!nome.trim() || !email.trim() || !whatsapp.trim() || !cpf.trim()) {
                        this.renewErroForm = 'Preencha todos os campos.'; return;
                    }
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                        this.renewErroForm = 'E-mail inválido.'; return;
                    }
                    const cpfLimpo = cpf.replace(/\D/g, '');
                    if (cpfLimpo.length !== 11) {
                        this.renewErroForm = 'CPF inválido (11 dígitos).'; return;
                    }

                    // Carrega MP token do Supabase se disponível
                    try {
                        const { data: rows } = await this.client.from('admin_config').select('key,value').in('key', ['mp_access_token']);
                        rows?.forEach(r => { if (r.key === 'mp_access_token' && r.value) this.MP_ACCESS_TOKEN_RENEW = r.value; });
                    } catch(e) {}

                    this.renewLoading = true;
                    try {
                        const plano      = this.renewPlanoSelecionado;
                        const valor      = plano.preco || plano.preco_mensal;
                        const licenseKey = 'LIC-' + Math.random().toString(36).substr(2, 9).toUpperCase();
                        const refId      = 'REN-' + Date.now();
                        const telLimpo   = whatsapp.replace(/\D/g, '');
                        const [firstName, ...rest] = nome.trim().split(' ');
                        const lastName   = rest.join(' ') || firstName;

                        // 1. Salva pedido no Supabase
                        const { data: pedido, error: dbErr } = await this.client.from('pagamentos').insert({
                            nome: nome.trim(), email: email.trim(),
                            whatsapp: telLimpo, cpf: cpfLimpo,
                            instancia: this.instanceName,
                            plano: plano.id_slug || plano.id,
                            billing: 'mensal', valor, status: 'pending',
                            license_key: licenseKey, reference_id: refId,
                            is_renewal: true,
                        }).select().single();
                        if (dbErr) throw new Error('Erro ao salvar pedido: ' + dbErr.message);

                        this.renewPedidoId = pedido.id;
                        this.renewValorPix = valor;

                        // 2. Cria PIX no Mercado Pago
                        const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${this.MP_ACCESS_TOKEN_RENEW}`,
                                'Content-Type': 'application/json',
                                'X-Idempotency-Key': refId,
                            },
                            body: JSON.stringify({
                                transaction_amount: Number(valor),
                                description: `EvoCRM ${plano.nome} - Renovação Mensal`,
                                payment_method_id: 'pix',
                                external_reference: refId,
                                date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                                payer: {
                                    email: email.trim(),
                                    first_name: firstName,
                                    last_name: lastName,
                                    identification: { type: 'CPF', number: cpfLimpo },
                                },
                            }),
                        });
                        const mpData = await mpRes.json();
                        if (!mpRes.ok) throw new Error(mpData.message || 'Erro ao criar PIX no Mercado Pago');

                        const pixData = mpData.point_of_interaction?.transaction_data;
                        this.renewPixCopiaECola = pixData?.qr_code        || '';
                        this.renewPixQrBase64   = pixData?.qr_code_base64 || '';
                        this.renewMpPaymentId   = String(mpData.id || '');

                        await this.client.from('pagamentos').update({ mp_payment_id: this.renewMpPaymentId }).eq('id', pedido.id);

                        this._renewIniciarContador(30 * 60);
                        this.renewStep = 'pix';
                        this._renewPollStatus(pedido.id);
                    } catch(e) {
                        this.renewErroForm = e.message || 'Erro inesperado. Tente novamente.';
                    } finally {
                        this.renewLoading = false;
                    }
                },

                _renewPollStatus(pedidoId) {
                    const check = async () => {
                        try {
                            if (this.renewMpPaymentId) {
                                const r = await fetch(`https://api.mercadopago.com/v1/payments/${this.renewMpPaymentId}`, {
                                    headers: { 'Authorization': `Bearer ${this.MP_ACCESS_TOKEN_RENEW}` }
                                });
                                const d = await r.json();
                                if (d.status === 'approved') {
                                    clearTimeout(this.renewPollTimer); clearInterval(this.renewContadorTimer);
                                    await this.client.from('pagamentos').update({ status: 'approved' }).eq('id', pedidoId);
                                    await this._renewAtivarLicenca(pedidoId);
                                    return;
                                }
                            }
                            const { data } = await this.client.from('pagamentos').select('status').eq('id', pedidoId).single();
                            if (data?.status === 'approved') {
                                clearTimeout(this.renewPollTimer); clearInterval(this.renewContadorTimer);
                                await this._renewAtivarLicenca(pedidoId);
                            } else if (data?.status === 'cancelled' || data?.status === 'rejected') {
                                clearTimeout(this.renewPollTimer);
                                this.renewErroMsg = 'PIX expirado ou cancelado.'; this.renewStep = 'erro';
                            } else {
                                this.renewPollTimer = setTimeout(check, 5000);
                            }
                        } catch(e) { this.renewPollTimer = setTimeout(check, 6000); }
                    };
                    this.renewPollTimer = setTimeout(check, 5000);
                },

                _renewIniciarContador(segundos) {
                    clearInterval(this.renewContadorTimer);
                    let restante = segundos;
                    const tick = () => {
                        const m = String(Math.floor(restante / 60)).padStart(2, '0');
                        const s = String(restante % 60).padStart(2, '0');
                        this.renewContadorPix = `${m}:${s}`;
                        if (restante <= 0) {
                            clearInterval(this.renewContadorTimer);
                            if (this.renewStep === 'pix') {
                                clearTimeout(this.renewPollTimer);
                                this.renewErroMsg = 'PIX expirado. Tente novamente.';
                                this.renewStep = 'erro';
                            }
                        }
                        restante--;
                    };
                    tick();
                    this.renewContadorTimer = setInterval(tick, 1000);
                },

                async renewCopiarPix() {
                    try { await navigator.clipboard.writeText(this.renewPixCopiaECola); }
                    catch(e) {
                        const el = document.createElement('textarea');
                        el.value = this.renewPixCopiaECola; document.body.appendChild(el);
                        el.select(); document.execCommand('copy'); document.body.removeChild(el);
                    }
                    this.renewPixCopiado = true;
                    setTimeout(() => this.renewPixCopiado = false, 3000);
                },

                async _renewAtivarLicenca(pedidoId) {
                    try {
                        const { data: pag } = await this.client.from('pagamentos').select('*').eq('id', pedidoId).single();
                        if (!pag) return;

                        const dias    = 30;
                        const expires = new Date();
                        expires.setDate(expires.getDate() + dias);

                        // Atualiza licença no Supabase: mantém plano atual mas estende validade
                        await this.client.from('licenses').update({
                            status: 'active',
                            plano: pag.plano,
                            expires_at: expires.toISOString(),
                            is_trial: false,
                        }).eq('instance_name', this.instanceName);

                        await this.client.from('pagamentos').update({ expires_at: expires.toISOString() }).eq('id', pedidoId);

                        // Atualiza estado local
                        this.clientePlano = pag.plano;
                        this.clienteExpiresAt = expires.toISOString();
                        this.clienteIsTrial = false;
                        localStorage.setItem('evo_plano', this.clientePlano);
                        localStorage.setItem('evo_expires_at', this.clienteExpiresAt);
                        localStorage.setItem('evo_is_trial', 'false');

                        // Notifica o servidor
                        try {
                            await fetch(window.location.origin + '/api/renovar-licenca', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ instancia: this.instanceName, pedido_id: pedidoId })
                            });
                        } catch(e) { console.warn('Renovação local aplicada.'); }

                        this.renewStep = 'sucesso';
                        setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 80);
                    } catch(e) {
                        this.renewErroMsg = 'Erro ao ativar renovação: ' + e.message;
                        this.renewStep = 'erro';
                    }
                },

                renewMaskPhone(e) {
                    let v = e.target.value.replace(/\D/g, '');
                    if (v.length <= 2)      v = v.replace(/^(\d{0,2})/, '($1');
                    else if (v.length <= 7) v = v.replace(/^(\d{2})(\d{0,5})/, '($1) $2');
                    else                    v = v.replace(/^(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
                    this.renewForm.whatsapp = v;
                },

                renewMaskCpf(e) {
                    let v = e.target.value.replace(/\D/g, '');
                    v = v.replace(/^(\d{3})(\d)/, '$1.$2');
                    v = v.replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3');
                    v = v.replace(/\.(\d{3})(\d)/, '.$1-$2');
                    this.renewForm.cpf = v.substring(0, 14);
                },



                isChatOpen: false, selectedLead: null, selectedLeadStatus: '', msgInput: '', chatSearch: '', leads: [], messages: [], botRules: [], myLibrary: [],

                // ── BUSCA GLOBAL ──
                globalSearchOpen: false,
                globalSearchQ: '',
                globalSearchIdx: 0,

                // ── RESPOSTAS RÁPIDAS PERSONALIZADAS ──
                quickReplies: [],
                quickRepliesModal: false,
                newQrAtalho: '',
                newQrTexto: '',

                // ── IA UTILS: RESUMO + SUGESTÃO ──
                aiSummaryLoading: false,
                aiSuggestLoading: false,
                aiSuggestedReply: '',
                aiSuggestOpen: false,



                // ── VALOR DO NEGÓCIO ──
                leadValores: JSON.parse(localStorage.getItem('evo_lead_valores') || '{}'),
                leadValorModal: { open: false, lead: null, valor: '' },

                // ── SENTIMENTO ──
                leadSentimento: {},  // { [leadId]: 'positivo'|'negativo'|'neutro' } — carregado do servidor

                // ── HISTÓRICO DE ATIVIDADES ──
                activityLog: [],
                activityLogOpen: false,

                // ── GRUPOS DE LEADS ──
                leadGroups: [],
                leadGroupsOpen: false,
                activeGroupFilter: null,
                newGroupNome: '',
                newGroupTipo: 'unread',
                newGroupFiltroValor: '',

                // ── CONFIGURAÇÕES (Tema + Webhook) ──
                settingsOpen: false,
                themeColor: '#6366f1',
                webhookUrl: localStorage.getItem('evo_webhook_url') || '',
                webhookEvents: JSON.parse(localStorage.getItem('evo_webhook_events') || JSON.stringify([
                    { id: 'nova_mensagem', label: 'Nova mensagem', ativo: true  },
                    { id: 'lead_criado',   label: 'Lead criado',   ativo: true  },
                    { id: 'etapa_mudou',   label: 'Etapa mudou',   ativo: false },
                    { id: 'ia_respondeu',  label: 'IA respondeu',  ativo: false },
                    { id: 'agendamento',   label: 'Agendamento',   ativo: false },
                ])),

                // ── IA ATENDIMENTO ──
                iaAtivo: false,
                iaApiKey: '',
                iaPrompt: '',
                iaModelo: 'gpt-4o-mini',
                iaRespondendo: {},
                iaConversasAtivadas: {},
                iaPromptSalvo: false,
                iaSalvando: false,
                iaSelectedPromptId: null,
                iaModalTab: 'prompt',
                iaEditingPromptId: null,
                iaPromptForm: { nome: '', descricao: '', prompt: '', modelo: 'gpt-4o-mini', temperatura: 0.7, max_tokens: 1024, pausa_se_humano: true, responder_grupos: false, delay_min: 1, delay_max: 3, palavra_chave: '' },
                iaSavedPrompts: [],
                iaTab: 'prompts',
                iaLoadingPrompts: false,
                iaShowModal: false,
                iaModalSaving: false,
                iaEditingPrompt: null,
                iaDelayMin: 1,
                iaDelayMax: 3,
                iaPausaSeHumano: true,
                iaResponderGrupos: false,
                iaHumanoAtivo: {},
                iaHumanoTimers: {},
                iaPausaTempo: 30,
                iaKeyword: '',
                iaKeywordRetomar: '',
                // ── BUFFER DE MENSAGENS ──
                iaBufferMsgs: {},    // { leadId: [ {content, type, id, ts} ] }
                iaBufferTimers: {},  // { leadId: timeoutId }
                iaBufferTempo: 8,    // segundos de silêncio antes de disparar (configurável)
                iaPausas: {}, // { leadId: { pausadoEm, retomadoEm, pausadoPor } } — espelho do Supabase
                // ── FORMATAÇÃO DE MENSAGENS ──
                iaMsgMaxChars: 300,
                iaMsgDelayEntrePartes: 2,
                iaMsgQuebrarLinhas: true,
                // ── TEMPERATURA / MAX TOKENS ──
                iaTemperatura: 0.7,
                iaMaxTokens: 1024,
                // ── TTS ──
                iaTtsMode: 'both',
                iaTtsVoz: 'nova',
                iaTtsMaxSeconds: 10, // Duração máxima do áudio em segundos
                iaTtsFrequencia: 50,
                // ── FOLLOW-UP / REENGAJAMENTO ──
                iaFollowupAtivo: false,
                iaFollowupMaxTentativas: 3,
                iaFollowupTempo1: 30,
                iaFollowupUnidade1: 'minutos',
                iaFollowupTempo2: 2,
                iaFollowupUnidade2: 'horas',
                iaFollowupTempo3: 1,
                iaFollowupUnidade3: 'dias',
                iaFollowupHorarioInicio: 8,
                iaFollowupHorarioFim: 20,
                iaFollowupIgnorarColunas: '',
                vozPreviewId: null,
                vozAudio: null,
                _vozAbort: null,
                // ── TMA / TME por departamento ──
                atendimentoStats: [],
                atendimentoStatsPeriodo: 30,
                atendimentoStatsLoading: false,
                // ── Dashboard consolidado (tela Atendimento) ──
                dashData: { kpis: {}, departamentos: [], ranking: [], porHora: [] },
                dashLoading: false,
                _dashRefreshTimer: null,
                // Chat Interno
                chatTab: 'cliente',
                chatInternoMsgs: [],
                chatInternoInput: '',
                chatInternoLoading: false,
                chatInternoNaoLidos: 0,
                _tickSegundo: 0,
                // ── Chat Interno ──────────────────────────────────────────
                chatInternoOpen: false,
                chatInternoMsgs: [],
                chatInternoInput: '',
                chatInternoLoading: false,
                chatInternoUnread: {},

                // ── FILA DE ATENDIMENTO ──
                filaPorLead: {},         // { lead_id: { posicao, departamento } }
                filaAguardando: 0,       // total aguardando no meu depto
                filaPainelAberto: false, // expansão do painel flutuante na tela Chats
                filaLista: [],           // lista ordenada para o painel
                _stopVozAudio() {
                    if (this._vozAbort) { this._vozAbort.abort(); this._vozAbort = null; }
                    if (this.vozAudio) { this.vozAudio.pause(); this.vozAudio.src = ''; this.vozAudio = null; }
                    this.vozPreviewId = null;
                },
                async previewVoz(vozId) {
                    if (this.vozPreviewId === vozId) { this._stopVozAudio(); return; }
                    this._stopVozAudio();
                    if (!this.iaApiKey) {
                        this.iaTab = 'config';
                        this.addNotification('API Key necessária', 'Configure sua chave OpenAI para ouvir o preview.', 'info');
                        return;
                    }
                    this.vozPreviewId = vozId;
                    this._vozAbort = new AbortController();
                    try {
                        const res = await fetch('https://api.openai.com/v1/audio/speech', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.iaApiKey },
                            body: JSON.stringify({ model: 'tts-1', input: 'Olá! Eu sou a voz ' + vozId + '. Posso te atender agora?', voice: vozId, response_format: 'mp3' }),
                            signal: this._vozAbort.signal
                        });
                        if (!res.ok) throw new Error('Erro ' + res.status);
                        const blob = await res.blob();
                        if (this.vozPreviewId !== vozId) return;
                        const url = URL.createObjectURL(blob);
                        this.vozAudio = new Audio(url);
                        this.vozAudio.onended = () => { URL.revokeObjectURL(url); this.vozPreviewId = null; this.vozAudio = null; };
                        this.vozAudio.onerror = () => { URL.revokeObjectURL(url); this.vozPreviewId = null; this.vozAudio = null; };
                        await this.vozAudio.play();
                    } catch(e) {
                        if (e.name === 'AbortError') return;
                        this.vozPreviewId = null;
                        this.addNotification('Erro no preview', e.message, 'error');
                    }
                },
                iaTtsAtivoPorLead: {}, // toggle por conversa
                leadPromptIdPorLead: {}, // prompt específico por conversa
                // ── MÍDIAS INTELIGENTES ──
                iaMidias: [],
                iaMidiasLoading: false,
                iaMidiaUploadLoading: false,
                iaMidiaShowForm: false,
                iaMidiaEditId: null,
                iaMidiaForm: { nome: '', palavras_chave: '', tipo: 'image', arquivo: null, arquivo_nome: '', url: '', descricao: '' },
                iaLogs: [],
                iaAddLog(tipo, msg) {
                    this.iaLogs.unshift({ tipo, msg, hora: new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) });
                    if (this.iaLogs.length > 30) this.iaLogs.pop();
                },
                // ── CHAT AUDIO PLAYER ──
                _chatAudio: null,          // instância Audio ativa
                _chatAudioMsgId: null,     // id da msg tocando
                _chatAudioProgress: {},    // { [msgId]: { current, duration, pct } }
                _chatAudioPlaying: {},     // { [msgId]: true/false }

                _stopChatAudio() {
                    if (this._chatAudio) {
                        this._chatAudio.pause();
                        this._chatAudio.src = '';
                        this._chatAudio = null;
                    }
                    if (this._chatAudioMsgId) {
                        this._chatAudioPlaying[this._chatAudioMsgId] = false;
                        this._chatAudioMsgId = null;
                    }
                },

                toggleChatAudio(msgId, url) {
                    // Pausar se já está tocando este mesmo
                    if (this._chatAudioMsgId === msgId) {
                        if (this._chatAudio && !this._chatAudio.paused) {
                            this._chatAudio.pause();
                            this._chatAudioPlaying[msgId] = false;
                        } else if (this._chatAudio) {
                            this._chatAudio.play();
                            this._chatAudioPlaying[msgId] = true;
                        }
                        return;
                    }
                    // Para o áudio anterior
                    this._stopChatAudio();
                    // Inicia novo
                    this._chatAudioMsgId = msgId;
                    this._chatAudioPlaying[msgId] = false;
                    if (!this._chatAudioProgress[msgId]) {
                        this._chatAudioProgress[msgId] = { current: 0, duration: 0, pct: 0 };
                    }
                    const audio = new Audio(url);
                    this._chatAudio = audio;

                    audio.addEventListener('loadedmetadata', () => {
                        this._chatAudioProgress[msgId] = {
                            ...this._chatAudioProgress[msgId],
                            duration: audio.duration
                        };
                    });
                    audio.addEventListener('timeupdate', () => {
                        if (this._chatAudioMsgId !== msgId) return;
                        const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
                        this._chatAudioProgress[msgId] = {
                            current: audio.currentTime,
                            duration: audio.duration || 0,
                            pct
                        };
                    });
                    audio.addEventListener('ended', () => {
                        this._chatAudioPlaying[msgId] = false;
                        this._chatAudioProgress[msgId] = { current: 0, duration: audio.duration || 0, pct: 0 };
                        this._chatAudioMsgId = null;
                        this._chatAudio = null;
                    });
                    audio.addEventListener('error', () => {
                        this._chatAudioPlaying[msgId] = false;
                        this._chatAudioMsgId = null;
                        this._chatAudio = null;
                    });

                    audio.play().then(() => {
                        this._chatAudioPlaying[msgId] = true;
                    }).catch(() => {
                        this._chatAudioPlaying[msgId] = false;
                        this._chatAudioMsgId = null;
                        this._chatAudio = null;
                    });
                },

                seekChatAudio(msgId, pct) {
                    if (this._chatAudioMsgId === msgId && this._chatAudio && this._chatAudio.duration) {
                        this._chatAudio.currentTime = (pct / 100) * this._chatAudio.duration;
                    }
                },

                _fmtAudioTime(s) {
                    if (!s || isNaN(s)) return '0:00';
                    const m = Math.floor(s / 60);
                    const sec = Math.floor(s % 60);
                    return m + ':' + String(sec).padStart(2, '0');
                },

                isDarkMode: localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches),
                // ── Modo Demo / Painel de Privacidade ─────────────────────────────────
                privacyPanelOpen: false,   // controla abertura do drawer lateral
                privacy: {                 // cada categoria pode ser oculta individualmente
                    fotos:      false,     // fotos de perfil dos contatos
                    nomes:      false,     // nomes dos clientes
                    numeros:    false,     // números de telefone
                    mensagens:  false,     // prévia e conteúdo de mensagens
                    etiquetas:  false,     // etiquetas / tags dos leads
                },
                get privacyAnyActive() {
                    return Object.values(this.privacy).some(Boolean);
                },
                
                isUpdatingPic: false, notifications: [],
                
                departmentsDB: [],
                currentUserDept: localStorage.getItem('evo_user_dept') || '',
                isSupervisor: localStorage.getItem('evo_is_supervisor') === 'true',
                loggedUserName: localStorage.getItem('evo_user_name') || '',
                deptAtendentes: [],
                admResponseAs: 'ADM Principal', 
                showDeptModal: false,
                showKeyModal: false,
                tempDept: '', 
                tempKeyInput: '',
                newDeptName: '',
                newDeptKey: '',
                newDeptKeywords: '',
                newDeptMsg: 'Você está sendo direcionado para o setor responsável. Em breve um de nossos atendentes irá te atender. 😊',
                newDeptSupervisorNome: '',
                newDeptSupervisorKey: '',
                editingDeptId: null,
                isCheckingLicense: false,

                flowBuilder: { name: '', trigger: '', steps: [] }, isSavingFlow: false, editingRuleId: null, isEditingFlow: false, isSaveFlowModalOpen: false,
                disparoConfig: {
                    // ── Alvo ──
                    status: 'todos', tipoMensagem: 'simples', selectedFlowId: '',
                    numerosImportados: '', msg: '', msgs: [''],
                    file: null,          // File object local (não serializável)
                    // ── Mídia persistente (sobrevive a page reload) ──
                    publicMediaUrl: null, mediaType: null, mediaFileName: null, mediaMime: null,
                    // ── Controle de execução ──
                    isRunning: false, isPaused: false, sent: 0, total: 0,
                    leadsQueue: [], lastIndex: 0, campanhaId: null, erros: 0,
                    warningAccepted: false, importedFile: null,
                    // ── Delay base ──
                    minDelay: 30, maxDelay: 60,
                    // ── Anti-ban ──
                    antibanTyping: true,           // simular digitação antes de enviar
                    antibanTypingSec: 4,           // segundos de "digitando..." (2-10)
                    antibanBatch: true,            // pausar entre lotes
                    antibanBatchSize: 20,          // envios antes de pausar
                    antibanBatchPauseSec: 300,     // segundos de pausa entre lotes (5 min)
                    antibanBlacklist: '',          // números separados por vírgula/quebra
                    antibanLimitPerDay: 0,         // 0 = ilimitado
                    antibanDailyCount: 0,          // contagem do dia
                    antibanDailyDate: '',          // data da contagem
                    antibanWarmup: false,          // warm-up: aumenta lote gradativamente
                    antibanWarmupStart: 5,         // começa com X envios
                    antibanWarmupStep: 5,          // aumenta X por lote
                    antibanWarmupMax: 50,          // máximo por lote
                    antibanBatchCount: 0,          // lotes enviados (para warm-up)
                    antibanCurrentBatchSize: 0,    // lote atual calculado (runtime)
                },
                disparoModelos: [],
                disparoExtractorInput: '',
                disparoContatosExtraidos: [],
                disparoVerificando: false,
                csvVerificando: false,
                csvResultado: null,
                disparoBookmarkletStatus: '',
                showSaveModeloModal: false,
                showModelosModal: false,
                modeloNome: '',
                modeloSalvando: false,
                
                isObsModalOpen: false, activeLeadForObs: null, obsInput: '',
                agendaTarget: 'manual', agendaFunil: 'novo_lead', agendaTab: 'pendentes', agendaSearch: '',
                agendaForm: { leadIds: [], numeroAvulso: '', tipo: 'simples', flowId: '', texto: '', dataHora: '' },
                agendamentos: [],
                isCheckingAgendamentosFlag: false,
                // Disponibilidade da agenda
                agendaDisp: {
                    dias_semana: {"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false},
                    horario_inicio: '09:00', horario_fim: '18:00',
                    duracao_slot: 60,
                    almoco_inicio: '12:00', almoco_fim: '13:00', almoco_ativo: true,
                    max_por_dia: 8, ia_verificar: true,
                    confirmacao_ativa: false,
                    confirmacao_horas_antes: 24,
                    confirmacao_msg: 'Olá {nome}! 😊 Lembramos que você tem um agendamento amanhã às {hora}. Por favor, confirme sua presença respondendo *SIM* para confirmar ou *NÃO* para cancelar. Aguardamos você!'
                },
                agendaDispSalvando: false,
                // Calendário
                calMes: new Date().getMonth(),
                calAno: new Date().getFullYear(),
                calDiaSelecionado: null,

                isRecording: false, recordingTimer: 0, recordingInterval: null, mediaRecorder: null, audioChunks: [],
                qrStatus: 'checking', qrCodeImage: '',
                wakeLock: null,

                // BASE DE CONHECIMENTO
                kbPanelOpen: false,
                kbMessages: [],
                kbInput: '',
                kbLoading: false,
                kbDocs: [],
                kbUploadingDoc: false,
                kbShowDocs: false,

                // ── DOCUMENTOS DO LEAD ──
                docsPanelOpen: false,
                docsList: [],
                docsLoading: false,
                docsUploading: false,
                docsEditId: null,
                docsNotificar: true,

                downloadedMedia: JSON.parse(localStorage.getItem('evo_dl_media') || '[]'),
                downloadedMediaSet: new Set(),
                lightboxOpen: false,
                lightboxUrl: '',
                
                // CONTROLE DE ETIQUETAS (ORIGEM)
                isEtiquetaModalOpen: false,
                activeLeadForEtiqueta: null,
                novaEtiquetaInput: '',
                newTagColor: '#a855f7',
                dbTags: [],
                listaEtiquetasTemporaria: [],

                // ════════════════════════════════════════
                //  RESPOSTAS AUTOMÁTICAS (Chatbot por KW)
                // ════════════════════════════════════════
                botTab: 'fluxos',
                arBotAtivo: true,
                arTotalDisparos: 0,
                autoReplies: [],
                arEditId: null,
                arSalvando: false,
                arLeadsJaRespondidos: {},
                arForm: {
                    gatilhos: '',
                    modoMatch: 'contem',
                    blocos: [],
                    apenasUmaVez: false,
                    prioridade: '2'
                },


                // CONTROLE DE AÇÕES RÁPIDAS
                isQuickFlowOpen: false,
                quickFlowId: '',
                isQuickScheduleOpen: false,
                quickScheduleForm: { tipo: 'simples', flowId: '', texto: '', dataHora: '' },
                activeLeadForAction: null,

                // ✅ Carregados dinamicamente de /api/config no init() — não editar aqui
                EVO_URL: '',
                EVO_KEY: '',
                _operatorNames: new Set(), // nomes do operador — nunca salvar como nome de lead

                navItems: [
                    { id: 'dash',              label: 'Dash',            icon: 'pie-chart' },
                    { id: 'kanban',            label: 'Kanban',          icon: 'columns' },
                    { id: 'chats',             label: 'Conversas',       icon: 'message-circle' },
                    { id: 'bot',               label: 'Automação',       icon: 'git-merge',     requerFeature: true },
                    { id: 'ia_atendimento',    label: 'Agentes de IA',   icon: 'sparkles',      requerFeature: true, apenasAdm: true },
                    { id: 'disparo',           label: 'Campanhas',       icon: 'send',          requerFeature: true },
                    { id: 'agenda',            label: 'Agenda',          icon: 'calendar',      requerFeature: true },
                    { id: 'setores',           label: 'Departamentos',   icon: 'shield',        requerFeature: true, apenasAdm: true },
                    { id: 'atendimento',       label: 'Atendimento',     icon: 'activity',      apenasAdm: true },
                    { id: 'conexao',           label: 'Conexão',         icon: 'smartphone' },
                    { id: 'meu_plano',         label: 'Meu Plano',       icon: 'crown' }
                ],
                
                columns: [],
                allColumnsMap: {}, 
                funilIaModal: { open: false, col: {} },

                // ── LUCIDE DEBOUNCED — evita recriar todos os ícones a cada evento ──
                _lucideTimer: null,
                _refreshIcons(delay) {
                    if (this._lucideTimer) return;
                    this._lucideTimer = setTimeout(() => {
                        lucide.createIcons();
                        this._lucideTimer = null;
                    }, delay || 80);
                },




                addNotification(title, message, type = 'info', dur = 5000) { 
                    const id = Date.now(); 
                    this.notifications.push({ id, title, message, type }); 
                    setTimeout(() => { this.notifications = this.notifications.filter(n => n.id !== id); }, dur); 
                    this._refreshIcons();
                    
                    // Notificação nativa se a aba estiver em segundo plano
                    if (document.hidden) {
                        this.showNativeNotification(title, message, `evocrm-${type}`);
                    }
                    
                    if (type === 'success') { 
                        this.playSoundSuccess(); 
                    } else { 
                        this.playSound(); 
                    } 
                },

                // ── Sons suaves gerados via Web Audio API (sem CDN externo) ──
                // ─── SISTEMA DE SONS ──────────────────────────────────────────
                _audioCtx() {
                    if (!this._actx) this._actx = new (window.AudioContext || window.webkitAudioContext)();
                    return this._actx;
                },

                _playTone(freq = 520, duration = 0.18, volume = 0.12, type = 'sine') {
                    try {
                        const ctx = this._audioCtx();
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.type = type;
                        osc.frequency.setValueAtTime(freq, ctx.currentTime);
                        osc.frequency.exponentialRampToValueAtTime(freq * 0.8, ctx.currentTime + duration);
                        gain.gain.setValueAtTime(0, ctx.currentTime);
                        gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.01);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
                        osc.start(ctx.currentTime);
                        osc.stop(ctx.currentTime + duration);
                    } catch(e) {}
                },

                // Catálogo de sons disponíveis
                SONS: {
                    whatsapp: {
                        label: 'WhatsApp',
                        play(ctx, vol = 1) {
                            // Replica o ping característico do WhatsApp: dois tons suaves
                            const t = ctx.currentTime;
                            const makeNote = (freq, start, dur, v) => {
                                const osc = ctx.createOscillator();
                                const g = ctx.createGain();
                                osc.connect(g); g.connect(ctx.destination);
                                osc.type = 'sine';
                                osc.frequency.setValueAtTime(freq, t + start);
                                g.gain.setValueAtTime(0, t + start);
                                g.gain.linearRampToValueAtTime(v * vol, t + start + 0.008);
                                g.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
                                osc.start(t + start);
                                osc.stop(t + start + dur + 0.01);
                            };
                            makeNote(1318, 0,    0.12, 0.13); // E6
                            makeNote(1760, 0.11, 0.10, 0.10); // A6
                        }
                    },
                    pop: {
                        label: 'Pop',
                        play(ctx, vol = 1) {
                            // Bolha estourando — suave e clean
                            const t = ctx.currentTime;
                            const osc = ctx.createOscillator();
                            const g = ctx.createGain();
                            osc.connect(g); g.connect(ctx.destination);
                            osc.type = 'sine';
                            osc.frequency.setValueAtTime(900, t);
                            osc.frequency.exponentialRampToValueAtTime(400, t + 0.08);
                            g.gain.setValueAtTime(0.18 * vol, t);
                            g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
                            osc.start(t); osc.stop(t + 0.13);
                        }
                    },
                    chime: {
                        label: 'Chime',
                        play(ctx, vol = 1) {
                            // Três notas ascendentes suaves
                            const t = ctx.currentTime;
                            [[523,0],[659,0.1],[784,0.2]].forEach(([freq, delay]) => {
                                const osc = ctx.createOscillator();
                                const g = ctx.createGain();
                                osc.connect(g); g.connect(ctx.destination);
                                osc.type = 'sine';
                                osc.frequency.setValueAtTime(freq, t + delay);
                                g.gain.setValueAtTime(0, t + delay);
                                g.gain.linearRampToValueAtTime(0.10 * vol, t + delay + 0.01);
                                g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.25);
                                osc.start(t + delay); osc.stop(t + delay + 0.3);
                            });
                        }
                    },
                    ping: {
                        label: 'Ping',
                        play(ctx, vol = 1) {
                            // Tom único cristalino
                            const t = ctx.currentTime;
                            const osc = ctx.createOscillator();
                            const g = ctx.createGain();
                            osc.connect(g); g.connect(ctx.destination);
                            osc.type = 'sine';
                            osc.frequency.setValueAtTime(1046, t); // C6
                            g.gain.setValueAtTime(0.15 * vol, t);
                            g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
                            osc.start(t); osc.stop(t + 0.45);
                        }
                    },
                    ding: {
                        label: 'Ding',
                        play(ctx, vol = 1) {
                            // Campainha leve — dois tons rápidos
                            const t = ctx.currentTime;
                            [[880,0,0.15],[1100,0.08,0.12]].forEach(([freq, delay, dur]) => {
                                const osc = ctx.createOscillator();
                                const g = ctx.createGain();
                                osc.connect(g); g.connect(ctx.destination);
                                osc.type = 'triangle';
                                osc.frequency.setValueAtTime(freq, t + delay);
                                g.gain.setValueAtTime(0.12 * vol, t + delay);
                                g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
                                osc.start(t + delay); osc.stop(t + delay + dur + 0.01);
                            });
                        }
                    },
                    none: {
                        label: 'Sem som',
                        play() {}
                    }
                },

                // Toca o som configurado pelo usuário
                playSound() {
                    try {
                        const sonId = localStorage.getItem('evo_som_notif') || 'whatsapp';
                        const son = this.SONS[sonId] || this.SONS.whatsapp;
                        const vol = parseFloat(localStorage.getItem('evo_som_volume') || '1');
                        son.play(this._audioCtx(), vol);
                    } catch(e) {}
                },

                // Som de sucesso (agendamentos, vendas fechadas) — chime independente de preferência
                playSoundSuccess() {
                    try {
                        const vol = parseFloat(localStorage.getItem('evo_som_volume') || '1');
                        this.SONS.chime.play(this._audioCtx(), vol * 0.85);
                    } catch(e) {}
                },

                // Preview de som (chamado pelo seletor)
                previewSom(sonId) {
                    try {
                        const son = this.SONS[sonId] || this.SONS.whatsapp;
                        son.play(this._audioCtx(), 1);
                    } catch(e) {}
                },
                
                toggleTheme() { this.isDarkMode = !this.isDarkMode; localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light'); this._refreshIcons(); },
                togglePrivacyMode() {
                    // Ctrl+Shift+P: se nada ativo → oculta tudo; se algo ativo → mostra tudo
                    const anyActive = Object.values(this.privacy).some(Boolean);
                    Object.keys(this.privacy).forEach(k => this.privacy[k] = !anyActive);
                    this.addNotification(
                        !anyActive ? '🎬 Modo Demo — Tudo oculto' : '🔓 Modo Demo desativado',
                        !anyActive ? 'Abra o painel 👁️ para controle individual.' : 'Dados visíveis normalmente.',
                        !anyActive ? 'info' : 'success'
                    );
                    this._refreshIcons();
                },
                // Retorna true quando o campo de nome deve ser borrado.
                // Se o lead não tem nome real, o número fica no lugar —
                // nesse caso, ativa o blur quando NOMES *ou* NUMEROS estiver ligado.
                _blurNome(lead) {
                    if (!lead) return false;
                    const temNomeReal = lead.nome && lead.nome !== lead.numero
                        && !['Lead Avulso','Lead Importado','Desconhecido'].includes(lead.nome);
                    return this.privacy.nomes || (!temNomeReal && this.privacy.numeros);
                },

                get filteredNavItems() {
                    return [...this.navItems]
                        // Itens exclusivos de ADM ficam invisíveis para outros setores (supervisor vê Atendimento)
                        .filter(item => !item.apenasAdm || this.currentUserDept === 'ADM Principal' || (this.isSupervisor && (item.id === 'atendimento' || item.id === 'setores')))
                        // Marca itens sem feature como bloqueados (visíveis mas com cadeado + toast)
                        .map(item => ({
                            ...item,
                            bloqueado: !!(item.requerFeature && !this._temFeature(item.id))
                        }));
                },

                get allDepartments() {
                    return ['ADM Principal', ...this.departmentsDB.filter(d => d.name !== 'ADM Principal').map(d => d.name)];
                },
                
                get myLeads() {
                    if (!this.currentUserDept || this.currentUserDept === 'ADM Principal') return this.leads;
                    return this.leads.filter(l => (l.departamento || 'ADM Principal') === this.currentUserDept);
                },

                downloadMedia(msgId) {
                    if (!this.downloadedMediaSet.has(msgId)) {
                        this.downloadedMedia.push(msgId);
                        this.downloadedMediaSet.add(msgId);
                        if (this.downloadedMedia.length > 500) { this.downloadedMedia.shift(); }
                        localStorage.setItem('evo_dl_media', JSON.stringify(this.downloadedMedia));
                        this._refreshIcons();
                    }
                },
                
                openLightbox(url) { 
                    this.lightboxUrl = url; 
                    this.lightboxOpen = true; 
                    this._refreshIcons(); 
                },

                // GESTÃO DE ETIQUETAS E BANCO DE DADOS
                async loadTags() {
                    const { data } = await this.client.from('crm_tags').select('*').eq('instance_name', this.instanceName);
                    if(data) this.dbTags = data.map(t => ({
                        ...t,
                        name: t.name || t.nome || '',
                        color: t.color || t.cor || '#a855f7'
                    }));
                },

                async criarTagBD() {
                    const name = this.novaEtiquetaInput.trim().toUpperCase();
                    if(!name) return;
                    const exists = this.dbTags.find(t => t.name === name);
                    if(exists) return alert("Tag já existe!");
                    
                    try {
                        const { data, error } = await this.client.from('crm_tags').insert({
                            instance_name: this.instanceName,
                            name: name,
                            color: this.newTagColor
                        }).select().single();
                        
                        if(data) {
                            this.dbTags.push(data);
                            this.listaEtiquetasTemporaria.push(name);
                            this.novaEtiquetaInput = '';
                            this._refreshIcons();
                        }
                    } catch(e) { console.error("Erro criar tag:", e); }
                },

                getTagColor(tagName) {
                    const tag = this.dbTags.find(t => t.name === tagName.toUpperCase());
                    return tag ? tag.color : '#a855f7';
                },

                toggleTag(tagName) {
                    const idx = this.listaEtiquetasTemporaria.indexOf(tagName);
                    if (idx > -1) this.listaEtiquetasTemporaria.splice(idx, 1);
                    else this.listaEtiquetasTemporaria.push(tagName);
                    this._refreshIcons();
                },

                async toggleFollowupLead(lead) {
                    const novoValor = !lead.followup_lead_ativo;
                    // Atualiza local imediatamente
                    const idx = this.leads.findIndex(l => l.id === lead.id);
                    if (idx !== -1) {
                        this.leads[idx] = { ...this.leads[idx], followup_lead_ativo: novoValor };
                        this.leads = [...this.leads];
                    }
                    if (this.selectedLead?.id === lead.id) {
                        this.selectedLead = { ...this.selectedLead, followup_lead_ativo: novoValor };
                    }
                    // Persiste no DB
                    await this.client.from('leads').update({
                        followup_lead_ativo: novoValor,
                        followup_count: novoValor ? 0 : (lead.followup_count || 0),
                        followup_last_at: novoValor ? null : (lead.followup_last_at || null),
                    }).eq('id', lead.id);
                    this.addNotification(
                        novoValor ? '🔄 Follow-up ativado' : '⏹️ Follow-up desativado',
                        novoValor ? `Follow-up ativado para ${this.getLeadName(lead)}` : `Follow-up desativado para ${this.getLeadName(lead)}`,
                        novoValor ? 'ok' : 'info'
                    );
                },

                openEtiquetaModal(lead) {
                    this.activeLeadForEtiqueta = lead;
                    this.listaEtiquetasTemporaria = lead.etiquetas ? lead.etiquetas.split(',').filter(t => t.trim() !== '') : [];
                    this.novaEtiquetaInput = '';
                    this.isEtiquetaModalOpen = true;
                    this._refreshIcons();
                },
                
                adicionarEtiquetaNaLista() {
                    this.criarTagBD();
                },
                
                removerEtiquetaDaLista(index) {
                    this.listaEtiquetasTemporaria.splice(index, 1);
                },
                
                async salvarEtiquetas() {
                    if (!this.activeLeadForEtiqueta) return;
                    const stringFinal = this.listaEtiquetasTemporaria.join(',');
                    try {
                        await this.client.from('leads').update({ etiquetas: stringFinal }).eq('id', this.activeLeadForEtiqueta.id);
                        this.activeLeadForEtiqueta.etiquetas = stringFinal;
                        const idx = this.leads.findIndex(l => l.id === this.activeLeadForEtiqueta.id);
                        if (idx !== -1) {
                            this.leads[idx].etiquetas = stringFinal;
                            this.leads = [...this.leads]; 
                        }
                        this.isEtiquetaModalOpen = false;
                        this.addNotification('Origem Salva', 'Tags atualizadas.', 'success');
                    } catch(e) {
                        this.addNotification('Erro', 'Falha ao salvar etiqueta.', 'error');
                    }
                },

                // GESTÃO DE AÇÕES RÁPIDAS NO FUNIL
                openQuickFlow(lead) {
                    this.activeLeadForAction = lead;
                    this.quickFlowId = '';
                    this.isQuickFlowOpen = true;
                    this._refreshIcons();
                },

                async sendQuickFlow() {
                    if (!this.quickFlowId) return alert('Selecione um fluxo.');
                    const rule = this.botRules.find(r => r.id === this.quickFlowId);
                    if (rule && this.activeLeadForAction) {
                        this.isQuickFlowOpen = false;
                        this.addNotification('Iniciando...', 'A enviar automação...', 'info');
                        await this.triggerBotRuleManual(rule, this.activeLeadForAction);
                        this.addNotification('Sucesso!', 'Automação enviada.', 'success');
                    }
                },

                openQuickSchedule(lead) {
                    this.activeLeadForAction = lead;
                    this.quickScheduleForm = { tipo: 'simples', flowId: '', texto: '', dataHora: '' };
                    if (this.$refs.quickDataHoraInput && this.$refs.quickDataHoraInput._flatpickr) {
                        this.$refs.quickDataHoraInput._flatpickr.clear();
                    }
                    this.isQuickScheduleOpen = true;
                    this._refreshIcons();
                },

                async saveQuickSchedule() {
                    if (!this.quickScheduleForm.dataHora) return alert('Escolha a data e hora.');
                    if (this.quickScheduleForm.tipo === 'simples' && !this.quickScheduleForm.texto) return alert('Escreva a mensagem.');
                    if (this.quickScheduleForm.tipo === 'fluxo' && !this.quickScheduleForm.flowId) return alert('Selecione um Fluxo.');
                    
                    const ag = { 
                        id: null,
                        leadId: this.activeLeadForAction.id, 
                        numero: this.activeLeadForAction.numero || null,
                        tipo: this.quickScheduleForm.tipo, 
                        flowId: this.quickScheduleForm.flowId, 
                        texto: this.quickScheduleForm.texto, 
                        dataHora: this.quickScheduleForm.dataHora, 
                        sent: false,
                        status: 'ativo',
                        lembreteEnviado: false,
                        criadoPorIA: false
                    };

                    this.agendamentos.push(ag); 
                    
                    // Salva no Supabase — permite que o servidor envie mesmo com CRM fechado
                    try {
                        await this._salvarAgendamentoSupabase(ag);
                    } catch(e) {
                        // Fallback: localStorage (o servidor não vai pegar, mas o CRM aberto sim)
                        localStorage.setItem(`evo_agendamentos_${this.instanceName}`, JSON.stringify(this.agendamentos));
                    }

                    this.isQuickScheduleOpen = false;
                    this.addNotification('Agendado! ✅', `Mensagem programada para ${this.getLeadName(this.activeLeadForAction)}. O servidor vai enviar mesmo com o CRM fechado.`, 'success');
                },

                async loadDepartments() {
                    const { data, error } = await this.client.from('departments').select('*').eq('instance_name', this.instanceName);
                    if (data) {
                        // Normaliza: garante que 'name' e 'access_key' existam mesmo em registros antigos
                        this.departmentsDB = data.map(d => ({
                            ...d,
                            name: d.name || d.nome || 'ADM Principal',
                            access_key: d.access_key || 'admin123'
                        }));
                        this._refreshIcons();
                    }
                },

                editAdmKey() {
                    const dept = this.departmentsDB.find(d => (d.name || d.nome) === 'ADM Principal');
                    this.editingDeptId = dept ? dept.id : 'new-adm';
                    this.newDeptName = 'ADM Principal';
                    this.newDeptKey = dept ? dept.access_key : 'admin123';
                    document.getElementById('main-content').scrollTo({ top: 0, behavior: 'smooth' });
                },

                editDepartment(dept) {
                    this.editingDeptId = dept.id;
                    this.newDeptName = dept.name;
                    this.newDeptKey = dept.access_key;
                    this.newDeptKeywords = dept.palavras_chave || '';
                    this.newDeptMsg = dept.msg_roteamento || 'Você está sendo direcionado para o setor responsável. Em breve um de nossos atendentes irá te atender. 😊';
                    this.newDeptSupervisorNome = dept.supervisor_nome || '';
                    this.newDeptSupervisorKey = dept.supervisor_key || '';
                    this._refreshIcons();
                    document.getElementById('main-content').scrollTo({ top: 0, behavior: 'smooth' });
                },

                cancelDeptEdit() {
                    this.editingDeptId = null;
                    this.newDeptName = '';
                    this.newDeptKey = '';
                    this.newDeptKeywords = '';
                    this.newDeptMsg = 'Você está sendo direcionado para o setor responsável. Em breve um de nossos atendentes irá te atender. 😊';
                    this.newDeptSupervisorNome = '';
                    this.newDeptSupervisorKey = '';
                    this._refreshIcons();
                },

                async saveDepartment() {
                    if(!this.newDeptName.trim()) return alert("Preencha o nome do departamento!");
                    // ADM Principal precisa de chave master
                    if (this.newDeptName.trim() === 'ADM Principal' && !this.newDeptKey.trim()) return alert("Preencha a chave master!");
                    
                    try {
                        const deptPayload = {
                            name: this.newDeptName.trim(),
                            access_key: this.newDeptKey.trim() || 'admin123',
                            palavras_chave: this.newDeptKeywords.trim(),
                            msg_roteamento: this.newDeptMsg.trim(),
                            supervisor_nome: this.newDeptSupervisorNome.trim() || null,
                            supervisor_key: this.newDeptSupervisorKey.trim() || null
                        };

                        if (this.editingDeptId && this.editingDeptId !== 'new-adm') {
                            const { error } = await this.client.from('departments').update(deptPayload).eq('id', this.editingDeptId);
                            if (error) throw error;
                        } else {
                            const nomeBusca = this.newDeptName.trim();
                            const { data: existente } = await this.client.from('departments')
                                .select('id').eq('instance_name', this.instanceName).eq('name', nomeBusca).limit(1).single();
                            
                            if (existente && existente.id) {
                                const { error } = await this.client.from('departments').update(deptPayload).eq('id', existente.id);
                                if (error) throw error;
                            } else {
                                const { error } = await this.client.from('departments').insert({
                                    instance_name: this.instanceName,
                                    ...deptPayload
                                });
                                if (error) throw error;
                            }
                        }
                        
                        this.addNotification('Sucesso', 'Setor atualizado com sucesso!', 'success');
                        this.cancelDeptEdit();
                        await this.loadDepartments();
                    } catch(e) { 
                        alert("Erro do Banco de Dados: " + e.message); 
                    }
                },

                async deleteDepartment(id) {
                    if(!confirm("Tem certeza que deseja apagar este setor permanentemente?")) return;
                    const { error } = await this.client.from('departments').delete().eq('id', id);
                    if (!error) {
                        await this.loadDepartments();
                        this.addNotification('Apagado', 'O setor foi removido.', 'info');
                    }
                },

                selectDepartment(deptName) {
                    this.tempDept = deptName;
                    this.tempKeyInput = '';
                    this.showDeptModal = false;
                    this.showKeyModal = true;
                    this._refreshIcons();
                },

                async confirmDepartmentKey() {
                    const deptDb = this.departmentsDB.find(d => (d.name || d.nome) === this.tempDept);
                    
                    if (this.tempDept === 'ADM Principal') {
                        const expectedKey = deptDb ? deptDb.access_key : 'admin123';
                        if (this.tempKeyInput === expectedKey) {
                            this.isSupervisor = false;
                            this.loggedUserName = 'ADM Principal';
                            localStorage.setItem('evo_is_supervisor', 'false');
                            localStorage.setItem('evo_user_name', 'ADM Principal');
                            this.loginSuccess();
                        } else {
                            alert("Chave de acesso incorreta!");
                        }
                        return;
                    }

                    if (!deptDb) {
                        alert("Este setor ainda não foi configurado. Entre como ADM Principal para configurá-lo.");
                        return;
                    }

                    // 1. Verifica se é supervisor
                    if (deptDb.supervisor_key && this.tempKeyInput === deptDb.supervisor_key) {
                        this.isSupervisor = true;
                        this.loggedUserName = deptDb.supervisor_nome || 'Supervisor';
                        localStorage.setItem('evo_is_supervisor', 'true');
                        localStorage.setItem('evo_user_name', this.loggedUserName);
                        this.loginSuccess();
                        return;
                    }

                    // 2. Verifica se é atendente do departamento
                    try {
                        const { data: atendentes } = await this.client.from('dept_atendentes')
                            .select('*')
                            .eq('instance_name', this.instanceName)
                            .eq('dept_id', deptDb.id)
                            .eq('ativo', 1);
                        
                        const atendente = (atendentes || []).find(a => a.senha === this.tempKeyInput);
                        if (atendente) {
                            this.isSupervisor = false;
                            this.loggedUserName = atendente.nome;
                            localStorage.setItem('evo_is_supervisor', 'false');
                            localStorage.setItem('evo_user_name', atendente.nome);
                            this.loginSuccess();
                            return;
                        }
                    } catch(e) { /* tabela pode não existir ainda */ }

                    // 3. Fallback: chave antiga do departamento (compatibilidade)
                    if (deptDb.access_key && this.tempKeyInput === deptDb.access_key) {
                        this.isSupervisor = false;
                        this.loggedUserName = this.tempDept;
                        localStorage.setItem('evo_is_supervisor', 'false');
                        localStorage.setItem('evo_user_name', this.tempDept);
                        this.loginSuccess();
                        return;
                    }

                    alert("Senha incorreta! Use a senha do supervisor ou de um atendente deste setor.");
                },

                loginSuccess() {
                    this.currentUserDept = this.tempDept;
                    localStorage.setItem('evo_user_dept', this.currentUserDept);
                    this.showKeyModal = false;
                    const roleLabel = this.currentUserDept === 'ADM Principal' ? 'Administrador' : (this.isSupervisor ? 'Supervisor' : 'Atendente');
                    this.addNotification('Acesso Liberado!', `${roleLabel}: ${this.loggedUserName} — Setor: ${this.currentUserDept}`, 'success');
                    this.loadColumns(); 
                    if (this.isSupervisor) this.loadDeptAtendentes();
                    this._refreshIcons();
                },

                // ── CRUD de atendentes do departamento (supervisor) ──
                async loadDeptAtendentes() {
                    const deptDb = this.departmentsDB.find(d => d.name === this.currentUserDept);
                    if (!deptDb) return;
                    try {
                        const { data } = await this.client.from('dept_atendentes')
                            .select('*')
                            .eq('instance_name', this.instanceName)
                            .eq('dept_id', deptDb.id)
                            .order('created_at', { ascending: true });
                        this.deptAtendentes = data || [];
                    } catch(e) { this.deptAtendentes = []; }
                },

                async addDeptAtendente(nome, senha) {
                    if (!nome || !senha) return alert('Preencha nome e senha do atendente!');
                    const deptDb = this.departmentsDB.find(d => d.name === this.currentUserDept);
                    if (!deptDb) return;
                    try {
                        const { error } = await this.client.from('dept_atendentes').insert({
                            instance_name: this.instanceName,
                            dept_id: deptDb.id,
                            nome: nome.trim(),
                            senha: senha.trim(),
                            ativo: 1
                        });
                        if (error) throw error;
                        this.addNotification('Sucesso', `Atendente "${nome}" criado!`, 'success');
                        await this.loadDeptAtendentes();
                    } catch(e) { alert('Erro ao criar atendente: ' + e.message); }
                },

                async removeDeptAtendente(id, nome) {
                    if (!confirm(`Excluir o atendente "${nome}" permanentemente?`)) return;
                    try {
                        await this.client.from('dept_atendentes').delete().eq('id', id);
                        this.addNotification('Removido', `Atendente "${nome}" excluído.`, 'info');
                        await this.loadDeptAtendentes();
                    } catch(e) { alert('Erro: ' + e.message); }
                },

                async toggleDeptAtendente(id, ativo) {
                    try {
                        await this.client.from('dept_atendentes').update({ ativo: ativo ? 0 : 1 }).eq('id', id);
                        await this.loadDeptAtendentes();
                    } catch(e) {}
                },

                async transferLead(leadId, novoDept) {
                    if(!confirm(`Transferir cliente para a fila de ${novoDept}?`)) return;
                    const idx = this.leads.findIndex(l => l.id === leadId);
                    if (idx !== -1) {
                        this.leads[idx].departamento = novoDept;
                        this.leads = [...this.leads];
                        await this.client.from('leads').update({ departamento: novoDept }).eq('id', leadId);
                        this.addNotification('Transferido', `Cliente enviado para ${novoDept}.`, 'success');
                        
                        const sysMsg = `*Transferência de Setor*\nO cliente foi transferido de ${this.currentUserDept} para: *${novoDept}*.`;
                        const tempId = 'sys-' + Date.now();
                        const tempMsgObj = { id: tempId, lead_id: leadId, content: sysMsg, from_me: true, type: 'text', status: 'sent', timestamp: new Date().toISOString() };
                        
                        if (this.isChatOpen && this.selectedLead?.id === leadId) {
                            this.messages = [...this.messages, tempMsgObj];
                            this.scrollToBottom();
                        }
                        this.updateLeadLocalInteraction(leadId, sysMsg, 'text');
                        this.client.from('messages').insert({ lead_id: leadId, content: sysMsg, from_me: true, type: 'text', status: 'sent', instance_name: this.instanceName }).then();

                        if(this.currentUserDept !== 'ADM Principal' && this.currentUserDept !== novoDept) {
                            this.isChatOpen = false; this.selectedLead = null;
                        }
                    }
                },


                // ═══════════════════════════════════════════════════════════
                // BUSCA GLOBAL
                // ═══════════════════════════════════════════════════════════
                globalSearchResults() {
                    const q = (this.globalSearchQ || '').toLowerCase().trim();
                    if (!q) return [];
                    return this.leads.filter(l => {
                        const nome = (l.nome || '').toLowerCase();
                        const num  = (l.numero || '').toLowerCase();
                        const tags = (l.etiquetas || '').toLowerCase();
                        const obs  = (l.observacao || '').toLowerCase();
                        const msg  = (l.last_msg || '').toLowerCase();
                        return nome.includes(q) || num.includes(q) || tags.includes(q) || obs.includes(q) || msg.includes(q);
                    }).slice(0, 12);
                },

                globalSearchSelect() {
                    const results = this.globalSearchResults();
                    if (results.length > 0) this.openChat(results[0]);
                    this.globalSearchQ = '';
                },

                // ═══════════════════════════════════════════════════════════
                // RESPOSTAS RÁPIDAS PERSONALIZADAS
                // ═══════════════════════════════════════════════════════════
                // ── PREFS: lê/salva preferências do usuário no servidor (admin_config) ──
                _prefKey(name) { return `prefs_${this.instanceName}_${name}`; },
                async _prefLoad(name, fallback) {
                    try {
                        const { data } = await this.client.from('admin_config').select('value').eq('key', this._prefKey(name)).single();
                        return data?.value !== undefined && data?.value !== null ? JSON.parse(data.value) : fallback;
                    } catch(e) { return fallback; }
                },
                async _prefSave(name, value) {
                    const key = this._prefKey(name);
                    try {
                        await this.client.from('admin_config').upsert({ key, value: JSON.stringify(value) }, { onConflict: 'key' });
                    } catch(e) { console.warn('[prefs] falha ao salvar', name, e.message); }
                },

                saveQuickReplies() {
                    this._prefSave('quick_replies', this.quickReplies);
                },

                addQuickReply() {
                    const atalho = (this.newQrAtalho || '').replace(/^\//, '').trim();
                    const texto  = (this.newQrTexto  || '').trim();
                    if (!atalho || !texto) return;
                    this.quickReplies.push({ atalho, texto });
                    this.saveQuickReplies();
                    this.newQrAtalho = '';
                    this.newQrTexto  = '';
                },
                // ═══════════════════════════════════════════════════════════
                async aiSummarizeLead() {
                    if (!this.selectedLead) return;
                    this.aiSummaryLoading = true;
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/ia/resumo`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: this.selectedLead.id })
                        });
                        const d = await resp.json();
                        if (!d.ok) throw new Error(d.error || 'Erro ao resumir');

                        // Atualiza lead local com o resumo já salvo pelo servidor
                        const idx = this.leads.findIndex(l => l.id === this.selectedLead.id);
                        if (idx !== -1) this.leads[idx] = { ...this.leads[idx], observacao: d.resumo };
                        this.selectedLead = { ...this.selectedLead, observacao: d.resumo };
                        this.addNotification('✅ Resumo', 'Resumo salvo na observação do lead', 'success');
                    } catch(e) {
                        this.addNotification('❌ Erro', 'Erro ao resumir: ' + e.message, 'error');
                    } finally {
                        this.aiSummaryLoading = false;
                    }
                },

                // ═══════════════════════════════════════════════════════════
                // IA UTILS — SUGESTÃO DE RESPOSTA (via servidor)
                // ═══════════════════════════════════════════════════════════
                async aiSuggestReply() {
                    if (!this.selectedLead) return;
                    this.aiSuggestLoading = true;
                    this.aiSuggestOpen   = false;
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/ia/sugestao`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: this.selectedLead.id })
                        });
                        const d = await resp.json();
                        if (!d.ok) throw new Error(d.error || 'Erro ao sugerir');
                        this.aiSuggestedReply = d.sugestao;
                        this.aiSuggestOpen = true;
                        this.$nextTick(() => lucide.createIcons());
                    } catch(e) {
                        this.addNotification('❌ Erro', 'Erro ao sugerir: ' + e.message, 'error');
                    } finally {
                        this.aiSuggestLoading = false;
                    }
                },

                aiUseSuggestion() {
                    this.msgInput = this.aiSuggestedReply;
                    this.aiSuggestOpen = false;
                    this.$nextTick(() => {
                        if (this.$refs.msgTextarea) {
                            this.$refs.msgTextarea.style.height = '46px';
                            this.$refs.msgTextarea.style.height = Math.min(this.$refs.msgTextarea.scrollHeight, 200) + 'px';
                            this.$refs.msgTextarea.focus();
                        }
                    });
                },



                // ═══════════════════════════════════════════════════════════
                // ANALYTICS — renderiza gráficos Chart.js no dashboard
                // ═══════════════════════════════════════════════════════════
                _dashCharts: {},
                async loadAtendimentoStats() {
                    this.atendimentoStatsLoading = true;
                    try {
                        const resp = await fetch(`/api/stats/tma-tme?inst=${encodeURIComponent(this.instanceName)}&periodo=${this.atendimentoStatsPeriodo}`);
                        const data = await resp.json();
                        if (data.ok) this.atendimentoStats = data.stats || [];
                    } catch(e) { console.error('[TMA/TME]', e); }
                    finally { this.atendimentoStatsLoading = false; }
                },

                async loadDashData() {
                    this.dashLoading = true;
                    try {
                        const r = await fetch(`/api/stats/dashboard?inst=${encodeURIComponent(this.instanceName)}`);
                        const d = await r.json();
                        if (d.ok) {
                            this.dashData = {
                                kpis: d.kpis || {},
                                departamentos: d.departamentos || [],
                                ranking: d.ranking || [],
                                porHora: d.porHora || [],
                            };
                        }
                    } catch(e) { console.error('[Dashboard]', e); }
                    finally { this.dashLoading = false; }
                },

                iniciarDashRefresh() {
                    this.loadDashData();
                    if (this._dashRefreshTimer) clearInterval(this._dashRefreshTimer);
                    this._dashRefreshTimer = setInterval(() => {
                        if (this.screen === 'atendimento') this.loadDashData();
                    }, 15000);
                },
                pararDashRefresh() {
                    if (this._dashRefreshTimer) { clearInterval(this._dashRefreshTimer); this._dashRefreshTimer = null; }
                },

                _iniciarTickSegundo() { /* tick permanente iniciado no initCrm */ },
                _pararTickSegundo() { /* tick permanente — não para */ },
                _tempoDecorrido(isoStr) {
                    if (!isoStr) return '—';
                    void this._tickSegundo;
                    const seg = Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
                    if (seg < 60) return seg + 's';
                    if (seg < 3600) { const m = Math.floor(seg/60), s = seg%60; return m + 'min' + (s>0 ? ' '+s+'s' : ''); }
                    const h = Math.floor(seg/3600), m = Math.floor((seg%3600)/60);
                    return h + 'h' + (m>0 ? ' '+m+'min' : '');
                },
                _fmtTempo(s) {
                    if (!s || s <= 0) return '—';
                    if (s < 60) return s + 's';
                    if (s < 3600) return Math.floor(s/60) + 'min';
                    return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'min';
                },

                // ── CHAT INTERNO ──────────────────────────────────────────────
                abrirChatInterno() {
                    this.chatTab = 'interno';
                    this.chatInternoNaoLidos = 0;
                    setTimeout(() => {
                        const box = document.getElementById('chat-interno-box');
                        if (box) box.scrollTop = box.scrollHeight;
                    }, 80);
                },
                fecharChatInterno() {
                    this.chatTab = 'cliente';
                },
                async carregarChatInterno(leadId) {
                    if (!leadId) return;
                    this.chatInternoLoading = true;
                    try {
                        const r = await fetch(`/api/chat-interno/listar?inst=${encodeURIComponent(this.instanceName)}&lead_id=${encodeURIComponent(leadId)}`);
                        const d = await r.json();
                        if (d.ok) this.chatInternoMsgs = d.msgs || [];
                    } catch(e) { console.error('[ChatInterno]', e); }
                    finally { this.chatInternoLoading = false; }
                },
                async enviarMsgInterna() {
                    const txt = (this.chatInternoInput || '').trim();
                    if (!txt || !this.selectedLead?.id) return;
                    const from = this.currentUserDept || 'ADM Principal';
                    this.chatInternoInput = '';
                    try {
                        const r = await fetch('/api/chat-interno/enviar', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: this.selectedLead.id, from_dept: from, content: txt })
                        });
                        const d = await r.json();
                        if (d.ok && d.msg) {
                            // Será adicionado via WS — mas garante localmente se WS demorar
                            if (!this.chatInternoMsgs.find(m => m.id === d.msg.id)) {
                                this.chatInternoMsgs = [...this.chatInternoMsgs, d.msg];
                            }
                            this.$nextTick(() => {
                                const box = document.getElementById('chat-interno-box');
                                if (box) box.scrollTop = box.scrollHeight;
                            });
                        }
                    } catch(e) { console.error('[ChatInterno enviar]', e); }
                },
                async chamarAdmin() {
                    const txt = '🔔 ' + (this.currentUserDept || 'Departamento') + ' está chamando o admin neste atendimento!';
                    this.chatInternoInput = txt;
                    await this.enviarMsgInterna();
                    this.addNotification('Admin chamado!', 'Sua solicitação foi enviada.', 'success');
                },
                _chatInternoFmtHora(iso) {
                    if (!iso) return '';
                    const d = new Date(iso);
                    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                },

                // ── FILA DE ATENDIMENTO ──
                async carregarFila() {
                    try {
                        const dept = this.currentUserDept || '';
                        const url = `/api/fila/listar?inst=${encodeURIComponent(this.instanceName)}` +
                                    (dept && dept !== 'ADM Principal' ? `&departamento=${encodeURIComponent(dept)}` : '');
                        const r = await fetch(url);
                        const d = await r.json();
                        if (!d.ok) return;
                        this.filaLista = d.fila || [];
                        this.filaAguardando = this.filaLista.length;
                        const map = {};
                        for (const item of this.filaLista) {
                            map[item.lead_id] = { posicao: item.posicao, departamento: item.departamento };
                        }
                        this.filaPorLead = map;
                    } catch(e) { console.error('[Fila]', e); }
                },
                _atualizarFilaLocal(update) {
                    // Atualização otimista a partir do WS; fonte de verdade continua sendo /api/fila/listar
                    if (!update) return;
                    const dept = this.currentUserDept || '';
                    const meuDept = !dept || dept === 'ADM Principal' || update.departamento === dept;
                    if (!meuDept) return;
                    // Simplificação: qualquer evento dispara recarregamento leve
                    this.carregarFila();
                },

                get ativosAgoraPorDept() {
                    void this._tickSegundo;
                    const ativos = this.leads.filter(l => l.instance_name === this.instanceName && l.atendimento_inicio && !l.atendimento_fim);
                    const grupos = {};
                    for (const l of ativos) {
                        const dept = l.departamento || 'ADM Principal';
                        if (!grupos[dept]) grupos[dept] = [];
                        grupos[dept].push(l);
                    }
                    for (const d of Object.keys(grupos)) grupos[d].sort((a,b) => new Date(a.atendimento_inicio)-new Date(b.atendimento_inicio));
                    return Object.entries(grupos).map(([dept,lista]) => ({dept,lista})).sort((a,b) => b.lista.length-a.lista.length);
                },

                renderDashCharts() {
                    if (typeof Chart === 'undefined') return;
                    const isDark = this.isDarkMode;
                    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
                    const textColor = isDark ? '#8b949e' : '#6b7280';

                    // ── Gráfico 1: Leads por Etiqueta ─────────────────────
                    const tagMap = {};
                    for (const lead of this.leads) {
                        (lead.etiquetas || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
                            tagMap[t] = (tagMap[t] || 0) + 1;
                        });
                    }
                    const tagEntries = Object.entries(tagMap).sort((a,b) => b[1]-a[1]).slice(0, 8);
                    const ctxTags = document.getElementById('chartTags');
                    if (ctxTags) {
                        if (this._dashCharts.tags) this._dashCharts.tags.destroy();
                        this._dashCharts.tags = new Chart(ctxTags, {
                            type: 'doughnut',
                            data: {
                                labels: tagEntries.length ? tagEntries.map(e => e[0]) : ['Sem etiquetas'],
                                datasets: [{ data: tagEntries.length ? tagEntries.map(e => e[1]) : [this.leads.length],
                                    backgroundColor: ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#84cc16'],
                                    borderWidth: 0 }]
                            },
                            options: { responsive: true, maintainAspectRatio: true, cutout: '65%',
                                plugins: { legend: { position: 'right', labels: { color: textColor, font: { size: 10, weight: 'bold' }, padding: 8, boxWidth: 10 } } } }
                        });
                    }

                    // ── Gráfico 2: Atividade dos últimos 7 dias ───────────
                    const days = [];
                    const dayCounts = [];
                    for (let i = 6; i >= 0; i--) {
                        const d = new Date(); d.setDate(d.getDate() - i);
                        const ds = d.toISOString().slice(0, 10);
                        days.push(d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric' }));
                        dayCounts.push(this.leads.filter(l => (l.last_interaction || l.created_at || '').startsWith(ds)).length);
                    }
                    const ctxAtiv = document.getElementById('chartAtividade');
                    if (ctxAtiv) {
                        if (this._dashCharts.ativ) this._dashCharts.ativ.destroy();
                        this._dashCharts.ativ = new Chart(ctxAtiv, {
                            type: 'bar',
                            data: {
                                labels: days,
                                datasets: [{ label: 'Interações', data: dayCounts,
                                    backgroundColor: 'rgba(99,102,241,0.7)', borderRadius: 8, borderSkipped: false }]
                            },
                            options: { responsive: true, maintainAspectRatio: true,
                                plugins: { legend: { display: false } },
                                scales: { x: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } },
                                          y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 }, stepSize: 1 }, beginAtZero: true } } }
                        });
                    }
                },


                // ═══════════════════════════════════════════════════════════
                // VALOR DO NEGÓCIO
                // ═══════════════════════════════════════════════════════════
                openLeadValorModal(lead) {
                    this.leadValorModal = { open: true, lead, valor: String(this.leadValores[lead.id] || '') };
                    this.$nextTick(() => lucide.createIcons());
                },
                saveLeadValor() {
                    const id = this.leadValorModal.lead?.id;
                    if (!id) return;
                    const val = parseFloat(String(this.leadValorModal.valor).replace(',', '.')) || 0;
                    if (val > 0) {
                        this.leadValores = { ...this.leadValores, [id]: val };
                    } else {
                        const v = { ...this.leadValores }; delete v[id]; this.leadValores = v;
                    }
                    localStorage.setItem('evo_lead_valores', JSON.stringify(this.leadValores));
                    this.leadValorModal.open = false;
                    this._toast(val > 0 ? '💰 Valor salvo' : 'Valor removido', 'success');
                },

                // ═══════════════════════════════════════════════════════════
                // SENTIMENTO — detecta via servidor ao abrir chat e em novos eventos
                // ═══════════════════════════════════════════════════════════
                async detectarSentimento(lead) {
                    if (!lead?.id) return;
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/ia/sentimento`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: lead.id })
                        });
                        const d = await resp.json();
                        if (d.ok && d.sentimento) {
                            this.leadSentimento = { ...this.leadSentimento, [lead.id]: d.sentimento };
                            // Atualiza também o campo no lead local (vem do banco via WS normalmente,
                            // mas atualizamos em memória imediatamente para a UI reagir)
                            const idx = this.leads.findIndex(l => l.id === lead.id);
                            if (idx !== -1) this.leads[idx] = { ...this.leads[idx], sentimento: d.sentimento };
                        }
                    } catch(e) {}
                },

                // Carrega sentimentos já salvos no banco (chamado ao iniciar/carregar leads)
                async carregarSentimentos() {
                    if (!this.leads || !this.leads.length) return;
                    const mapa = {};
                    for (const l of this.leads) {
                        if (l.sentimento) mapa[l.id] = l.sentimento;
                    }
                    this.leadSentimento = { ...mapa, ...this.leadSentimento };
                },

                // ═══════════════════════════════════════════════════════════
                // HISTÓRICO DE ATIVIDADES
                // ═══════════════════════════════════════════════════════════
                addActivityLog(tipo, descricao) {
                    const lead = this.selectedLead;
                    if (!lead) return;
                    const entry = { tipo, descricao, leadId: lead.id, ts: new Date().toISOString() };
                    const key = 'evo_activity_' + lead.id;
                    const saved = JSON.parse(localStorage.getItem(key) || '[]');
                    saved.unshift(entry);
                    localStorage.setItem(key, JSON.stringify(saved.slice(0, 100)));
                },
                openActivityLog() {
                    const lead = this.selectedLead;
                    if (!lead) return;
                    const key = 'evo_activity_' + lead.id;
                    const saved = JSON.parse(localStorage.getItem(key) || '[]');
                    // Merge with messages timeline
                    const msgEntries = (this.messages || []).slice(-20).map(m => ({
                        tipo: 'mensagem',
                        descricao: (m.from_me ? '📤 Enviado: ' : '📥 Recebido: ') + (m.content || '').substring(0, 60),
                        ts: m.created_at || m.timestamp || new Date().toISOString()
                    }));
                    this.activityLog = [...saved, ...msgEntries].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 60);
                    this.activityLogOpen = true;
                    this.$nextTick(() => lucide.createIcons());
                },

                // ═══════════════════════════════════════════════════════════
                // GRUPOS DE LEADS
                // ═══════════════════════════════════════════════════════════
                applyLeadGroup(grp) {
                    const now = Date.now();
                    const f = grp.filtro;
                    return this.leads.filter(l => {
                        if (f.tipo === 'unread') return l.unread > 0;
                        if (f.tipo === 'sem_resposta_1h') return l.unread > 0 && l.last_interaction && (now - new Date(l.last_interaction).getTime()) > 3600000;
                        if (f.tipo === 'sem_resposta_24h') return l.unread > 0 && l.last_interaction && (now - new Date(l.last_interaction).getTime()) > 86400000;
                        if (f.tipo === 'tag') return (l.etiquetas || '').toLowerCase().includes((f.valor || '').toLowerCase());
                        if (f.tipo === 'etapa') return l.status === f.valor;
                        return false;
                    });
                },
                applyLeadGroupFilter(grp) {
                    this.activeGroupFilter = grp;
                    this.screen = 'chats';
                    this._toast('Filtro "' + grp.nome + '" aplicado — ' + (grp.filtros?.length || 0) + ' regra(s)', 'info');
                },
                saveLeadGroups() {
                    this._prefSave('lead_groups', this.leadGroups);
                },


                checkQuickReply() {
                    const val = this.msgInput || '';
                    if (!val.startsWith('/')) return;
                    const slug = val.slice(1).toLowerCase();
                    const match = this.quickReplies.find(r => r.atalho.toLowerCase() === slug);
                    if (match) {
                        this.msgInput = match.texto;
                        this.$nextTick(() => {
                            if (this.$refs.msgTextarea) {
                                this.$refs.msgTextarea.style.height = '46px';
                                this.$refs.msgTextarea.style.height = Math.min(this.$refs.msgTextarea.scrollHeight, 200) + 'px';
                                this.$refs.msgTextarea.focus();
                            }
                        });
                    }
                },

                saveLeadGroup() {
                    if (!this.newGroupNome.trim()) return;
                    const descMap = {
                        unread: 'Não lidos', sem_resposta_1h: 'Sem resposta +1h',
                        sem_resposta_24h: 'Sem resposta +24h',
                        tag: 'Tag: ' + this.newGroupFiltroValor,
                        etapa: 'Etapa: ' + (this.columns.find(c => c.id === this.newGroupFiltroValor)?.name || this.newGroupFiltroValor)
                    };
                    this.leadGroups.push({
                        nome: this.newGroupNome.trim(),
                        filtro: { tipo: this.newGroupTipo, valor: this.newGroupFiltroValor, descricao: descMap[this.newGroupTipo] || this.newGroupTipo }
                    });
                    this.saveLeadGroups();
                    this.newGroupNome = ''; this.newGroupFiltroValor = '';
                    this.addNotification('✅ Grupos', 'Grupo salvo!', 'success');
                },

                // ═══════════════════════════════════════════════════════════
                // TEMA PERSONALIZÁVEL
                // ═══════════════════════════════════════════════════════════
                applyThemeColor() {
                    this._prefSave('theme_color', this.themeColor);
                    document.documentElement.style.setProperty('--color-primary', this.themeColor);
                    // Convert hex to RGB for opacity variants
                    const hex = this.themeColor.replace('#', '');
                    const r = parseInt(hex.substring(0,2), 16);
                    const g = parseInt(hex.substring(2,4), 16);
                    const b = parseInt(hex.substring(4,6), 16);
                    document.documentElement.style.setProperty('--color-primary-rgb', r + ',' + g + ',' + b);
                    // Inject style override
                    let style = document.getElementById('evo-theme-override');
                    if (!style) { style = document.createElement('style'); style.id = 'evo-theme-override'; document.head.appendChild(style); }
                    style.textContent = `
                        .bg-\[\#6366f1\] { background-color: ${this.themeColor} !important; }
                        .text-\[\#6366f1\] { color: ${this.themeColor} !important; }
                        .border-\[\#6366f1\] { border-color: ${this.themeColor} !important; }
                        .hover\:bg-\[\#6366f1\]:hover { background-color: ${this.themeColor} !important; }
                        .focus\:border-\[\#6366f1\]:focus { border-color: ${this.themeColor} !important; }
                        .wa-tab.active { border-bottom-color: ${this.themeColor}; color: ${this.themeColor}; }
                    `;
                },

                // ═══════════════════════════════════════════════════════════
                // WEBHOOK DE SAÍDA
                // ═══════════════════════════════════════════════════════════
                saveWebhookSettings() {
                    localStorage.setItem('evo_webhook_url', this.webhookUrl);
                    localStorage.setItem('evo_webhook_events', JSON.stringify(this.webhookEvents));
                    this.settingsOpen = false;
                    this.addNotification('✅ Configurações', 'Configurações salvas', 'success');
                },
                async fireWebhook(eventId, data) {
                    if (!this.webhookUrl) return;
                    const ev = this.webhookEvents.find(e => e.id === eventId);
                    if (!ev || !ev.ativo) return;
                    try {
                        await fetch(this.webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                evento: eventId,
                                instancia: this.instanceName,
                                timestamp: new Date().toISOString(),
                                dados: data
                            })
                        });
                    } catch(e) { console.warn('[Webhook]', e.message); }
                },

                getLeadName(lead) {
                    if(!lead) return 'Desconhecido';
                    if(lead.nome && lead.nome !== lead.numero) return lead.nome;
                    if(lead.name) return lead.name;
                    if(lead.pushName) return lead.pushName;
                    return lead.nome || lead.numero || 'Desconhecido';
                },

                async updateLeadLocalInteraction(leadId, content, type = 'text', incrementUnread = false) {
                    const idx = this.leads.findIndex(l => l.id === leadId);
                    if (idx === -1) return; // lead não encontrado — não criar duplicata
                    
                    const original = this.leads[idx];
                    // Cria cópia preservando TODOS os campos críticos explicitamente
                    let updated = { 
                        ...original,
                        // Campos imutáveis que NUNCA devem mudar
                        id: original.id,
                        numero: original.numero,
                        nome: original.nome,
                        foto_url: original.foto_url,
                        instance_name: original.instance_name
                    };
                    updated.last_interaction = new Date().toISOString();
                    
                    // Remove prefixo de setor "*NOME DO SETOR*:\n" do last_msg
                    let cleanContent = (content || '').replace(/^\*[^*]+\*:\n/, '');

                    if (cleanContent.includes('supabase.co/storage') || isStorageUrl(cleanContent)) {
                        if (cleanContent.includes('.jpg') || cleanContent.includes('.png') || cleanContent.includes('.webp')) updated.last_msg = 'Imagem';
                        else if (cleanContent.includes('.ogg') || cleanContent.includes('.mp3')) updated.last_msg = 'Áudio';
                        else if (cleanContent.includes('.mp4') || cleanContent.includes('.mov')) updated.last_msg = 'Vídeo';
                        else updated.last_msg = 'Arquivo';
                    } else {
                        updated.last_msg = type === 'text' ? cleanContent : `[${type.toUpperCase()}]`;
                    }

                    if (incrementUnread && (!this.isChatOpen || this.selectedLead?.id !== leadId)) {
                        updated.unread = (updated.unread || 0) + 1;
                    } else if (this.isChatOpen && this.selectedLead?.id === leadId) {
                        updated.unread = 0;
                    }
                    
                    this.leads[idx] = updated; 
                    this.leads = [...this.leads];
                    
                    // Atualiza selectedLead se for o mesmo (mantendo sincronização)
                    if (this.selectedLead?.id === leadId) {
                        this.selectedLead = { ...this.selectedLead, last_interaction: updated.last_interaction, last_msg: updated.last_msg, unread: updated.unread };
                    }
                    
                    try { await this.client.from('leads').update({ last_interaction: updated.last_interaction, last_msg: updated.last_msg, unread: updated.unread || 0 }).eq('id', leadId); } catch(e) {}
                },

                resolveTempMessage(tempId, realData) {
                    if (!realData) return;
                    const tempIdx = this.messages.findIndex(m => m.id === tempId);
                    const exists = this.messages.find(m => m.id === realData.id);
                    let newMsgs = [...this.messages];
                    if (exists && tempIdx !== -1) { newMsgs.splice(tempIdx, 1); } 
                    else if (tempIdx !== -1) { newMsgs[tempIdx] = realData; } 
                    else if (!exists) { newMsgs.push(realData); }
                    this.messages = newMsgs;
                    this.scrollToBottom();
                    this._refreshIcons();
                },

                async init() {
                    // Alias _toast → addNotification (usado em partes do código)
                    this._toast = (msg, type = 'info') => this.addNotification(
                        type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️',
                        msg, type === 'success' ? 'success' : type === 'error' ? 'error' : 'info'
                    );

                    // ✅ Carrega configuração do servidor (EVO_URL, EVO_KEY, etc.)
                    try {
                        const cfgRes = await fetch(SERVER_URL + '/api/config');
                        if (cfgRes.ok) {
                            const cfg = await cfgRes.json();
                            if (cfg.evo_url) this.EVO_URL = cfg.evo_url;
                            if (cfg.evo_key) this.EVO_KEY = cfg.evo_key;
                        }
                    } catch(e) { console.warn('[init] Falha ao carregar /api/config:', e.message); }

                    // Cliente REST local — substitui supabase.createClient
                    this.client = makeDbClient(SERVER_URL);
                    window._evoSupabase = this.client; // compatibilidade com dashboard
                    this._refreshIcons();
                    if (this.instanceName) { 
                        // Revalida o plano no banco ao restaurar sessão
                        try {
                            const { data } = await this.client.from('licenses').select('plano, features, status, expires_at, is_trial, renewal_url').eq('instance_name', this.instanceName).single();
                            if (data) {
                                this.clientePlano = data.plano || 'basico';
                                const f = data.features;
                                this.clienteFeatures = (f && typeof f === 'object' && Object.keys(f).length > 0) ? f : null;
                                this.clienteExpiresAt = data.expires_at || null;
                                this.clienteIsTrial = data.is_trial || false;
                                this.clienteRenewalUrl = data.renewal_url || null;
                                localStorage.setItem('evo_plano', this.clientePlano);
                                localStorage.setItem('evo_features', JSON.stringify(this.clienteFeatures));
                                localStorage.setItem('evo_expires_at', this.clienteExpiresAt || '');
                                localStorage.setItem('evo_is_trial', String(this.clienteIsTrial));
                                localStorage.setItem('evo_renewal_url', this.clienteRenewalUrl || '');
                                if (data.status !== 'active' || (data.expires_at && new Date(data.expires_at) < new Date())) {
                                    this.doLogout(); return;
                                }
                            }
                        } catch(e) { /* usa plano salvo localmente como fallback */ }
                        this.appState = 'crm'; this.initCrm(); 
                    }
                },

                async doLogin() {
                    if (!this.loginInput.trim() || !this.loginKey.trim()) return alert("Digite o nome da Instância e a sua Licença!");
                    this.isCheckingLicense = true;
                    const inst = this.loginInput.trim().toLowerCase();
                    
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/auth/login`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ instance_name: inst, license_key: this.loginKey.trim() })
                        });
                        const { data, error } = await resp.json();
                        if (!resp.ok || error || !data) { alert(error || "Acesso Negado: Instância ou Licença inválida."); this.isCheckingLicense = false; return; }
                        
                        this.instanceName = inst;
                        this.clientePlano = data.plano || 'basico';
                        const feat = data.features;
                        this.clienteFeatures = (feat && typeof feat === 'object' && Object.keys(feat).length > 0) ? feat : null;
                        this.clienteExpiresAt = data.expires_at || null;
                        this.clienteIsTrial = data.is_trial || false;
                        this.clienteRenewalUrl = data.renewal_url || null;
                        localStorage.setItem('evo_instance', this.instanceName);
                        localStorage.setItem('evo_plano', this.clientePlano);
                        localStorage.setItem('evo_features', JSON.stringify(this.clienteFeatures));
                        localStorage.setItem('evo_expires_at', this.clienteExpiresAt || '');
                        localStorage.setItem('evo_is_trial', String(this.clienteIsTrial));
                        localStorage.setItem('evo_renewal_url', this.clienteRenewalUrl || '');
                        this.appState = 'crm';
                        this.initCrm();
                    } catch(e) { alert("Erro ao validar licença."); }
                    this.isCheckingLicense = false;
                },
                
                staffOptions: [],
                showStaffSelector: false,

                async doStaffLogin(nome, senha) {
                    if (!nome?.trim() || !senha?.trim()) return;
                    this.isCheckingLicense = true;
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/auth/staff-login`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ nome: nome.trim(), senha: senha.trim() })
                        });
                        const result = await resp.json();
                        if (!resp.ok || result.error) {
                            this._setStaffError(result.error || 'Credenciais inválidas');
                            this.isCheckingLicense = false;
                            return;
                        }

                        // Múltiplas correspondências — pede para escolher
                        if (result.multiple) {
                            this.staffOptions = result.options;
                            this.showStaffSelector = true;
                            this.isCheckingLicense = false;
                            return;
                        }

                        this._completeStaffLogin(result);
                    } catch(e) {
                        this._setStaffError('Erro de conexão');
                    }
                    this.isCheckingLicense = false;
                },

                selectStaffOption(opt) {
                    this.showStaffSelector = false;
                    this._completeStaffLogin(opt);
                },

                _setStaffError(msg) {
                    try {
                        const el = document.querySelector('[x-data*="staffError"]');
                        if (el && el.__x) el.__x.$data.staffError = msg;
                        else if (el && el._x_dataStack) el._x_dataStack[0].staffError = msg;
                    } catch(e) {}
                },

                _completeStaffLogin(result) {
                    const lic = result.license;
                    this.instanceName = result.instance_name;
                    this.clientePlano = lic.plano || 'basico';
                    const feat = lic.features;
                    this.clienteFeatures = (feat && typeof feat === 'object' && Object.keys(feat).length > 0) ? feat : (typeof feat === 'string' ? (() => { try { return JSON.parse(feat) } catch { return null } })() : null);
                    this.clienteExpiresAt = lic.expires_at || null;
                    this.clienteIsTrial = lic.is_trial || false;
                    this.clienteRenewalUrl = lic.renewal_url || null;
                    localStorage.setItem('evo_instance', this.instanceName);
                    localStorage.setItem('evo_plano', this.clientePlano);
                    localStorage.setItem('evo_features', JSON.stringify(this.clienteFeatures));
                    localStorage.setItem('evo_expires_at', this.clienteExpiresAt || '');
                    localStorage.setItem('evo_is_trial', String(this.clienteIsTrial));
                    localStorage.setItem('evo_renewal_url', this.clienteRenewalUrl || '');

                    this.currentUserDept = result.departamento;
                    this.loggedUserName = result.nome;
                    this.isSupervisor = result.role === 'supervisor';
                    localStorage.setItem('evo_user_dept', this.currentUserDept);
                    localStorage.setItem('evo_user_name', this.loggedUserName);
                    localStorage.setItem('evo_is_supervisor', String(this.isSupervisor));

                    this.appState = 'crm';
                    this.initCrm();
                },

                doLogout() {
                    localStorage.removeItem('evo_instance'); localStorage.removeItem('evo_user_dept'); localStorage.removeItem('evo_plano'); localStorage.removeItem('evo_features'); localStorage.removeItem('evo_expires_at'); localStorage.removeItem('evo_is_trial'); localStorage.removeItem('evo_renewal_url'); localStorage.removeItem('evo_is_supervisor'); localStorage.removeItem('evo_user_name');
                    this.instanceName = ''; this.loginInput = ''; this.loginKey = ''; this.currentUserDept = ''; this.isSupervisor = false; this.loggedUserName = ''; this.deptAtendentes = []; this.clientePlano = 'basico'; this.clienteFeatures = null; this.clienteExpiresAt = null; this.clienteIsTrial = false; this.clienteRenewalUrl = null;
                    this.appState = 'login'; this.leads = []; this.messages = []; this.botRules = [];
                },
                
                openAdminAuth() {
                    const pass = prompt("Digite a senha Master:");
                    if (pass === 'admin123') {
                        window.location.href = 'admin.html'; 
                    } else { alert("Senha Incorreta!"); }
                },

                async loadUserPrefs() {
                    // Carrega todas as preferências do servidor em paralelo
                    const [qr, tc, lg] = await Promise.all([
                        this._prefLoad('quick_replies', []),
                        this._prefLoad('theme_color', '#6366f1'),
                        this._prefLoad('lead_groups', []),
                    ]);
                    this.quickReplies = Array.isArray(qr) ? qr : [];
                    this.themeColor   = typeof tc === 'string' ? tc : '#6366f1';
                    this.leadGroups   = Array.isArray(lg) ? lg : [];
                },

                async initCrm() {
                    await this.loadUserPrefs();
                    if (this.themeColor !== '#6366f1') this.applyThemeColor();
                    await this.loadDepartments(); 
                    if (!this.currentUserDept) { this.showDeptModal = true; }
                    if (this.isSupervisor) this.loadDeptAtendentes();
                    await this.loadColumns(); 
                    await this.loadLeads();
                    await this.loadTags();
                    
                    this.syncMissingProfilePics();
                    // Carrega nome do operador e corrige leads que foram nomeados errado
                    this._carregarNomeOperador().then(() => this._corrigirLeadsComNomeOperador());
                    
                    await this.loadBotRules(); this.loadAgendamentos(); this.loadAgendaConfig(); this.arCarregarDados(); this.setupRealtime(); this.setupVisibilityReload(); await this.iaCarregarConfig(); await this._carregarPausasDB(); await this._bufferCarregarDB(); this.iaLoadSavedPrompts(); await this.iaCarregarMidias(); this._initBookmarkletChannel();
                    this.checkConnection();
                    this.loadDisparoModelos();
                    this._restoreDisparoState(); // restaurar campanha pausada
                    
                    // ══════════════════════════════════════════════════════
                    // SISTEMA DE SEGUNDO PLANO - Mantém tudo funcionando
                    // ══════════════════════════════════════════════════════
                    
                    // Wake Lock para manter dispositivo acordado durante operações
                    this.setupWakeLock();
                    // Tick de 1s para timers ao vivo (TMA/TME dashboard)
                    setInterval(() => { this._tickSegundo++; }, 1000);
                    
                    // Intervalos robustos que funcionam em segundo plano
                    this.setupBackgroundIntervals();
                    
                    // Notificações nativas do navegador
                    this.setupNativeNotifications();

                    // Atalho de teclado: Ctrl+Shift+P → ativa/desativa Modo Demo
                    document.addEventListener('keydown', (e) => {
                        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
                            e.preventDefault();
                            this.togglePrivacyMode();
                        }
                    });
                    
                    // Detectar quando aba volta a ficar ativa
                    this._lastHiddenAt = null;
                    document.addEventListener('visibilitychange', () => {
                        if (document.hidden) {
                            this._lastHiddenAt = Date.now();
                        } else {
                            this.syncAfterBackground();
                        }
                    });
                },
                
                setupWakeLock() {
                    if ('wakeLock' in navigator) {
                        this.requestWakeLock();
                        
                        // Re-adquirir wake lock quando a aba volta a ficar visível
                        document.addEventListener('visibilitychange', async () => {
                            if (!document.hidden && this.wakeLock === null) {
                                await this.requestWakeLock();
                            }
                        });
                    }
                },
                
                async requestWakeLock() {
                    try {
                        this.wakeLock = await navigator.wakeLock.request('screen');
                        console.log('Wake Lock ativo - dispositivo permanecerá acordado');
                    } catch (err) {
                        console.log('Wake Lock não suportado');
                    }
                },
                
                setupBackgroundIntervals() {
                    // Checagem de agendamentos a cada 30s — FALLBACK BROWSER
                    // O servidor (server.js) é o responsável principal. O browser serve como redundância
                    // caso o servidor esteja inativo. A tabela Supabase evita envios duplos (sent=true).
                    setInterval(() => {
                        if (this.appState === 'crm' && !document.hidden) {
                            this.checkAgendamentos();
                        }
                    }, 30000);
                    
                    // Checagem de conexão a cada 8s (era 5s), só na tela correta
                    setInterval(() => {
                        if (this.screen === 'conexao' && this.qrStatus !== 'connected' && this.appState === 'crm') {
                            this.checkConnection();
                        }
                    }, 8000);
                    
                    // Sincronização periódica de leads a cada 60s (era 30s), só com aba visível
                    setInterval(() => {
                        if (this.appState === 'crm' && !document.hidden) {
                            this.backgroundSyncLeads();
                        }
                    }, 60000);
                    
                    // Persistência de estado a cada 30s (era 10s) — localStorage é síncrono, trava UI
                    setInterval(() => {
                        if (!document.hidden) this.saveStateToStorage();
                    }, 30000);
                },
                
                setupNativeNotifications() {
                    // Solicitar permissão se ainda não foi concedida
                    if ('Notification' in window && Notification.permission === 'default') {
                        Notification.requestPermission();
                    }
                },
                
                showNativeNotification(title, message, tag = 'evocrm') {
                    if ('Notification' in window && Notification.permission === 'granted') {
                        const notification = new Notification(title, {
                            body: message,
                            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%2300a884" width="100" height="100" rx="20"/><path fill="white" d="M50 25l-7 20h-18l15 11-6 19 16-12 16 12-6-19 15-11H57z"/></svg>',
                            tag: tag,
                            requireInteraction: false,
                            silent: false
                        });
                        
                        // Fechar automaticamente após 5 segundos
                        setTimeout(() => notification.close(), 5000);
                        
                        // Focar na aba quando clicar na notificação
                        notification.onclick = () => {
                            window.focus();
                            notification.close();
                        };
                    }
                },
                
                async backgroundSyncLeads() {
                    try {
                        const { data } = await this.client.from('leads')
                            .select('*')
                            .eq('instance_name', this.instanceName)
                            .order('last_interaction', { ascending: false })
                            .limit(100);
                        
                        if (data && data.length > 0) {
                            // Comparação leve: checa só ids+last_interaction, evita JSON.stringify do array todo
                            const newSig = data.map(l => l.id + (l.last_interaction || '')).join(',');
                            const oldSig = (this.leads.slice(0, 100)).map(l => l.id + (l.last_interaction || '')).join(',');
                            if (newSig !== oldSig) {
                                this.leads = data;
                            }
                        }
                    } catch (e) {
                        // silencioso em background
                    }
                },
                
                saveStateToStorage() {
                    try {
                        const state = {
                            disparoConfig: this.disparoConfig,
                            screen: this.screen,
                            lastSync: new Date().toISOString()
                        };
                        localStorage.setItem(`evo_state_${this.instanceName}`, JSON.stringify(state));
                    } catch (e) {
                        console.error('Erro ao salvar estado:', e);
                    }
                },
                
                async syncAfterBackground() {
                    // Evita sync se aba ficou oculta por menos de 10s
                    const now = Date.now();
                    if (this._lastHiddenAt && (now - this._lastHiddenAt) < 10000) return;
                    await this.loadLeads();
                    this.checkConnection();
                    this._refreshIcons(120);
                },


                // ─── CARREGAR NOME DO OPERADOR ────────────────────────────────────────────
                // Busca o profileName da instância na Evolution API para nunca salvar
                // o nome do operador como nome de lead.
                async _carregarNomeOperador() {
                    if (!this._operatorNames) this._operatorNames = new Set();
                    try {
                        const r = await fetch(`${this.EVO_URL}/instance/fetchInstances`, {
                            headers: { 'apikey': this.EVO_KEY }
                        });
                        if (!r.ok) return;
                        const lista = await r.json();
                        const instancias = Array.isArray(lista) ? lista : [lista];
                        for (const item of instancias) {
                            const info = item?.instance || item;
                            const nome = info?.profileName || null;
                            const instNome = info?.instanceName || item?.name || '';
                            if (nome && instNome === this.instanceName) {
                                this._operatorNames.add(nome.trim());
                                console.log(`[Operador] Nome carregado: "${nome}"`);
                            }
                        }
                    } catch(e) { console.warn('[Operador] Falha ao buscar nome:', e.message); }
                },

                // ─── CORRIGIR LEADS COM NOME DO OPERADOR ──────────────────────────────────
                // Varre todos os leads e auto-corrige os que têm o nome do operador.
                // Chamado 1x no initCrm, após _carregarNomeOperador.
                async _corrigirLeadsComNomeOperador() {
                    if (!this._operatorNames || this._operatorNames.size === 0) return;
                    const comNomeErrado = this.leads.filter(l =>
                        l.nome && this._operatorNames.has(l.nome.trim())
                    );
                    if (comNomeErrado.length === 0) return;
                    console.log(`[Operador] ${comNomeErrado.length} lead(s) com nome do operador — corrigindo...`);
                    for (const lead of comNomeErrado) {
                        await this._sincronizarPerfilLead(lead);
                        await new Promise(r => setTimeout(r, 800));
                    }
                },

                async syncMissingProfilePics() {
                    const leadsToSync = this.leads.filter(l => !l.foto_url || l.foto_url.includes('dicebear') || this._isFotoExpirada(l.foto_url));
                    for (const lead of leadsToSync) { await this.updateSingleProfilePic(lead); await new Promise(r => setTimeout(r, 1000)); }
                },

                // Detecta URLs do CDN do WhatsApp que expiram (mmg.whatsapp.net, media*.fcdn.*)
                _isFotoExpirada(url) {
                    if (!url || !url.startsWith('http')) return true;
                    if (url.includes('dicebear') || url === 'default') return true;
                    // URLs do CDN do WhatsApp contêm parâmetro de expiração "oe=" ou "oh="
                    // Exemplo: https://mmg.whatsapp.net/...&oe=XXXXXXXX (hex timestamp Unix)
                    const match = url.match(/[?&]oe=([0-9a-fA-F]+)/);
                    if (match) {
                        const expTs = parseInt(match[1], 16) * 1000; // converte hex Unix → ms
                        if (expTs < Date.now()) return true; // já expirou
                        if (expTs < Date.now() + 6 * 60 * 60 * 1000) return true; // expira em < 6h
                    }
                    return false;
                },

                async updateSingleProfilePic(lead) {
                    if (!lead?.numero || !lead?.id) return;
                    
                    // Cache de fotos já buscadas — 6h para URLs novas, 1min se estava expirada
                    if (!this._picCache) this._picCache = {};
                    const cacheKey = lead.id;
                    const now = Date.now();
                    const jaTemFotoValida = lead.foto_url && !this._isFotoExpirada(lead.foto_url);
                    const cacheTTL = jaTemFotoValida ? 6 * 60 * 60 * 1000 : 60 * 1000;
                    if (this._picCache[cacheKey] && (now - this._picCache[cacheKey].at) < cacheTTL) {
                        return;
                    }
                    
                    // Evita múltiplas chamadas simultâneas para o mesmo lead
                    if (!this._picFetching) this._picFetching = {};
                    if (this._picFetching[lead.id]) return;
                    this._picFetching[lead.id] = true;
                    
                    // Guarda dados originais para garantir que não perdemos nada
                    const leadId = lead.id;
                    const leadNumero = lead.numero;
                    const leadNome = lead.nome;
                    
                    try {
                        const cleanNumber = leadNumero.replace(/\D/g, '');
                        let picUrl = null;

                        // Proxy no servidor
                        try {
                            const res = await fetch(`/api/profile-pic/${cleanNumber}?inst=${this.instanceName}`);
                            if (res.ok) { const data = await res.json(); picUrl = data.url || null; }
                        } catch(e) {}

                        // Fallback direto
                        if (!picUrl) {
                            try {
                                const resPost = await fetch(`${this.EVO_URL}/chat/fetchProfilePictureUrl/${this.instanceName}`, {
                                    method: 'POST', headers: { 'apikey': this.EVO_KEY, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ number: cleanNumber })
                                });
                                if (resPost.ok) { const d = await resPost.json(); picUrl = d.profilePictureUrl || d.pictureUrl || d.picture || d.url || null; }
                            } catch(e) {}
                        }

                        // Marca como já buscado (mesmo se não encontrou)
                        this._picCache[cacheKey] = { at: now };

                        // Só salva no banco se tiver URL válida — evita sobrescrever com null/default
                        if (picUrl && picUrl.startsWith('http')) {
                            // Update no DB dispara Realtime para TODAS as abas/instâncias
                            await this.client.from('leads').update({ foto_url: picUrl, updated_at: new Date().toISOString() }).eq('id', leadId);
                            const idx = this.leads.findIndex(l => l.id === leadId);
                            if (idx !== -1) { 
                                // Atualiza apenas foto, preservando todos os outros campos
                                this.leads[idx] = { ...this.leads[idx], foto_url: picUrl }; 
                                this.leads = [...this.leads]; 
                            }
                            if (this.selectedLead?.id === leadId) {
                                this.selectedLead = { ...this.selectedLead, foto_url: picUrl };
                            }
                        }
                    } catch(e) { console.error('Erro foto:', e); }
                    finally { delete this._picFetching[lead.id]; }
                },

                async forceUpdateProfilePic(lead) { 
                    if(!lead || this.isUpdatingPic) return; 
                    this.isUpdatingPic = true; 
                    await this._sincronizarPerfilLead(lead);
                    this.addNotification('Aviso', 'Tentativa de atualização concluída.', 'info');
                    this.isUpdatingPic = false; 
                },

                // Chamado pelo @error das <img> de foto — limpa URL expirada e re-busca
                async onPhotoError(lead, imgEl) {
                    if (!lead?.id) return;
                    const seed = lead.numero || lead.id;
                    if (imgEl) imgEl.src = `https://api.dicebear.com/8.x/notionists/svg?seed=${seed}`;
                    
                    // Limpa URL inválida do banco para forçar nova busca
                    const idx = this.leads.findIndex(l => l.id === lead.id);
                    if (idx !== -1) {
                        this.leads[idx] = { ...this.leads[idx], foto_url: null };
                        this.leads = [...this.leads];
                    }
                    if (this.selectedLead?.id === lead.id) {
                        this.selectedLead = { ...this.selectedLead, foto_url: null };
                    }
                    // Limpa do banco (sem await — fire and forget)
                    this.client.from('leads').update({ foto_url: null }).eq('id', lead.id).then();
                    // Remove do cache para permitir nova busca imediata
                    if (this._picCache?.[lead.id]) delete this._picCache[lead.id];
                    // Re-busca foto após 2s
                    setTimeout(() => this.updateSingleProfilePic({ ...lead, foto_url: null }), 2000);
                },

                // Sincroniza nome + foto de um lead em uma chamada só
                async _sincronizarPerfilLead(lead) {
                    if (!lead?.numero || !lead?.id) return;
                    
                    // Guarda ID e número antes de qualquer operação async
                    const leadId = lead.id;
                    const leadNumero = lead.numero;
                    const leadNomeOriginal = lead.nome;
                    
                    // Evita sincronização duplicada
                    if (!this._syncFetching) this._syncFetching = {};
                    if (this._syncFetching[leadId]) return;
                    this._syncFetching[leadId] = true;
                    
                    try {
                        const cleanNumber = leadNumero.replace(/\D/g, '');
                        let picUrl = null, nomeWA = null;

                        // Busca foto
                        try {
                            const res = await fetch(`/api/profile-pic/${cleanNumber}?inst=${this.instanceName}`);
                            if (res.ok) { const d = await res.json(); picUrl = d.url || null; }
                        } catch(e) {}
                        if (!picUrl) {
                            try {
                                const r = await fetch(`${this.EVO_URL}/chat/fetchProfilePictureUrl/${this.instanceName}`, {
                                    method: 'POST', headers: { 'apikey': this.EVO_KEY, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ number: cleanNumber })
                                });
                                if (r.ok) { const d = await r.json(); picUrl = d.profilePictureUrl || d.pictureUrl || d.picture || d.url || null; }
                            } catch(e) {}
                        }

                        // Busca nome real se: lead sem nome, nome genérico, ou nome é do operador
                        const nomePareceDoperador = (this._operatorNames?.size > 0)
                            && this._operatorNames.has((leadNomeOriginal || '').trim());
                        const semNome = !leadNomeOriginal || leadNomeOriginal === leadNumero
                            || ['Lead Avulso', 'Lead Importado', 'Desconhecido'].includes(leadNomeOriginal)
                            || nomePareceDoperador;
                        if (semNome) {
                            try {
                                const r = await fetch(window.location.origin + '/api/check-whatsapp', {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ inst: this.instanceName, numbers: [cleanNumber] })
                                });
                                if (r.ok) {
                                    const d = await r.json();
                                    const info = Array.isArray(d) ? d[0] : d;
                                    // ⚠️ Usa APENAS pushName/notifyName — evita info.name do contato
                                    nomeWA = info?.pushName || info?.notifyName || null;
                                    if (nomeWA === cleanNumber || nomeWA === leadNumero) nomeWA = null;
                                    // ⚠️ Nunca salvar nome do operador como nome de lead
                                    if (nomeWA && this._operatorNames?.has(nomeWA.trim())) nomeWA = null;
                                }
                            } catch(e) {}
                        }

                        // Monta update — só campos com valor real
                        const updates = {};
                        if (picUrl && picUrl.startsWith('http')) updates.foto_url = picUrl;
                        if (nomeWA && nomeWA.length > 1 && nomeWA !== cleanNumber) updates.nome = nomeWA;
                        if (Object.keys(updates).length === 0) return;

                        // Atualiza no banco
                        await this.client.from('leads').update(updates).eq('id', leadId);
                        
                        // Atualiza localmente usando o ID guardado (não o objeto lead que pode ter mudado)
                        const idx = this.leads.findIndex(l => l.id === leadId);
                        if (idx !== -1) {
                            // Preserva todos os campos existentes, só atualiza o que veio
                            this.leads[idx] = { ...this.leads[idx], ...updates };
                            this.leads = [...this.leads];
                        }
                        if (this.selectedLead?.id === leadId) {
                            this.selectedLead = { ...this.selectedLead, ...updates };
                        }
                    } catch(e) { 
                        console.error('[Perfil] Erro ao salvar:', e); 
                    } finally {
                        delete this._syncFetching[leadId];
                    }
                },

                async loadColumns() {
                    try {
                        const { data } = await this.client.from('kanban_columns').select('columns_json').eq('instance_name', this.instanceName).single();
                        let parsed = {};
                        if (data && data.columns_json) {
                            // columns_json pode chegar já parseado (db.js normaliza JSON_FIELDS)
                            // ou como string (fallback). Tratar os dois casos.
                            if (typeof data.columns_json === 'string') {
                                parsed = JSON.parse(data.columns_json);
                            } else {
                                parsed = data.columns_json;
                            }
                        } else {
                            const savedCols = localStorage.getItem(`evo_cols_${this.instanceName}`);
                            if(savedCols) parsed = JSON.parse(savedCols);
                        }

                        if (Array.isArray(parsed)) {
                            this.allColumnsMap = { 'ADM Principal': parsed };
                        } else {
                            this.allColumnsMap = parsed || {};
                        }

                        this.columns = this.allColumnsMap[this.currentUserDept] || [
                            { id: 'novo_lead',    name: 'Triagem',   ia_ativo: false, ia_descricao: '' },
                            { id: 'atendimento',  name: 'Negócio',   ia_ativo: false, ia_descricao: '' },
                            { id: 'proposta',     name: 'Proposta',  ia_ativo: false, ia_descricao: '' },
                            { id: 'fechado',      name: 'Venda',     ia_ativo: false, ia_descricao: '' }
                        ];
                        // Garante que colunas antigas (sem ia_ativo) recebam os campos novos
                        this.columns = this.columns.map(c => ({ ia_ativo: false, ia_descricao: '', is_final: false, ...c }));
                    } catch(e) {}
                },

                async saveColumnsToDB() {
                    try {
                        this.allColumnsMap[this.currentUserDept] = this.columns;
                        await this.client.from('kanban_columns').upsert({
                            instance_name: this.instanceName,
                            columns_json: JSON.stringify(this.allColumnsMap),
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'instance_name' });
                    } catch(e) { console.error('[Kanban] Erro ao salvar colunas:', e); }
                },

                editColumn(col) {
                    const newName = prompt("Editar nome da etapa:", col.name);
                    if(newName && newName.trim() !== '') {
                        col.name = newName.trim();
                        this.saveColumnsToDB();
                        this._refreshIcons();
                    }
                },

                addColumn() {
                    const name = prompt("Nome da nova etapa (ex: Retorno 24h):");
                    if(name && name.trim() !== '') {
                        const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
                        this.columns.push({ id, name: name.trim(), ia_ativo: false, ia_descricao: '' });
                        this.saveColumnsToDB();
                        this.addNotification('Etapa Criada', `A coluna "${name}" foi adicionada.`, 'success');
                        this._refreshIcons();
                    }
                },

                removeColumn(id) {
                    if(confirm("Tem certeza que deseja excluir esta etapa vazia?")) {
                        this.columns = this.columns.filter(c => c.id !== id);
                        this.saveColumnsToDB();
                        this.addNotification('Etapa Removida', 'A coluna foi excluída.', 'info');
                    }
                },

                async checkConnection() {
                    if(!this.instanceName) return;
                    try {
                        const res = await fetch('/api/evo-proxy', { method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: `/instance/connectionState/${this.instanceName}`, method: 'GET' }) });
                        const data = await res.json();
                        if (data?.instance?.state === 'open') { this.qrStatus = 'connected'; } else { this.getQrCode(); }
                    } catch(e) { this.qrStatus = 'disconnected'; }
                },
                async getQrCode() {
                    if (this.qrStatus !== 'qrcode') this.qrStatus = 'checking';
                    try {
                        const res = await fetch('/api/evo-proxy', { method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: `/instance/connect/${this.instanceName}`, method: 'GET' }) });
                        const data = await res.json();
                        if (data?.base64) { this.qrCodeImage = data.base64; this.qrStatus = 'qrcode'; } else if (data?.instance?.state === 'open' || data?.state === 'open') { this.qrStatus = 'connected'; } else { this.qrStatus = 'disconnected'; }
                    } catch(e) { this.qrStatus = 'disconnected'; }
                },
                async disconnectWhatsApp() {
                    if(!confirm('Tem certeza que deseja desconectar o WhatsApp atual?')) return;
                    this.qrStatus = 'checking';
                    try { await fetch('/api/evo-proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `/instance/logout/${this.instanceName}`, method: 'DELETE' }) }); setTimeout(() => this.checkConnection(), 2000); } catch(e) {}
                },

                async deleteLead(id) {
                    if(!confirm("Excluir contato permanentemente?")) return;
                    try {
                        await this.client.from('leads').delete().eq('id', id).eq('instance_name', this.instanceName);
                        this.leads = this.leads.filter(l => l.id !== id);
                        if (this.selectedLead && this.selectedLead.id === id) { this.isChatOpen = false; this.selectedLead = null; }
                        this.addNotification('Sucesso', 'Contato removido.', 'success');
                    } catch(e) {}
                },

                formatTime(seconds) { const m = Math.floor(seconds / 60).toString().padStart(2, '0'); const s = (seconds % 60).toString().padStart(2, '0'); return `${m}:${s}`; },
                async startRecording() {
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        this.mediaRecorder = new MediaRecorder(stream);
                        this.audioChunks = []; this.isRecording = true; this.recordingTimer = 0;
                        this.recordingInterval = setInterval(() => { 
                            this.recordingTimer++; 
                            // Limite de 10 segundos
                            if (this.recordingTimer >= 10) {
                                this.sendRecording();
                            }
                        }, 1000);
                        this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
                        this.mediaRecorder.onstop = async () => {
                            clearInterval(this.recordingInterval);
                            stream.getTracks().forEach(track => track.stop());
                            if (this.isRecording && this.audioChunks.length > 0) {
                                const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                                const file = new File([audioBlob], `voicemail-${Date.now()}.ogg`, { type: 'audio/ogg' });
                                await this.uploadAndSend({ target: { files: [file] } }, 'audio');
                            }
                            this.isRecording = false;
                            this._refreshIcons();
                        };
                        this.mediaRecorder.start(); this._refreshIcons();
                    } catch (err) { alert("Permissão de microfone negada."); }
                },
                cancelRecording() { this.isRecording = false; if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') { this.mediaRecorder.stop(); } clearInterval(this.recordingInterval); this._refreshIcons(); },
                sendRecording() { if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') { this.mediaRecorder.stop(); } },

                openObsModal(lead) { this.activeLeadForObs = lead; this.obsInput = lead.observacao || ''; this.isObsModalOpen = true; this._refreshIcons(); },
                async saveObs() { if (!this.activeLeadForObs) return; try { await this.client.from('leads').update({ observacao: this.obsInput.trim() }).eq('id', this.activeLeadForObs.id); this.activeLeadForObs.observacao = this.obsInput.trim(); const idx = this.leads.findIndex(l => l.id === this.activeLeadForObs.id); if (idx !== -1) this.leads[idx].observacao = this.obsInput.trim(); this.isObsModalOpen = false; this.addNotification('Tag Salva', 'Observação atualizada.', 'success'); } catch(e) {} },
                
                // ── AGENDA: Carregar do Supabase (com fallback localStorage) ──
                async loadAgendamentos() {
                    try {
                        const { data, error } = await this.client
                            .from('agendamentos_crm')
                            .select('*')
                            .eq('instance_name', this.instanceName)
                            .in('status', ['ativo', null])   // ignora cancelados/concluídos
                            .eq('sent', false)               // só pendentes
                            .order('data_hora', { ascending: true });
                        if (!error && data) {
                            this.agendamentos = data.map(a => ({
                                id: a.id,
                                leadId: a.lead_id,
                                avulsoName: a.avulso_name,
                                numero: a.numero,
                                tipo: a.tipo,
                                texto: a.texto,
                                flowId: a.flow_id,
                                dataHora: a.data_hora ? a.data_hora.slice(0, 16) : a.data_hora, // normaliza para YYYY-MM-DDTHH:MM
                                sent: a.sent,
                                criadoPorIA: a.criado_por_ia,
                                lembreteEnviado: a.lembrete_enviado || false,
                                status: a.status || 'ativo',
                                dataHoraAnterior: a.data_hora_anterior ? a.data_hora_anterior.slice(0, 16) : null,
                                reagendadoEm: a.reagendado_em,
                                alteradoPor: a.alterado_por
                            }));
                            return;
                        }
                    } catch(e) { console.error('loadAgendamentos erro:', e); }
                    // Fallback: localStorage
                    const salvos = localStorage.getItem(`evo_agendamentos_${this.instanceName}`);
                    if (salvos) this.agendamentos = JSON.parse(salvos).filter(a => !a.sent && (a.status === 'ativo' || !a.status));
                },

                // ── AGENDA: Salvar agendamento no Supabase ──
                async _salvarAgendamentoSupabase(ag) {
                    // ── FIX: Garante que data_hora seja salva com offset de fuso horário ──
                    // Flatpickr retorna "YYYY-MM-DDTHH:MM" (sem tz). O servidor compara com new Date()
                    // em UTC, então precisamos incluir o offset para evitar disparo antecipado.
                    let dataHoraComTz = ag.dataHora;
                    try {
                        if (ag.dataHora && !ag.dataHora.includes('+') && !ag.dataHora.includes('Z') && !/[+-]\d{2}:\d{2}$/.test(ag.dataHora)) {
                            const dt = new Date(ag.dataHora); // browser interpreta como hora local
                            if (!isNaN(dt.getTime())) {
                                const offsetMin = -dt.getTimezoneOffset(); // offset em minutos (ex: 180 para BRT)
                                const sign = offsetMin >= 0 ? '+' : '-';
                                const absMin = Math.abs(offsetMin);
                                const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
                                const mm = String(absMin % 60).padStart(2, '0');
                                // Adiciona offset ao string original sem converter (mantém hora local legível)
                                dataHoraComTz = ag.dataHora + (ag.dataHora.length === 16 ? ':00' : '') + `${sign}${hh}:${mm}`;
                            }
                        }
                    } catch(e) { dataHoraComTz = ag.dataHora; }

                    const payload = {
                        instance_name: this.instanceName,
                        lead_id: ag.leadId || null,
                        avulso_name: ag.avulsoName || null,
                        numero: ag.numero || null,
                        tipo: ag.tipo || 'simples',
                        texto: ag.texto || null,
                        flow_id: ag.flowId || null,
                        data_hora: dataHoraComTz,
                        sent: ag.sent || false,
                        criado_por_ia: ag.criadoPorIA || false,
                        lembrete_enviado: ag.lembreteEnviado || false,
                        status: ag.status || 'ativo',
                        alterado_por: ag.alteradoPor || (ag.criadoPorIA ? 'ia' : 'atendente'),
                        data_hora_anterior: ag.dataHoraAnterior || null,
                        reagendado_em: ag.reagendadoEm || null
                    };
                    try {
                        if (ag.id && typeof ag.id === 'string' && ag.id.length > 10) {
                            const { error } = await this.client.from('agendamentos_crm').upsert({ id: ag.id, ...payload });
                            if (error) throw error;
                        } else {
                            const { data, error } = await this.client.from('agendamentos_crm').insert(payload).select().single();
                            if (error) throw error;
                            if (data) ag.id = data.id;
                        }
                        localStorage.setItem(`evo_agendamentos_${this.instanceName}`, JSON.stringify(this.agendamentos));
                    } catch(e) {
                        console.error('[Agenda] Erro Supabase:', e.message, payload);
                        localStorage.setItem(`evo_agendamentos_${this.instanceName}`, JSON.stringify(this.agendamentos));
                        throw e;
                    }
                },

                // ── AGENDA: Disponibilidade — carregar e salvar ──
                async loadAgendaConfig() {
                    try {
                        const { data } = await this.client.from('agenda_config').select('*').eq('instance_name', this.instanceName).single();
                        if (data) {
                            this.agendaDisp = {
                                dias_semana: data.dias_semana || this.agendaDisp.dias_semana,
                                horario_inicio: data.horario_inicio || '09:00',
                                horario_fim: data.horario_fim || '18:00',
                                duracao_slot: data.duracao_slot || 60,
                                almoco_inicio: data.almoco_inicio || '12:00',
                                almoco_fim: data.almoco_fim || '13:00',
                                almoco_ativo: data.almoco_ativo ?? true,
                                max_por_dia: data.max_por_dia || 8,
                                ia_verificar: data.ia_verificar ?? true,
                                confirmacao_ativa: data.confirmacao_ativa ?? false,
                                confirmacao_horas_antes: data.confirmacao_horas_antes || 24,
                                confirmacao_msg: data.confirmacao_msg || this.agendaDisp.confirmacao_msg
                            };
                        }
                    } catch(e) {}
                },

                async salvarAgendaDisp() {
                    this.agendaDispSalvando = true;
                    try {
                        await this.client.from('agenda_config').upsert({
                            instance_name: this.instanceName,
                            dias_semana: this.agendaDisp.dias_semana,
                            horario_inicio: this.agendaDisp.horario_inicio,
                            horario_fim: this.agendaDisp.horario_fim,
                            duracao_slot: this.agendaDisp.duracao_slot,
                            almoco_inicio: this.agendaDisp.almoco_inicio,
                            almoco_fim: this.agendaDisp.almoco_fim,
                            almoco_ativo: this.agendaDisp.almoco_ativo,
                            max_por_dia: this.agendaDisp.max_por_dia,
                            ia_verificar: this.agendaDisp.ia_verificar,
                            confirmacao_ativa: this.agendaDisp.confirmacao_ativa,
                            confirmacao_horas_antes: this.agendaDisp.confirmacao_horas_antes,
                            confirmacao_msg: this.agendaDisp.confirmacao_msg,
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'instance_name' });
                        this.addNotification('✅ Disponibilidade salva', 'A IA já vai usar sua agenda atualizada.', 'success');
                    } catch(e) {
                        this.addNotification('Erro', e.message, 'error');
                    } finally {
                        this.agendaDispSalvando = false;
                    }
                },

                // ── AGENDA: Helpers de disponibilidade ──

                // Normaliza dataHora para "YYYY-MM-DDTHH:MM" (sem timezone)
                _normalizarDataHora(dh) {
                    if (!dh) return '';
                    // Remove timezone offset (+00:00, Z, .000Z, etc.) e trunca em HH:MM
                    return dh.replace('Z', '').replace(/\.\d+/, '').replace(/[+-]\d{2}:\d{2}$/, '').slice(0, 16);
                },

                // Extrai "YYYY-MM-DD" de uma dataHora normalizada
                _extrairData(dh) {
                    return this._normalizarDataHora(dh).slice(0, 10);
                },

                // Extrai "HH:MM" de uma dataHora normalizada
                _extrairHora(dh) {
                    return this._normalizarDataHora(dh).slice(11, 16);
                },

                _agendaSlotsLivres(dataStr) {
                    // dataStr = "YYYY-MM-DD"
                    const d = new Date(dataStr + 'T12:00:00'); // meio-dia evita problema de DST
                    const diaSemana = String(d.getDay());
                    if (!this.agendaDisp.dias_semana[diaSemana]) return [];
                    const [hI, mI] = this.agendaDisp.horario_inicio.split(':').map(Number);
                    const [hF, mF] = this.agendaDisp.horario_fim.split(':').map(Number);
                    const [hAI, mAI] = this.agendaDisp.almoco_inicio.split(':').map(Number);
                    const [hAF, mAF] = this.agendaDisp.almoco_fim.split(':').map(Number);
                    const slots = [];
                    let cur = hI * 60 + mI;
                    const fim = hF * 60 + mF;
                    const dur = this.agendaDisp.duracao_slot || 60;
                    while (cur + dur <= fim) {
                        const almocoInicio = hAI * 60 + mAI;
                        const almocoFim = hAF * 60 + mAF;
                        const emAlmoco = this.agendaDisp.almoco_ativo && cur >= almocoInicio && cur < almocoFim;
                        if (!emAlmoco) {
                            const hh = String(Math.floor(cur/60)).padStart(2,'0');
                            const mm = String(cur%60).padStart(2,'0');
                            slots.push(`${hh}:${mm}`);
                        }
                        cur += dur;
                    }
                    return slots;
                },

                _agendaSlotOcupado(dataStr, horaStr) {
                    // Só conta agendamentos ativos e não enviados
                    const prefixo = `${dataStr}T${horaStr}`;
                    return this.agendamentos.filter(a => {
                        if (a.sent) return false;
                        if (a.status && a.status !== 'ativo') return false;
                        const dhNorm = this._normalizarDataHora(a.dataHora);
                        return dhNorm.startsWith(prefixo);
                    }).length > 0;
                },

                _agendaMaxDiaAtingido(dataStr) {
                    const max = this.agendaDisp.max_por_dia || 8;
                    const count = this.agendamentos.filter(a => {
                        if (a.sent) return false;
                        if (a.status && a.status !== 'ativo') return false;
                        return this._extrairData(a.dataHora) === dataStr;
                    }).length;
                    return count >= max;
                },

                // Verifica se um slot exato está disponível OU se o horário pedido cabe dentro de algum slot do dia
                _agendaSlotDisponivel(dataStr, horaStr) {
                    const d = new Date(dataStr + 'T12:00:00');
                    const diaSemana = String(d.getDay());
                    if (!this.agendaDisp.dias_semana[diaSemana]) return false;
                    if (this._agendaMaxDiaAtingido(dataStr)) return false;
                    const slots = this._agendaSlotsLivres(dataStr);
                    if (slots.length === 0) return false;
                    // Verifica match exato OU horário dentro do bloco de algum slot
                    const [hReq, mReq] = horaStr.split(':').map(Number);
                    const minReq = hReq * 60 + mReq;
                    const dur = this.agendaDisp.duracao_slot || 60;
                    const slotMatch = slots.find(s => {
                        const [hs, ms] = s.split(':').map(Number);
                        const minS = hs * 60 + ms;
                        return minReq >= minS && minReq < minS + dur;
                    });
                    if (!slotMatch) return false;
                    return !this._agendaSlotOcupado(dataStr, slotMatch);
                },

                _agendaProximosLivres(aPartirDe, quantidade = 3) {
                    const livres = [];
                    // Usa data local, não UTC, para evitar offset de fuso
                    const pad = n => String(n).padStart(2,'0');
                    const toLocalStr = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
                    let d = new Date(aPartirDe);
                    d.setSeconds(0, 0);
                    for (let i = 0; i < 60 && livres.length < quantidade; i++) {
                        const dateStr = toLocalStr(d);
                        const slots = this._agendaSlotsLivres(dateStr);
                        if (!this._agendaMaxDiaAtingido(dateStr)) {
                            for (const slot of slots) {
                                if (livres.length >= quantidade) break;
                                if (!this._agendaSlotOcupado(dateStr, slot)) {
                                    const [hs, ms] = slot.split(':').map(Number);
                                    const slotDt = new Date(d);
                                    slotDt.setHours(hs, ms, 0, 0);
                                    if (slotDt > aPartirDe) {
                                        livres.push({ data: dateStr, hora: slot, dt: slotDt });
                                    }
                                }
                            }
                        }
                        d.setDate(d.getDate() + 1);
                        d.setHours(0, 0, 0, 0);
                    }
                    return livres;
                },

                _agendaDisponibilidadeTexto() {
                    const nomes = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
                    const dias = Object.entries(this.agendaDisp.dias_semana).filter(([,v])=>v).map(([k])=>nomes[k]).join(', ');
                    let txt = `Dias disponíveis: ${dias || 'nenhum'}. Horário: ${this.agendaDisp.horario_inicio} às ${this.agendaDisp.horario_fim}.`;
                    if (this.agendaDisp.almoco_ativo) txt += ` Pausa almoço: ${this.agendaDisp.almoco_inicio}–${this.agendaDisp.almoco_fim}.`;
                    txt += ` Duração de cada slot: ${this.agendaDisp.duracao_slot} min. Máx por dia: ${this.agendaDisp.max_por_dia}.`;
                    // Adiciona agendamentos já confirmados dos próximos 7 dias
                    const pad = n => String(n).padStart(2,'0');
                    const hoje = new Date();
                    const hojeStr = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}-${pad(hoje.getDate())}`;
                    const agAtivos = this.agendamentos.filter(a => !a.sent && (!a.status || a.status === 'ativo') && this._extrairData(a.dataHora) >= hojeStr);
                    if (agAtivos.length > 0) {
                        const ocupados = agAtivos.map(a => `${this._extrairData(a.dataHora)} às ${this._extrairHora(a.dataHora)}`).join(', ');
                        txt += ` Horários já ocupados: ${ocupados}.`;
                    }
                    return txt;
                },

                // ── AGENDA: Slots ocupados num dia específico ──
                agendamentosNoDia(dataStr) {
                    return this.agendamentos.filter(a => {
                        if (a.sent) return false;
                        if (a.status && a.status !== 'ativo') return false;
                        return this._extrairData(a.dataHora) === dataStr;
                    });
                },

                // ── CALENDARIO ──
                calDiasNoMes() {
                    return new Date(this.calAno, this.calMes + 1, 0).getDate();
                },
                calPrimeiroDia() {
                    return new Date(this.calAno, this.calMes, 1).getDay();
                },
                calMesAnterior() {
                    if (this.calMes === 0) { this.calMes = 11; this.calAno--; } else { this.calMes--; }
                },
                calProximoMes() {
                    if (this.calMes === 11) { this.calMes = 0; this.calAno++; } else { this.calMes++; }
                },
                calDataStr(dia) {
                    return `${this.calAno}-${String(this.calMes+1).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
                },
                calDiaDisponivel(dia) {
                    const d = new Date(this.calAno, this.calMes, dia);
                    return this.agendaDisp.dias_semana[String(d.getDay())];
                },
                
                async salvarAgendamento() { 
                    if (!this.agendaForm.dataHora) return alert('Escolha a data e a hora.'); 
                    if (this.agendaForm.tipo === 'simples' && !this.agendaForm.texto) return alert('Escreva a mensagem.'); 
                    if (this.agendaForm.tipo === 'fluxo' && !this.agendaForm.flowId) return alert('Selecione um Fluxo.'); 
                    
                    let alvos = []; 
                    if (this.agendaTarget === 'avulso') { 
                        if (!this.agendaForm.numeroAvulso) return alert('Digite o número.'); 
                        let numAvulso = this.agendaForm.numeroAvulso.replace(/\D/g, ''); 
                        const { data: novoLead } = await this.client.from('leads').upsert({ numero: numAvulso, nome: 'Lead Avulso', instance_name: this.instanceName }, { onConflict: 'numero,instance_name' }).select().single(); 
                        alvos.push(novoLead); 
                        await this.loadLeads(); 
                    } else if (this.agendaTarget === 'todos') { 
                        alvos = this.myLeads; 
                    } else if (this.agendaTarget === 'funil') { 
                        alvos = this.myLeads.filter(l => l.status === this.agendaFunil); 
                    } else { 
                        alvos = this.myLeads.filter(l => this.agendaForm.leadIds.includes(l.id)); 
                    } 
                    if(alvos.length === 0) return alert('Selecione pelo menos 1 lead.'); 
                    
                    let salvos = 0, erros = 0;
                    for (let i = 0; i < alvos.length; i++) {
                        const leadAlvo = alvos[i];
                        const ag = { 
                            id: null,
                            leadId: leadAlvo.id, 
                            avulsoName: leadAlvo.nome || null,
                            numero: leadAlvo.numero,
                            tipo: this.agendaForm.tipo, 
                            flowId: this.agendaForm.flowId, 
                            texto: this.agendaForm.texto, 
                            dataHora: this.agendaForm.dataHora, 
                            sent: false,
                            criadoPorIA: false,
                            status: 'ativo'
                        };
                        this.agendamentos.push(ag);
                        try {
                            await this._salvarAgendamentoSupabase(ag);
                            salvos++;
                        } catch(e) {
                            erros++;
                            console.error('[Agenda] Falha ao salvar agendamento para', leadAlvo.nome, e.message);
                        }
                    }
                    
                    this.agendaForm.leadIds = []; this.agendaForm.numeroAvulso = ''; this.agendaForm.texto = ''; 
                    if(this.$refs.dataHoraInput?._flatpickr) this.$refs.dataHoraInput._flatpickr.clear(); 
                    this.agendaForm.dataHora = ''; this.agendaSearch = ''; 
                    if (erros === 0) {
                        this.addNotification('✅ Agendado!', `${salvos} agendamento(s) salvos com sucesso.`, 'success');
                    } else if (salvos > 0) {
                        this.addNotification('⚠️ Parcialmente salvo', `${salvos} ok, ${erros} falharam. Verifique o console.`, 'warning');
                    } else {
                        this.addNotification('❌ Erro ao agendar', 'Nenhum agendamento foi salvo no Supabase. Verifique sua conexão e a tabela agendamentos_crm.', 'error');
                    }
                    this._refreshIcons(); 
                },
                async cancelarAgendamento(id, motivo = null) {
                    // Remove imediatamente do estado local → libera o slot
                    this.agendamentos = this.agendamentos.filter(a => a.id !== id);
                    localStorage.setItem(`evo_agendamentos_${this.instanceName}`, JSON.stringify(this.agendamentos));
                    try {
                        // Atualiza no DB sempre que for string UUID válida
                        if (id && typeof id === 'string' && id.trim().length > 0) {
                            await this.client.from('agendamentos_crm').update({
                                status: 'cancelado',
                                sent: true,
                                motivo_cancelamento: motivo || null,
                                cancelado_em: new Date().toISOString(),
                                alterado_por: 'usuario'
                            }).eq('id', id);
                        }
                    } catch(e) { console.warn('cancelarAgendamento DB:', e); }
                },
                
                async checkAgendamentos() { 
                    if (this.isCheckingAgendamentosFlag) return;
                    this.isCheckingAgendamentosFlag = true;
                    // ── Agendamentos são enviados exclusivamente pelo servidor (server.js) ──
                    // O browser apenas sincroniza o estado local com o Supabase.
                    try {
                        await this.loadAgendamentos();
                    } catch(e) {
                        console.error('Erro em checkAgendamentos:', e);
                    } finally {
                        this.isCheckingAgendamentosFlag = false;
                    }
                },
                
                openNewFlow() {
                    this.editingRuleId = null;
                    this.flowBuilder = { 
                        name: '', 
                        trigger: 'energia solar, orçamento, marketing', 
                        steps: [ { type: 'text', content: 'Olá! Recebemos seu contato. Como posso te ajudar hoje?' }, { type: 'delay', content: 3000 }, { type: 'image', content: '', fileName: 'tabela_precos.jpg', fileObj: null } ] 
                    };
                    this.isEditingFlow = true;
                    this._refreshIcons();
                },

                editRule(rule) { 
                    this.editingRuleId = rule.id; 
                    this.flowBuilder.name = rule.nome || rule.trigger_text || ''; 
                    this.flowBuilder.trigger = rule.trigger_text || ''; 
                    if (rule.flow_steps && rule.flow_steps.length > 0) { this.flowBuilder.steps = JSON.parse(JSON.stringify(rule.flow_steps)); } 
                    else { this.flowBuilder.steps = []; if (rule.media_url) this.flowBuilder.steps.push({ type: rule.media_type || 'document', content: rule.media_url, fileName: 'Mídia no BD' }); if (rule.response_text && !rule.response_text.includes('"isFlow":true')) this.flowBuilder.steps.push({ type: 'text', content: rule.response_text }); } 
                    this.isEditingFlow = true;
                    this._refreshIcons(); 
                },
                
                cancelEdit() { this.editingRuleId = null; this.flowBuilder = { name: '', trigger: '', steps: [] }; this.isEditingFlow = false; },
                promptSaveFlow() { this.isSaveFlowModalOpen = true; },
                confirmSaveFlow() { if(!this.flowBuilder.name.trim()) { alert("Por favor, dê um nome ao seu fluxo!"); return; } this.isSaveFlowModalOpen = false; this.saveFlow(); },

                addStep(type) { this.flowBuilder.steps.push({ type: type, content: type === 'delay' ? 3000 : '', fileObj: null, fileName: '' }); this._refreshIcons(); },
                removeStep(index) { this.flowBuilder.steps.splice(index, 1); },
                attachFileToStep(event, index) { const file = event.target.files[0]; if(file) { this.flowBuilder.steps[index].fileObj = file; this.flowBuilder.steps[index].fileName = file.name; } },
                
                async saveFlow() { 
                    if(this.flowBuilder.steps.length === 0) return alert('Adicione passos.'); 
                    this.isSavingFlow = true; 
                    try { 
                        let finalSteps = []; 
                        for(let step of this.flowBuilder.steps) { 
                            if(['image', 'audio', 'document', 'video'].includes(step.type) && step.fileObj) { 
                                const fileName = `flow-${Date.now()}-${step.fileObj.name.replace(/[^a-zA-Z0-9.]/g, '')}`; 
                                const publicUrl = await localUpload(`chat_media/bot_media/${fileName}`, step.fileObj, step.fileObj.type); 

                                const data = { publicUrl }; 
                                finalSteps.push({ type: step.type, content: data.publicUrl, fileName: step.fileName }); 
                            } else { 
                                finalSteps.push({ type: step.type, content: step.content, fileName: step.fileName || '' }); 
                            } 
                        } 
                        
                        const flowData = { isFlow: true, name: this.flowBuilder.name.trim(), steps: finalSteps }; 
                        const dataToSave = { 
                            trigger_text: this.flowBuilder.trigger ? this.flowBuilder.trigger.toLowerCase().trim() : '', 
                            response_text: JSON.stringify(flowData), 
                            media_url: null, media_type: null, 
                            instance_name: this.instanceName, 
                            departamento: this.currentUserDept || 'ADM Principal'
                        }; 
                        
                        if (this.editingRuleId) { 
                            const { error } = await this.client.from('chatbot_rules').update(dataToSave).eq('id', this.editingRuleId); 
                            if(error) throw new Error("Erro no Banco (Atualizar): " + error.message);
                        } else { 
                            const { error } = await this.client.from('chatbot_rules').insert(dataToSave); 
                            if(error) throw new Error("Erro no Banco (Inserir): " + error.message);
                        } 
                        
                        this.cancelEdit(); 
                        await this.loadBotRules(); 
                        this.addNotification('Sucesso', 'Fluxo Salvo com sucesso!', 'success'); 
                    } catch(e) { 
                        alert('FALHA AO SALVAR:\n\n' + e.message); 
                        console.error(e);
                    } 
                    this.isSavingFlow = false; 
                },

                async loadBotRules() { 
                    const dept = this.currentUserDept || 'ADM Principal';
                    const { data } = await this.client.from('chatbot_rules').select('*').eq('instance_name', this.instanceName).eq('departamento', dept).order('created_at', { ascending: false }); 
                    if(data) { 
                        this.botRules = data.map(rule => { 
                            try { const parsed = JSON.parse(rule.response_text); if (parsed && parsed.isFlow) { rule.nome = parsed.name; rule.flow_steps = parsed.steps; } } catch(e) {} return rule; 
                        }); 
                        this._refreshIcons(); 
                    } 
                },

                async deleteBotRule(id) { if(!confirm("Apagar esse fluxo?")) return; await this.client.from('chatbot_rules').delete().eq('id', id); this.loadBotRules(); },

                async triggerBotRuleManual(rule, targetLead = null) { 
                    const leadFinal = targetLead || this.selectedLead; if(!leadFinal) return; 
                    const insertAndPush = async (insertObj) => {
                        const tempId = 'bot-' + Date.now() + Math.random(); const tempMsg = { ...insertObj, id: tempId, timestamp: new Date().toISOString() };
                        this.updateLeadLocalInteraction(leadFinal.id, insertObj.content, insertObj.type);
                        if (this.isChatOpen && this.selectedLead && leadFinal.id === this.selectedLead.id) { this.messages = [...this.messages, tempMsg]; this.scrollToBottom(); this._refreshIcons(); }
                        try { const { data, error } = await this.client.from('messages').insert(insertObj).select().single(); if(data) this.resolveTempMessage(tempId, data); } catch(e) {}
                    };
                    if(rule.flow_steps && rule.flow_steps.length > 0) { 
                        for(const step of rule.flow_steps) { 
                            if (step.type === 'delay') { await new Promise(r => setTimeout(r, parseInt(step.content)||2000)); } 
                            else if (step.type === 'text') { 
                                const msgProcessada = this.processSpintax(step.content, leadFinal);
                                this._evoSend('sendText', { number: leadFinal.numero, text: msgProcessada }).catch(e=>console.log(e)); 
                                await insertAndPush({ lead_id: leadFinal.id, content: msgProcessada, from_me: true, type: 'text', status: 'sent', instance_name: this.instanceName }); 
                            } 
                            else { 
                                let endpoint = 'sendMedia'; 
                                let mType = step.type === 'image' ? 'image' : (step.type === 'video' ? 'video' : 'document');
                                
                                let mime = 'application/octet-stream';
                                if (mType === 'image') mime = 'image/jpeg';
                                else if (mType === 'video') mime = 'video/mp4';
                                else if (mType === 'document') mime = 'application/pdf';
                                
                                if (step.fileName) {
                                    const fn = step.fileName.toLowerCase();
                                    if (fn.endsWith('.png')) mime = 'image/png';
                                    if (fn.endsWith('.jpg') || fn.endsWith('.jpeg')) mime = 'image/jpeg';
                                    if (fn.endsWith('.mp4')) mime = 'video/mp4';
                                    if (fn.endsWith('.pdf')) mime = 'application/pdf';
                                }

                                let bodyMedia = { 
                                    number: leadFinal.numero, 
                                    mediatype: mType, 
                                    mimetype: mime, 
                                    media: step.content, 
                                    fileName: step.fileName || "Arquivo", 
                                    mediaMessage: { mediatype: mType, mimetype: mime, media: step.content, fileName: step.fileName || "Arquivo" } 
                                }; 
                                if (step.type === 'audio') { endpoint = 'sendWhatsAppAudio'; bodyMedia = { number: leadFinal.numero, audio: step.content }; } 
                                
                                this._evoSend(endpoint, bodyMedia).catch(e=>console.log(e)); 
                                await insertAndPush({ lead_id: leadFinal.id, content: step.content, from_me: true, type: step.type, status: 'sent', instance_name: this.instanceName }); 
                            } 
                            if(step.type !== 'delay') await new Promise(r => setTimeout(r, 1000));
                        } 
                    } else if (rule.media_url || (rule.response_text && !rule.response_text.includes('"isFlow":true'))) { 
                        if(rule.media_url) { 
                            let endpoint = 'sendMedia'; 
                            let mType = rule.media_type || 'document';
                            if (mType !== 'image' && mType !== 'video' && mType !== 'audio') mType = 'document';
                            
                            let mime = 'application/octet-stream';
                            if (mType === 'image') mime = 'image/jpeg';
                            else if (mType === 'video') mime = 'video/mp4';
                            else if (mType === 'document') mime = 'application/pdf';

                            let bodyMedia = { 
                                number: leadFinal.numero, 
                                mediatype: mType, 
                                mimetype: mime, 
                                media: rule.media_url, 
                                fileName: "Arquivo", 
                                mediaMessage: { mediatype: mType, mimetype: mime, media: rule.media_url, fileName: "Arquivo" } 
                            }; 
                            if(rule.media_type === 'audio') { endpoint = 'sendWhatsAppAudio'; bodyMedia = { number: leadFinal.numero, audio: rule.media_url }; } 
                            
                            this._evoSend(endpoint, bodyMedia).catch(e=>console.log(e)); 
                            await insertAndPush({ lead_id: leadFinal.id, content: rule.media_url, from_me: true, type: mType, status: 'sent', instance_name: this.instanceName }); 
                        } 
                        if(rule.response_text) { 
                            const msgProcessada = this.processSpintax(rule.response_text, leadFinal);
                            this._evoSend('sendText', { number: leadFinal.numero, text: msgProcessada }).catch(e=>console.log(e)); 
                            await insertAndPush({ lead_id: leadFinal.id, content: msgProcessada, from_me: true, type: 'text', status: 'sent', instance_name: this.instanceName }); 
                        } 
                    } 
                },

                // ── Pre-classifica tipo da mensagem para evitar múltiplos .includes() no template ──
                getMsgType(msg) {
                    const t = msg.type || '';
                    const c = msg.content || '';
                    if (t === 'audio' || c.includes('.ogg') || c.includes('.mp3')) return 'audio';
                    if (t === 'image' || c.includes('.jpg') || c.includes('.jpeg') || c.includes('.png') || c.includes('.webp')) return 'image';
                    if (t === 'video' || c.includes('.mp4') || c.includes('.mov')) return 'video';
                    // Só considera documento se for arquivo real do Supabase Storage (não links externos de texto)
                    const isSbStorage = c.includes('supabase.co/storage') || isStorageUrl(c);
                    if (t === 'document' || (isSbStorage && c.includes('http'))) return 'document';
                    return 'text';
                },

                extractUrl(text) { if (!text) return ''; const match = text.match(/https?:\/\/[^\s]+/); return match ? match[0] : text; },
                formatText(text) { if (!text) return ''; if (text.includes('supabase.co/storage') || isStorageUrl(text)) { if (text.includes('.jpg') || text.includes('.png') || text.includes('.webp')) return 'Imagem'; if (text.includes('.ogg') || text.includes('.mp3')) return 'Áudio'; if (text.includes('.mp4') || text.includes('.mov')) return 'Vídeo'; return 'Arquivo'; } return text.replace(/\[(IMAGE|AUDIO|VIDEO|DOCUMENT|image|audio|video|document)\]/gi, '').trim(); },
                
                async loadLeads() {
                    const { data } = await this.client.from('leads').select('*').eq('instance_name', this.instanceName).order('last_interaction', { ascending: false });
                    if (data) {
                        this.leads = data;
                        // Popula leadSentimento com os valores já salvos no banco
                        const mapa = {};
                        for (const l of data) {
                            if (l.sentimento) mapa[l.id] = l.sentimento;
                        }
                        this.leadSentimento = { ...mapa };
                    }
                    // Carrega snapshot da fila
                    this.carregarFila();
                },
                
                async openChat(lead) { 
                    // Guarda referência do lead da lista (não uma cópia) para manter sincronização
                    const leadIdx = this.leads.findIndex(l => l.id === lead.id);
                    const leadRef = leadIdx !== -1 ? this.leads[leadIdx] : lead;
                    
                    // Cria cópia para selectedLead preservando todos os dados
                    this.selectedLead = { ...leadRef }; 
                    this.selectedLeadStatus = leadRef.status || ''; 
                    this.isChatOpen = true; 
                    this.messages = []; 

                    // Sincroniza prompt específico desta conversa
                    this.leadPromptIdPorLead[leadRef.id] = leadRef.prompt_id || null;

                    // Zerar unread — fire-and-forget, não bloqueia a UI
                    if(leadIdx !== -1 && this.leads[leadIdx].unread > 0) { 
                        this.leads[leadIdx] = { ...this.leads[leadIdx], unread: 0 }; 
                        this.selectedLead.unread = 0;
                        this.leads = [...this.leads]; 
                        this.client.from('leads').update({ unread: 0 }).eq('id', lead.id); // sem await
                    }

                    // Busca as últimas 200 msgs — evita carregar histórico enorme de uma vez
                    const { data } = await this.client
                        .from('messages')
                        .select('id, lead_id, content, type, from_me, status, timestamp, sent_by_ia, instance_name')
                        .eq('lead_id', lead.id)
                        .eq('instance_name', this.instanceName)
                        .order('created_at', { ascending: false })
                        .limit(200);
                    this.messages = (data || []).reverse();

                    // Atualiza downloadedMediaSet para lookup O(1)
                    this.downloadedMediaSet = new Set(this.downloadedMedia);

                    this.scrollToBottom();
                    // Ícones com delay maior — DOM já está pronto
                    this._refreshIcons(200);
                    // Reset aba para cliente e carrega msgs internas em background
                    this.chatTab = 'cliente';
                    this.chatInternoNaoLidos = 0;
                    this.carregarChatInterno(lead.id);

                    // Tira o lead da fila se estiver aguardando (fire-and-forget)
                    fetch('/api/fila/iniciar', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            inst: this.instanceName,
                            lead_id: lead.id,
                            agente_nome: this.loggedUserName || this.currentUserDept || 'ADM Principal'
                        })
                    }).catch(() => {});

                    // Atribui o atendente ao lead
                    const meuNome = this.loggedUserName || this.currentUserDept || 'ADM Principal';
                    if (leadRef.atendente_nome !== meuNome) {
                        leadRef.atendente_nome = meuNome;
                        this.selectedLead.atendente_nome = meuNome;
                        this.leads = [...this.leads];
                        this.client.from('leads').update({ atendente_nome: meuNome }).eq('id', lead.id);
                    }

                    // Foto e nome — sincroniza em background sem bloquear abertura
                    // Usa o ID do lead para garantir consistência
                    const precisaFoto = !leadRef.foto_url || leadRef.foto_url === 'default' || leadRef.foto_url.includes('dicebear') || this._isFotoExpirada(leadRef.foto_url);
                    const nomeEhOperador = this._operatorNames?.size > 0 && this._operatorNames.has((leadRef.nome || '').trim());
                    const precisaNome = !leadRef.nome || leadRef.nome === leadRef.numero || leadRef.nome === 'Lead Avulso' || leadRef.nome === 'Lead Importado' || nomeEhOperador;
                    if (precisaFoto || precisaNome) {
                        const leadId = lead.id;
                        setTimeout(() => {
                            const currentLead = this.leads.find(l => l.id === leadId);
                            if (currentLead) this._sincronizarPerfilLead(currentLead);
                        }, 1500);
                    }
                },

                // ═══════════════════════════════════════════════════════════
                // BUFFER DE MENSAGENS
                // Agrupa mensagens fragmentadas antes de chamar a IA
                // ═══════════════════════════════════════════════════════════

                async _bufferAdicionarMsg(lead, msgObj) {
                    const leadId = lead.id;
                    if (!this.iaBufferMsgs[leadId]) this.iaBufferMsgs[leadId] = [];

                    this.iaBufferMsgs[leadId].push({
                        content: msgObj.content || '',
                        type: msgObj.type || 'text',
                        id: msgObj.id,
                        ts: msgObj.timestamp || new Date().toISOString()
                    });

                    const total = this.iaBufferMsgs[leadId].length;
                    this.iaAddLog('info', `⏳ Buffer [${this.getLeadName(lead)}]: ${total} msg(s) — aguardando ${this.iaBufferTempo}s`);

                    // Salva no Supabase (best-effort)
                    try { await this._bufferSalvarDB(leadId); } catch(e) {}

                    // Cancela timer anterior e inicia novo debounce
                    if (this.iaBufferTimers[leadId]) clearTimeout(this.iaBufferTimers[leadId]);
                    this.iaBufferTimers[leadId] = setTimeout(() => {
                        this._bufferDisparar(lead);
                    }, this.iaBufferTempo * 1000);
                },

                async _bufferDisparar(lead) {
                    const leadId = lead.id;
                    const msgs = this.iaBufferMsgs[leadId] || [];
                    if (msgs.length === 0) return;

                    delete this.iaBufferMsgs[leadId];
                    delete this.iaBufferTimers[leadId];
                    try { await this._bufferLimparDB(leadId); } catch(e) {}

                    let msgFinal;
                    if (msgs.length === 1) {
                        msgFinal = msgs[0];
                        this.iaAddLog('info', `📨 Buffer [${this.getLeadName(lead)}]: 1 msg — disparando IA`);
                    } else {
                        const textos = msgs.filter(m => !m.type || m.type === 'text').map(m => m.content).filter(Boolean);
                        const ultimaNaoTexto = [...msgs].reverse().find(m => m.type && m.type !== 'text');
                        msgFinal = {
                            content: textos.join('\n'),
                            type: ultimaNaoTexto ? ultimaNaoTexto.type : 'text',
                            id: msgs[msgs.length - 1].id,
                            timestamp: msgs[msgs.length - 1].ts
                        };
                        this.iaAddLog('ok', `📦 Buffer [${this.getLeadName(lead)}]: ${msgs.length} msgs unificadas → IA dispara`);
                    }

                    await this.iaResponderCliente(msgFinal.content, lead, msgFinal);
                },

                async _bufferSalvarDB(leadId) {
                    await this.client.from('ia_buffer').upsert({
                        instance_name: this.instanceName,
                        lead_id: leadId,
                        msgs: JSON.stringify(this.iaBufferMsgs[leadId] || []),
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'instance_name,lead_id' });
                },

                async _bufferLimparDB(leadId) {
                    await this.client.from('ia_buffer')
                        .delete()
                        .eq('instance_name', this.instanceName)
                        .eq('lead_id', leadId);
                },

                async _bufferCarregarDB() {
                    try {
                        const { data } = await this.client.from('ia_buffer')
                            .select('lead_id, msgs, updated_at')
                            .eq('instance_name', this.instanceName);
                        if (!data || data.length === 0) return;
                        for (const row of data) {
                            const lead = this.leads.find(l => l.id === row.lead_id);
                            if (!lead) continue;
                            const msgs = JSON.parse(row.msgs || '[]');
                            if (msgs.length === 0) continue;
                            const idadeMs = Date.now() - new Date(row.updated_at).getTime();
                            const restante = Math.max(2000, (this.iaBufferTempo * 1000) - idadeMs);
                            this.iaBufferMsgs[row.lead_id] = msgs;
                            this.iaAddLog('info', `📦 Buffer restaurado [${this.getLeadName(lead)}]: ${msgs.length} msg(s), dispara em ${Math.round(restante/1000)}s`);
                            this.iaBufferTimers[row.lead_id] = setTimeout(() => {
                                this._bufferDisparar(lead);
                            }, restante);
                        }
                    } catch(e) {
                        console.warn('[ia_buffer] Erro ao restaurar:', e.message);
                    }
                },

                // ═══════════════════════════════════════════════════════════
                // _pausarIA — função central de pausa/retomada
                // Regras iguais para CRM e WhatsApp direto
                // Persiste estado no Supabase (tabela ia_pausa)
                // ═══════════════════════════════════════════════════════════
                _pausarIA(leadId, leadName, origem) {
                    if (!this.iaPausaSeHumano) return;

                    const palavraPausa   = (this.iaKeyword       || '').trim().toLowerCase();
                    const palavraRetomar = (this.iaKeywordRetomar || '').trim().toLowerCase();
                    const msgTexto       = (origem?.texto         || '').trim().toLowerCase();
                    const fonte          = origem?.fonte || '?';

                    // ── Verificar palavra de RETOMADA primeiro ──
                    if (palavraRetomar && msgTexto.includes(palavraRetomar)) {
                        this._retomarIA(leadId, leadName, `palavra-chave "${palavraRetomar}" [${fonte}]`);
                        return;
                    }

                    // ── COM palavra-chave de pausa ──
                    // Quando o HUMANO envia (CRM ou WhatsApp), SEMPRE pausa — keyword é só para cliente
                    const isHumano = (fonte === 'CRM' || fonte === 'WhatsApp' || fonte === 'manual CRM');
                    if (!isHumano && palavraPausa) {
                        // Aceita: exato, começa com, ou contém a palavra-chave
                        const bateu = msgTexto === palavraPausa
                            || msgTexto.startsWith(palavraPausa + ' ')
                            || msgTexto.includes(palavraPausa);
                        if (!bateu) return; // Digitou outra coisa → IA continua
                    }
                    // Humano ou SEM palavra-chave → qualquer mensagem pausa

                    // Já pausado → só reinicia o timer
                    const jaPausado = !!this.iaHumanoAtivo[leadId];
                    this.iaHumanoAtivo[leadId] = true;

                    if (this.iaHumanoTimers[leadId]) clearTimeout(this.iaHumanoTimers[leadId]);

                    // Persiste no Supabase
                    this._salvarPausaDB(leadId, true, fonte);

                    if (!jaPausado) {
                        this.iaAddLog('info', `🧑 IA pausada para ${leadName} [${fonte}]`);
                        this.addNotification('🧑 Humano assumiu', `IA pausada para ${leadName}.`, 'info');
                        this._refreshIcons();
                    }

                    // Timer de retomada automática
                    if (this.iaPausaTempo > 0) {
                        this.iaHumanoTimers[leadId] = setTimeout(() => {
                            this._retomarIA(leadId, leadName, 'timer automático');
                        }, this.iaPausaTempo * 60 * 1000);
                    }
                },

                // ── Retomar IA para um contato ──
                _retomarIA(leadId, leadName, motivo) {
                    if (!this.iaHumanoAtivo[leadId]) return; // já estava ativa
                    delete this.iaHumanoAtivo[leadId];
                    if (this.iaHumanoTimers[leadId]) {
                        clearTimeout(this.iaHumanoTimers[leadId]);
                        delete this.iaHumanoTimers[leadId];
                    }
                    this._salvarPausaDB(leadId, false, motivo);
                    this.iaAddLog('ok', `🤖 IA retomou para ${leadName} [${motivo}]`);
                    this.addNotification('🤖 IA Retomada', `IA voltou a responder: ${leadName}`, 'info');
                    this._refreshIcons();
                },

                // ── Salva/remove pausa no Supabase (tabela ia_pausa) ──
                async _salvarPausaDB(leadId, pausado, pausadoPor) {
                    try {
                        if (pausado) {
                            await this.client.from('ia_pausa').upsert({
                                instance_name: this.instanceName,
                                lead_id: leadId,
                                pausado: true,
                                pausado_por: pausadoPor || 'humano',
                                pausado_em: new Date().toISOString(),
                                retomado_em: null
                            }, { onConflict: 'instance_name,lead_id' });
                        } else {
                            await this.client.from('ia_pausa').upsert({
                                instance_name: this.instanceName,
                                lead_id: leadId,
                                pausado: false,
                                retomado_em: new Date().toISOString()
                            }, { onConflict: 'instance_name,lead_id' });
                        }
                    } catch(e) {
                        // Tabela pode não existir ainda — silencia e funciona só em memória
                        console.warn('[ia_pausa] Supabase indisponível, usando só memória:', e.message);
                    }
                },

                // ── Carrega estado de pausas do Supabase no boot ──
                async _carregarPausasDB() {
                    try {
                        const { data } = await this.client
                            .from('ia_pausa')
                            .select('lead_id, pausado, pausado_por, pausado_em')
                            .eq('instance_name', this.instanceName)
                            .eq('pausado', true);
                        if (data) {
                            data.forEach(p => {
                                this.iaHumanoAtivo[p.lead_id] = true;
                                // Recalcula timer se havia tempo de pausa configurado
                                if (this.iaPausaTempo > 0 && p.pausado_em) {
                                    const pausadoHa = Date.now() - new Date(p.pausado_em).getTime();
                                    const restante = (this.iaPausaTempo * 60 * 1000) - pausadoHa;
                                    if (restante > 0) {
                                        const lead = this.leads.find(l => l.id === p.lead_id);
                                        const nome = lead ? this.getLeadName(lead) : p.lead_id;
                                        this.iaHumanoTimers[p.lead_id] = setTimeout(() => {
                                            this._retomarIA(p.lead_id, nome, 'timer automático (boot)');
                                        }, restante);
                                    } else {
                                        // Timer já expirou enquanto estava offline — retoma imediatamente
                                        this._salvarPausaDB(p.lead_id, false, 'timer expirado offline');
                                        delete this.iaHumanoAtivo[p.lead_id];
                                    }
                                }
                            });
                            if (data.length > 0) this.iaAddLog('ok', `📋 ${data.length} pausa(s) restaurada(s) do banco`);
                        }
                    } catch(e) {
                        console.warn('[ia_pausa] Erro ao carregar pausas:', e.message);
                    }
                },

                async sendMsg() {
                    if(!this.msgInput.trim() || !this.selectedLead) return;

                    const msgTexto = this.msgInput.trim();
                    // Aplica mesma lógica de pausa do WhatsApp direto
                    this._pausarIA(
                        this.selectedLead.id,
                        this.getLeadName(this.selectedLead),
                        { texto: msgTexto, fonte: 'CRM' }
                    );
                    
                    let text = msgTexto;
                    let activeDept = this.currentUserDept === 'ADM Principal' ? this.admResponseAs : this.currentUserDept;
                    if (activeDept && activeDept !== 'ADM Principal') { text = `*${activeDept}*:\n${text}`; }
                    
                    this.msgInput = ''; if(this.$refs.msgTextarea) this.$refs.msgTextarea.style.height = '56px'; 
                    const tempId = 'temp-' + Date.now(); const tempMsg = { id: tempId, lead_id: this.selectedLead.id, content: text, from_me: true, type: 'text', status: 'sent', timestamp: new Date().toISOString() };
                    this.messages = [...this.messages, tempMsg];
                    // Passa msgTexto (sem prefixo do setor) para o last_msg não aparecer sujo na lista
                    this.updateLeadLocalInteraction(this.selectedLead.id, msgTexto, 'text');
                    this.scrollToBottom(); this._refreshIcons();
                    // ✅ Bug fix: usa proxy /api/send para evitar CORS no browser
                    let evoMsgId = null;
                    try { const evoResp = await this._evoSend('sendText', { number: this.selectedLead.numero, text }); evoMsgId = evoResp?.key?.id || null; } catch(e) { console.error('[sendMsg] Falha EVO:', e); }
                    try { const insertObj = { lead_id: this.selectedLead.id, content: text, from_me: true, type: 'text', status: 'sent', instance_name: this.instanceName, sent_by_ia: false }; if (evoMsgId) insertObj.id = evoMsgId; const { data, error } = await this.client.from('messages').insert(insertObj).select().single(); if(data) this.resolveTempMessage(tempId, data); } catch(err) { console.error(err); }
                    this.fireWebhook('nova_mensagem', { lead_id: this.selectedLead?.id, numero: this.selectedLead?.numero, conteudo: msgTexto, de: 'atendente' }).catch(()=>{});
                },

                async uploadAndSend(event, type) { 
                    const file = event.target.files[0]; if (!file || !this.selectedLead) return; 
                    const tempId = 'temp-' + Date.now(); const fakeUrl = `http://supabase.co/fake_${Date.now()}.${file.name.split('.').pop()}`; const tempMsg = { id: tempId, lead_id: this.selectedLead.id, content: fakeUrl, from_me: true, type: type, status: 'sent', timestamp: new Date().toISOString() };
                    this.messages = [...this.messages, tempMsg]; this.updateLeadLocalInteraction(this.selectedLead.id, fakeUrl, type); this.scrollToBottom(); this._refreshIcons();
                    try { 
                        const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.]/g, '')}`; 
                        const publicUrl = await localUpload(`chat_media/${this.instanceName}_${this.selectedLead.numero}/${fileName}`, file, file.type);
                        const storageData = { publicUrl };
                        
                        let endpoint = 'sendMedia'; 
                        let mType = type === 'image' ? 'image' : (type === 'video' ? 'video' : 'document');
                        let body = { 
                            number: this.selectedLead.numero, 
                            mediatype: mType, 
                            mimetype: file.type || 'application/octet-stream',
                            media: storageData.publicUrl, 
                            fileName: file.name || "Arquivo",
                            mediaMessage: { mediatype: mType, mimetype: file.type || 'application/octet-stream', media: storageData.publicUrl, fileName: file.name || "Arquivo" }
                        }; 
                        if (type === 'audio') { endpoint = 'sendWhatsAppAudio'; body = { number: this.selectedLead.numero, audio: storageData.publicUrl }; } 
                        
                        // ✅ Bug fix: usa proxy /api/send para evitar CORS no browser
                        let evoMsgIdMedia = null;
                        try { const evoRespMedia = await this._evoSend(endpoint, body); evoMsgIdMedia = evoRespMedia?.key?.id || null; } catch(e) { console.error('[uploadAndSend] Falha EVO:', e); }
                        
                        const insertObjMedia = { lead_id: this.selectedLead.id, content: storageData.publicUrl, from_me: true, type: type, status: 'sent', instance_name: this.instanceName, sent_by_ia: false };
                        if (evoMsgIdMedia) insertObjMedia.id = evoMsgIdMedia;
                        const { data, error } = await this.client.from('messages').insert(insertObjMedia).select().single(); 
                        if(data) this.resolveTempMessage(tempId, data);
                    } catch(e) { console.error(e); }
                    if(this.$refs.iI) this.$refs.iI.value = '';
                    if(this.$refs.vI) this.$refs.vI.value = '';
                    if(this.$refs.aI) this.$refs.aI.value = '';
                    if(this.$refs.dI) this.$refs.dI.value = '';
                },
                
                // ── Proxy de envio via server (evita CORS) ──
                async _evoSend(endpoint, payload) {
                    const res = await fetch(window.location.origin + '/api/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ inst: this.instanceName, endpoint, payload })
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err?.error || 'HTTP ' + res.status);
                    }
                    return res.json();
                },

                processSpintax(text, lead) { 
                    if(!text) return ""; 
                    if(!lead) return text;
                    
                    let n = this.getLeadName(lead); 
                    if(n === lead.numero || n === 'Desconhecido') n = 'Cliente'; 
                    
                    let msg = text
                        .replace(/{nome}/g, n)
                        .replace(/{primeiro_nome}/g, n.split(' ')[0])
                        .replace(/{numero}/g, lead.numero || ''); 
                    
                    // Processa spintax {opção1|opção2|opção3}
                    return msg.replace(/{([^{}]+)}/g, function(match, options) { 
                        const words = options.split('|').filter(w => w.trim()); 
                        return words.length > 0 ? words[Math.floor(Math.random() * words.length)] : match; 
                    }); 
                },

                inserirVariavel(variavel) {
                    const el = this.$refs.disparoMsgInput;
                    if (!el) { this.disparoConfig.msg += variavel; return; }
                    const start = el.selectionStart;
                    const end = el.selectionEnd;
                    const before = this.disparoConfig.msg.substring(0, start);
                    const after = this.disparoConfig.msg.substring(end);
                    this.disparoConfig.msg = before + variavel + after;
                    this.$nextTick(() => { el.focus(); el.selectionStart = el.selectionEnd = start + variavel.length; });
                },

                async handleLeadsFileImport(event) {
                    const file = event.target.files[0];
                    if (!file) return;
                    this.disparoConfig.importedFile = file;
                    const text = await file.text();
                    this.disparoConfig.numerosImportados = text;
                    this.csvResultado = null;
                    this._refreshIcons();
                },

                async verificarNumerosCsv() {
                    if (!this.disparoConfig.numerosImportados) { this.addNotification('Sem números', 'Importe um arquivo primeiro.', 'warn'); return; }
                    const numeros = this.disparoConfig.numerosImportados.split(/[\n,;]+/).map(n => n.replace(/\D/g, '').trim()).filter(n => n.length >= 10);
                    if (numeros.length === 0) { this.addNotification('Nenhum número', 'Nenhum número válido encontrado no arquivo.', 'warn'); return; }
                    this.csvVerificando = true;
                    this.csvResultado = null;
                    this.addNotification('🔍 Verificando...', `Checando ${numeros.length} número(s) no WhatsApp...`, 'info');
                    let ativos = [], inativos = [];
                    try {
                        const res = await fetch(window.location.origin + '/api/check-whatsapp', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, numbers: numeros })
                        });
                        let resData = [];
                        if (res.ok) resData = await res.json();
                        if (!Array.isArray(resData)) resData = [resData];
                        const mapaResultado = {};
                        for (const item of resData) {
                            const numLimpo = (item.number || item.jid || '').replace(/\D/g,'').replace(/@.*/,'');
                            if (numLimpo) mapaResultado[numLimpo] = item;
                        }
                        for (const num of numeros) {
                            const variantes = [num];
                            if (num.startsWith('55') && num.length === 13) variantes.push('55' + num.slice(4));
                            if (num.startsWith('55') && num.length === 12) variantes.push('55' + '9' + num.slice(4));
                            let resultado = null;
                            for (const v of variantes) { if (mapaResultado[v]) { resultado = mapaResultado[v]; break; } }
                            const temWhats = resultado?.exists === true || resultado?.exists === 'true' || resultado?.numberExists === true || resultado?.jid;
                            if (temWhats) ativos.push(num); else inativos.push(num);
                        }
                    } catch(e) {
                        this.addNotification('⚠️ Erro na verificação', 'Não foi possível checar o WhatsApp.', 'error');
                        this.csvVerificando = false;
                        return;
                    }
                    this.csvVerificando = false;
                    this.csvResultado = { ativos, inativos, total: numeros.length };
                    const tipo = ativos.length > 0 ? 'success' : 'error';
                    this.addNotification('Verificação concluída', `✅ ${ativos.length} ativos · ❌ ${inativos.length} inativos`, tipo);
                    this.$nextTick(() => lucide.createIcons());
                },

                exportarNumerosCsvAtivos() {
                    if (!this.csvResultado || this.csvResultado.ativos.length === 0) { this.addNotification('Sem dados', 'Nenhum número ativo para exportar.', 'warn'); return; }
                    const conteudo = this.csvResultado.ativos.join('\n');
                    const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = 'numeros_ativos_whatsapp.csv'; a.click();
                    URL.revokeObjectURL(url);
                    this.addNotification('Exportado!', `${this.csvResultado.ativos.length} números ativos exportados.`, 'success');
                },

                // ── Extrator inteligente de contato por texto livre ──
                // ── Extrator inteligente de contato por texto livre ──
                disparoExtrairContato() {
                    const texto = (this.disparoExtractorInput || '').trim();
                    if (!texto) { this.addNotification('Campo vazio', 'Cole os números para formatar.', 'warn'); return; }

                    // ── Padrões que NÃO são telefone ──
                    // CPF: 000.000.000-00 ou 00000000000 (11 dígitos com pontuação de CPF)
                    // CNPJ: 00.000.000/0000-00
                    const ehCPF   = (raw) => /^\d{3}[\.\s]\d{3}[\.\s]\d{3}[-\/\.\s]\d{2}$/.test(raw.trim()) || /^\d{11}$/.test(raw.replace(/\D/g,'')) && raw.includes('.');
                    const ehCNPJ  = (raw) => /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(raw);

                    // ── Normaliza para formato WhatsApp: 55DDD9XXXXXXXX ──
                    const normalizarNum = (raw) => {
                        // Rejeita CPF/CNPJ antes de qualquer coisa
                        if (ehCPF(raw) || ehCNPJ(raw)) return null;

                        let d = raw.replace(/\D/g, '');

                        // CPF tem 11 dígitos mas começa com padrão diferente de DDD válido
                        // Rejeita se o "DDD" extraído não for um DDD brasileiro válido (11-99)
                        const validarDDD = (ddd) => {
                            const n = parseInt(ddd, 10);
                            return n >= 11 && n <= 99;
                        };

                        if (d.startsWith('55') && d.length > 13) d = d.slice(2);

                        if (d.startsWith('55')) {
                            const semPais = d.slice(2);
                            const ddd = semPais.slice(0, 2);
                            if (!validarDDD(ddd)) return null;
                            const num = semPais.slice(2);
                            if (num.length === 8) return '55' + ddd + '9' + num;
                            if (num.length === 9) return '55' + ddd + num;
                            return null;
                        }

                        if (d.length === 10) {
                            const ddd = d.slice(0, 2);
                            if (!validarDDD(ddd)) return null;
                            return '55' + ddd + '9' + d.slice(2);
                        }
                        if (d.length === 11) {
                            const ddd = d.slice(0, 2);
                            if (!validarDDD(ddd)) return null;
                            return '55' + d;
                        }

                        return null;
                    };

                    // ── Chave canônica: normaliza removendo o 9 para deduplicar ──
                    // 5588981841517 e 5588981841517 → mesma chave
                    const chaveCanonica = (num) => {
                        // Para BR: 55 + DDD(2) + 9 + 8dígitos → remove o 9
                        if (num.startsWith('55') && num.length === 13) {
                            return '55' + num.slice(2,4) + num.slice(5); // remove o 9
                        }
                        return num;
                    };

                    // ── Extrai telefones do texto usando regex BR ──
                    const PHONE_RE = /\(?\d{2}\)?\s*\d{4,5}[-.\s]?\d{4}/g;
                    const matchesTelefone = [...texto.matchAll(PHONE_RE)].map(m => m[0].trim());

                    // Tokens soltos (ex: 8881841517 numa linha só)
                    const tokens = texto.split(/[\s,;\n]+/).map(t => t.trim()).filter(t => /^\d[\d\s\-\.()]+$/.test(t));

                    const todosRaw = [...matchesTelefone, ...tokens];
                    const vistosCanonico = new Set();
                    const numerosFormatados = [];

                    for (const raw of todosRaw) {
                        const num = normalizarNum(raw);
                        if (!num) continue;
                        const chave = chaveCanonica(num);
                        if (vistosCanonico.has(chave)) continue; // mesmo número com/sem 9
                        vistosCanonico.add(chave);
                        numerosFormatados.push(num);
                    }

                    if (numerosFormatados.length === 0) {
                        this.addNotification('Nenhum número encontrado', 'Verifique se os números têm DDD.', 'error');
                        return;
                    }

                    // ── Adiciona à fila sem duplicar (considera variante com/sem 9) ──
                    const canonicosNaFila = new Set(this.disparoContatosExtraidos.map(c => chaveCanonica(c.numero)));
                    let adicionados = 0, duplicados = 0;
                    for (const num of numerosFormatados) {
                        const chave = chaveCanonica(num);
                        if (canonicosNaFila.has(chave)) { duplicados++; continue; }
                        this.disparoContatosExtraidos.push({ nome: 'Contato', numero: num });
                        canonicosNaFila.add(chave);
                        adicionados++;
                    }

                    this.disparoExtractorInput = '';

                    let msg = `✅ ${adicionados} número(s) adicionado(s)`;
                    if (duplicados > 0) msg += ` · ⚠️ ${duplicados} duplicado(s) ignorado(s)`;
                    this.addNotification('Números formatados', msg, adicionados > 0 ? 'success' : 'warn');
                    this.$nextTick(() => lucide.createIcons());
                },

                async _buildLeadsQueue() {
                    let alvos = [];
                    if (this.disparoConfig.status === 'importados' || this.disparoConfig.status === 'arquivo') {
                        if (!this.disparoConfig.numerosImportados) { alert('Cole os números ou importe um arquivo.'); return null; }
                        const numeros = this.disparoConfig.numerosImportados.split(/[\n,;]+/).map(n => n.replace(/\D/g, '').trim()).filter(n => n.length >= 10);
                        if (numeros.length === 0) { alert('Nenhum número válido encontrado.'); return null; }
                        this.addNotification('Importando...', `Criando ${numeros.length} novos leads no painel.`, 'info');
                        for (let num of numeros) { const { data: newLead } = await this.client.from('leads').upsert({ numero: num, nome: 'Lead Importado', instance_name: this.instanceName }, { onConflict: 'numero,instance_name' }).select().single(); if (newLead) alvos.push(newLead); }
                        await this.loadLeads();
                    } else if (this.disparoConfig.status === 'extrator') {
                        if (this.disparoContatosExtraidos.length === 0) { alert('Nenhum contato na fila. Adicione pelo menos um.'); return null; }
                        this.addNotification('Importando...', `Criando ${this.disparoContatosExtraidos.length} contatos no painel.`, 'info');
                        for (let c of this.disparoContatosExtraidos) {
                            const { data: newLead } = await this.client.from('leads').upsert(
                                { numero: c.numero, nome: c.nome, instance_name: this.instanceName },
                                { onConflict: 'numero,instance_name' }
                            ).select().single();
                            if (newLead) {
                                // Atualiza nome se o lead já existia com nome genérico
                                if (newLead.nome === 'Lead Importado' || newLead.nome === 'Lead Avulso') {
                                    await this.client.from('leads').update({ nome: c.nome }).eq('id', newLead.id);
                                    newLead.nome = c.nome;
                                }
                                alvos.push(newLead);
                            }
                        }
                        await this.loadLeads();
                    } else if (this.disparoConfig.status === 'todos') { alvos = [...this.myLeads]; }
                    else { alvos = this.myLeads.filter(l => l.status === this.disparoConfig.status); }
                    return alvos;
                },

                async iniciarDisparo() {
                    if (this.disparoConfig.isRunning || this.disparoConfig.isPaused) return;
                    if (this.disparoConfig.tipoMensagem === 'simples') {
                        const msgs = [this.disparoConfig.msg, ...this.disparoConfig.msgs].filter(m => m && m.trim());
                        if (msgs.length === 0 && !this.disparoConfig.file && !this.disparoConfig.publicMediaUrl) {
                            alert('Configure pelo menos uma mensagem ou anexe um arquivo antes de iniciar o disparo.'); return;
                        }
                    } else if (this.disparoConfig.tipoMensagem === 'fluxo') {
                        if (!this.disparoConfig.selectedFlowId) { alert('Selecione um fluxo antes de iniciar o disparo.'); return; }
                    }
                    const alvos = await this._buildLeadsQueue();
                    if (!alvos || alvos.length === 0) { alert('Nenhum lead encontrado.'); return; }

                    // Upload mídia UMA VEZ antes de iniciar (URL persistida no config para retomada)
                    if (this.disparoConfig.tipoMensagem === 'simples' && this.disparoConfig.file) {
                        try {
                            this.addNotification('Enviando mídia...', 'Fazendo upload do arquivo...', 'info');
                            const file = this.disparoConfig.file;
                            const fileName = `bulk-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
                            const publicUrl = await localUpload(`chat_media/disparos/${fileName}`, file, file.type);
                            const { data: urlData } = { data: { publicUrl } };
                            this.disparoConfig.publicMediaUrl = urlData.publicUrl;
                            this.disparoConfig.mediaType = file.type.includes('image') ? 'image' : file.type.includes('video') ? 'video' : file.type.includes('audio') ? 'audio' : 'document';
                            this.disparoConfig.mediaFileName = file.name;
                            this.disparoConfig.mediaMime = file.type || 'application/octet-stream';
                        } catch(e) { alert('Erro ao fazer upload da mídia: ' + e.message); return; }
                    }

                    // Blacklist — filtra números a ignorar
                    const blackSet = new Set(
                        (this.disparoConfig.antibanBlacklist || '').split(/[\n,;]+/)
                            .map(n => n.replace(/\D/g,'').trim()).filter(n => n.length >= 8)
                    );
                    const filtrados = alvos.filter(l => !blackSet.has((l.numero||'').replace(/\D/g,'')));
                    const shuffled = [...filtrados].sort(() => Math.random() - 0.5);

                    this.disparoConfig.leadsQueue = shuffled;
                    this.disparoConfig.lastIndex = 0;
                    this.disparoConfig.sent = 0;
                    this.disparoConfig.erros = 0;
                    this.disparoConfig.total = shuffled.length;
                    this.disparoConfig.campanhaId = Date.now();
                    this.disparoConfig.antibanBatchCount = 0;
                    this.disparoConfig.antibanCurrentBatchSize = this.disparoConfig.antibanWarmup
                        ? this.disparoConfig.antibanWarmupStart
                        : this.disparoConfig.antibanBatchSize;

                    const hoje = new Date().toISOString().slice(0,10);
                    if (this.disparoConfig.antibanDailyDate !== hoje) {
                        this.disparoConfig.antibanDailyCount = 0;
                        this.disparoConfig.antibanDailyDate = hoje;
                    }
                    this._salvarDisparoStorage();
                    await this._executarDisparo();
                },

                async continuarDisparo() {
                    if (this.disparoConfig.isRunning) return;
                    if (!this.disparoConfig.leadsQueue || this.disparoConfig.leadsQueue.length === 0) { alert('Nenhuma campanha pausada.'); return; }
                    this.disparoConfig.isPaused = false;
                    await this._executarDisparo();
                },

                async _executarDisparo() {
                    this.disparoConfig.isRunning = true;
                    this.disparoConfig.isPaused = false;
                    await this.requestWakeLock();
                    this.showNativeNotification('Disparo Iniciado', `Enviando para ${this.disparoConfig.total} contatos`, 'disparo-start');

                    const queue = this.disparoConfig.leadsQueue;
                    const hoje = new Date().toISOString().slice(0,10);
                    // Posição dentro do lote atual (reseta após pausa de lote)
                    let posNoLote = 0;

                    // ── HELPER: aguarda a aba ficar visível antes de prosseguir (fix mobile) ──
                    const _esperarVisivel = () => {
                        if (!document.hidden) return Promise.resolve();
                        return new Promise(resolve => {
                            const handler = () => {
                                if (!document.hidden) {
                                    document.removeEventListener('visibilitychange', handler);
                                    resolve();
                                }
                            };
                            document.addEventListener('visibilitychange', handler);
                        });
                    };

                    for (let i = this.disparoConfig.lastIndex; i < queue.length; i++) {
                        if (!this.disparoConfig.isRunning) break;

                        // Limite diário anti-ban
                        if (this.disparoConfig.antibanLimitPerDay > 0) {
                            if (this.disparoConfig.antibanDailyDate !== hoje) {
                                this.disparoConfig.antibanDailyCount = 0;
                                this.disparoConfig.antibanDailyDate = hoje;
                            }
                            if (this.disparoConfig.antibanDailyCount >= this.disparoConfig.antibanLimitPerDay) {
                                this.disparoConfig.isRunning = false;
                                this.disparoConfig.isPaused = true;
                                this._salvarDisparoStorage();
                                this.addNotification('🛡️ Limite diário atingido',
                                    `${this.disparoConfig.antibanLimitPerDay} mensagens enviadas hoje. Campanha pausada.`, 'warn');
                                return;
                            }
                        }

                        // Pause por lote anti-ban
                        if (this.disparoConfig.antibanBatch && posNoLote > 0) {
                            const batchAtual = this.disparoConfig.antibanCurrentBatchSize || this.disparoConfig.antibanBatchSize || 20;
                            if (posNoLote % batchAtual === 0) {
                                this.disparoConfig.antibanBatchCount++;
                                if (this.disparoConfig.antibanWarmup) {
                                    this.disparoConfig.antibanCurrentBatchSize = Math.min(
                                        this.disparoConfig.antibanWarmupStart + (this.disparoConfig.antibanBatchCount * this.disparoConfig.antibanWarmupStep),
                                        this.disparoConfig.antibanWarmupMax
                                    );
                                }
                                const pauseSec = parseInt(this.disparoConfig.antibanBatchPauseSec) || 300;
                                this.disparoConfig.lastIndex = i;
                                this._salvarDisparoStorage();
                                this.addNotification(`🛡️ Pausa anti-ban (lote ${this.disparoConfig.antibanBatchCount})`,
                                    `Pausando ${Math.round(pauseSec/60)} min antes do próximo lote...`, 'info');
                                for (let t = pauseSec; t > 0; t--) {
                                    if (!this.disparoConfig.isRunning) break;
                                    this.disparoConfig._batchPauseCountdown = t;
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                                this.disparoConfig._batchPauseCountdown = 0;
                                posNoLote = 0;
                                if (!this.disparoConfig.isRunning) break;
                            }
                        }
                        posNoLote++;

                        const lead = queue[i];
                        try {
                            if (this.disparoConfig.tipoMensagem === 'fluxo') {
                                const rule = this.botRules.find(r => r.id === this.disparoConfig.selectedFlowId);
                                if (rule) await this.triggerBotRuleManual(rule, lead);
                            } else {
                                // Typing indicator anti-ban
                                if (this.disparoConfig.antibanTyping) {
                                    try {
                                        const typingSec = parseInt(this.disparoConfig.antibanTypingSec) || 3;
                                        await this._evoSend('chat/updatePresence', {
                                            number: lead.numero,
                                            options: { presence: 'composing', delay: typingSec * 1000 }
                                        });
                                        await new Promise(r => setTimeout(r, typingSec * 1000));
                                    } catch(e) { /* non-critical */ }
                                }
                                // Enviar mídia (usa URL persistida no config)
                                if (this.disparoConfig.publicMediaUrl) {
                                    const mType = this.disparoConfig.mediaType;
                                    if (mType === 'audio') {
                                        await this._evoSend('sendWhatsAppAudio', { number: lead.numero, audio: this.disparoConfig.publicMediaUrl });
                                    } else {
                                        const evoMType = mType === 'image' ? 'image' : mType === 'video' ? 'video' : 'document';
                                        await this._evoSend('sendMedia', {
                                            number: lead.numero, mediatype: evoMType,
                                            mimetype: this.disparoConfig.mediaMime || 'application/octet-stream',
                                            media: this.disparoConfig.publicMediaUrl,
                                            fileName: this.disparoConfig.mediaFileName || 'Arquivo', caption: ''
                                        });
                                    }
                                    if (lead.id) await this.client.from('messages').insert({
                                        lead_id: lead.id, content: this.disparoConfig.publicMediaUrl,
                                        from_me: true, type: this.disparoConfig.mediaType,
                                        status: 'sent', instance_name: this.instanceName
                                    }).catch(()=>{});
                                }
                                // Enviar texto
                                const todasMsgs = [this.disparoConfig.msg, ...this.disparoConfig.msgs].filter(m => m && m.trim());
                                if (todasMsgs.length > 0) {
                                    const msgEscolhida = todasMsgs[Math.floor(Math.random() * todasMsgs.length)];
                                    const msgPronta = this.processSpintax(msgEscolhida, lead);
                                    await this._evoSend('sendText', { number: lead.numero, text: msgPronta });
                                    if (lead.id) await this.client.from('messages').insert({
                                        lead_id: lead.id, content: msgPronta, from_me: true,
                                        type: 'text', status: 'sent', instance_name: this.instanceName
                                    }).catch(()=>{});
                                }
                            }
                        } catch (e) {
                            this.disparoConfig.erros = (this.disparoConfig.erros || 0) + 1;
                            console.error('Erro disparo:', lead.numero, e.message);
                        }

                        this.disparoConfig.sent++;
                        this.disparoConfig.antibanDailyCount = (this.disparoConfig.antibanDailyCount || 0) + 1;
                        this.disparoConfig.lastIndex = i + 1;
                        this._salvarDisparoStorage();

                        // Delay entre mensagens
                        if (i < queue.length - 1 && this.disparoConfig.isRunning) {
                            const minD = parseInt(this.disparoConfig.minDelay) || 30;
                            const maxD = parseInt(this.disparoConfig.maxDelay) || 60;
                            const delay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
                            // Aguarda aba visível antes de continuar (fix mobile — browsers throttle timers em background)
                            await _esperarVisivel();
                            if (!this.disparoConfig.isRunning) break;
                            await new Promise(r => setTimeout(r, delay * 1000));
                        }
                    }

                    this.disparoConfig.isRunning = false;
                    if (this.disparoConfig.isPaused) {
                        this._salvarDisparoStorage();
                        this.addNotification('Disparo Pausado',
                            `Enviado para ${this.disparoConfig.sent} de ${this.disparoConfig.total}. Clique em Continuar para retomar.`, 'info');
                        this.showNativeNotification('Disparo Pausado', `Enviado: ${this.disparoConfig.sent}/${this.disparoConfig.total}`, 'disparo-paused');
                    } else {
                        this._limparDisparoStorage();
                        const erros = this.disparoConfig.erros || 0;
                        this.addNotification('🎉 Disparo Finalizado',
                            erros > 0 ? `${this.disparoConfig.sent - erros} enviados, ${erros} erro(s).` : `Enviado com sucesso para ${this.disparoConfig.sent} leads.`,
                            erros > 0 ? 'warn' : 'success');
                        this.showNativeNotification('✅ Disparo Concluído!', `${this.disparoConfig.sent} contatos`, 'disparo-complete');
                        this.disparoConfig.leadsQueue = [];
                        this.disparoConfig.lastIndex = 0;
                    }
                    this._refreshIcons();
                },

                pausarDisparo() {
                    this.disparoConfig.isRunning = false;
                    this.disparoConfig.isPaused = true;
                    this._salvarDisparoStorage();
                    this._refreshIcons();
                },

                pararDisparo() {
                    this.disparoConfig.isRunning = false;
                    this.disparoConfig.isPaused = false;
                    this.disparoConfig.leadsQueue = [];
                    this.disparoConfig.lastIndex = 0;
                    this.disparoConfig.sent = 0;
                    this.disparoConfig.total = 0;
                    this.disparoConfig.publicMediaUrl = null;
                    this.disparoConfig.mediaType = null;
                    this.disparoConfig.mediaFileName = null;
                    this.disparoConfig.mediaMime = null;
                    this._limparDisparoStorage();
                    this.addNotification('Disparo Cancelado', 'A campanha foi encerrada.', 'error');
                    this._refreshIcons();
                },

                _salvarDisparoStorage() {
                    try {
                        const campos = ['status','tipoMensagem','selectedFlowId','numerosImportados','msg','msgs',
                            'minDelay','maxDelay','publicMediaUrl','mediaType','mediaFileName','mediaMime',
                            'isRunning','isPaused','sent','total','erros','leadsQueue','lastIndex','campanhaId',
                            'antibanTyping','antibanTypingSec','antibanBatch','antibanBatchSize','antibanBatchPauseSec',
                            'antibanBlacklist','antibanLimitPerDay','antibanDailyCount','antibanDailyDate',
                            'antibanWarmup','antibanWarmupStart','antibanWarmupStep','antibanWarmupMax',
                            'antibanBatchCount','antibanCurrentBatchSize'];
                        const snap = {};
                        campos.forEach(k => snap[k] = this.disparoConfig[k]);
                        if (snap.isRunning) { snap.isRunning = false; snap.isPaused = true; }
                        localStorage.setItem(`evo_disparo_${this.instanceName}`, JSON.stringify(snap));
                    } catch(e) { console.warn('Erro ao salvar disparo:', e); }
                },

                _limparDisparoStorage() {
                    localStorage.removeItem(`evo_disparo_${this.instanceName}`);
                },

                _restoreDisparoState() {
                    try {
                        const raw = localStorage.getItem(`evo_disparo_${this.instanceName}`);
                        if (!raw) return;
                        const snap = JSON.parse(raw);
                        if (!snap.isPaused && !snap.isRunning) return;
                        if (!snap.leadsQueue || snap.leadsQueue.length === 0) return;
                        if (snap.lastIndex >= snap.total) return;
                        Object.keys(snap).forEach(k => { if (k in this.disparoConfig) this.disparoConfig[k] = snap[k]; });
                        this.disparoConfig.isRunning = false;
                        this.disparoConfig.isPaused = true;
                        const faltam = snap.total - snap.lastIndex;
                        this.addNotification('📋 Campanha restaurada',
                            `Faltam ${faltam} de ${snap.total} envios. Vá em Campanhas e clique em "Continuar".`, 'info');
                        this._disparoRestored = true;
                    } catch(e) { console.warn('Erro ao restaurar disparo:', e); }
                },


                /* ── MODELOS DE DISPARO ── */
                async loadDisparoModelos() {
                    try {
                        const { data } = await this.client.from('disparo_modelos').select('*').eq('instance_name', this.instanceName).order('created_at', { ascending: false });
                        if (data) this.disparoModelos = data;
                    } catch(e) { console.error('Erro ao carregar modelos:', e); }
                },

                async salvarDisparoModelo() {
                    if (!this.modeloNome.trim()) return;
                    this.modeloSalvando = true;
                    try {
                        const payload = {
                            instance_name: this.instanceName,
                            nome: this.modeloNome.trim(),
                            tipo_mensagem: this.disparoConfig.tipoMensagem,
                            msg: this.disparoConfig.msg || '',
                            msgs: this.disparoConfig.msgs || [],
                            min_delay: parseInt(this.disparoConfig.minDelay) || 30,
                            max_delay: parseInt(this.disparoConfig.maxDelay) || 60,
                            selected_flow_id: this.disparoConfig.selectedFlowId || null,
                            status_publico: this.disparoConfig.status || 'todos',
                        };
                        const { error } = await this.client.from('disparo_modelos').insert(payload);
                        if (!error) {
                            this.addNotification('Modelo Salvo!', `"${this.modeloNome.trim()}" foi salvo com sucesso.`, 'success');
                            this.modeloNome = '';
                            this.showSaveModeloModal = false;
                            await this.loadDisparoModelos();
                        } else {
                            this.addNotification('Erro', 'Não foi possível salvar o modelo.', 'error');
                        }
                    } catch(e) { this.addNotification('Erro', 'Falha ao salvar modelo.', 'error'); }
                    this.modeloSalvando = false;
                    this._refreshIcons();
                },

                carregarDisparoModelo(modelo) {
                    this.disparoConfig.tipoMensagem = modelo.tipo_mensagem || 'simples';
                    this.disparoConfig.msg = modelo.msg || '';
                    this.disparoConfig.msgs = modelo.msgs || [''];
                    this.disparoConfig.minDelay = modelo.min_delay || 30;
                    this.disparoConfig.maxDelay = modelo.max_delay || 60;
                    this.disparoConfig.selectedFlowId = modelo.selected_flow_id || '';
                    this.disparoConfig.status = modelo.status_publico || 'todos';
                    this.showModelosModal = false;
                    this.addNotification('Modelo Carregado!', `"${modelo.nome}" aplicado ao disparo.`, 'info');
                    this._refreshIcons();
                },

                async deletarDisparoModelo(id, nome) {
                    if (!confirm(`Apagar o modelo "${nome}"?`)) return;
                    await this.client.from('disparo_modelos').delete().eq('id', id);
                    await this.loadDisparoModelos();
                    this.addNotification('Modelo Apagado', `"${nome}" foi removido.`, 'error');
                    this._refreshIcons();
                },

                // ══════════════════════════════════════════════════════════
                //  MÉTODOS: RESPOSTAS AUTOMÁTICAS (Chatbot por palavra-chave)
                // ══════════════════════════════════════════════════════════

                async arCarregarDados() {
                    try {
                        // Configuração geral
                        const { data: cfg } = await this.client.from('auto_replies_config')
                            .select('*').eq('instance_name', this.instanceName).single();
                        if (cfg) { this.arBotAtivo = cfg.bot_ativo ?? true; this.arTotalDisparos = cfg.total_disparos || 0; }

                        // Regras
                        const { data: regras } = await this.client.from('auto_replies')
                            .select('*').eq('instance_name', this.instanceName)
                            .order('prioridade', { ascending: true });
                        if (regras) {
                            this.autoReplies = regras.map(r => ({
                                id: r.id, gatilhos: r.gatilhos, modoMatch: r.modo_match || 'contem',
                                blocos: typeof r.blocos === 'string' ? JSON.parse(r.blocos) : (r.blocos || []),
                                apenasUmaVez: r.apenas_uma_vez || false, prioridade: r.prioridade || 2,
                                ativo: r.ativo ?? true, disparos: r.disparos || 0
                            }));
                        }

                        // Leads já respondidos
                        const { data: respondidos } = await this.client.from('auto_replies_respondidos')
                            .select('regra_id, lead_id').eq('instance_name', this.instanceName);
                        if (respondidos) {
                            this.arLeadsJaRespondidos = {};
                            respondidos.forEach(r => { this.arLeadsJaRespondidos[`${r.regra_id}_${r.lead_id}`] = true; });
                        }
                    } catch(e) {
                        // Fallback localStorage
                        try {
                            const saved = localStorage.getItem(`evo_auto_replies_${this.instanceName}`);
                            if (saved) this.autoReplies = JSON.parse(saved);
                            const meta = localStorage.getItem(`evo_ar_meta_${this.instanceName}`);
                            if (meta) { const m = JSON.parse(meta); this.arBotAtivo = m.ativo ?? true; this.arTotalDisparos = m.totalDisparos || 0; }
                        } catch(e2) {}
                    }
                },

                async arSalvarDados() {
                    try {
                        await this.client.from('auto_replies_config').upsert({
                            instance_name: this.instanceName,
                            bot_ativo: this.arBotAtivo,
                            total_disparos: this.arTotalDisparos,
                            updated_at: new Date().toISOString()
                        }, { onConflict: 'instance_name' });
                    } catch(e) { console.warn('[Bot] Erro ao salvar config:', e.message); }
                },

                async arToggleBot() {
                    this.arBotAtivo = !this.arBotAtivo;
                    await this.arSalvarDados();
                    this.addNotification(this.arBotAtivo ? 'Bot Ativado' : 'Bot Pausado', this.arBotAtivo ? 'O chatbot está respondendo.' : 'Respostas automáticas pausadas.', this.arBotAtivo ? 'success' : 'info');
                },

                async arToggleRegra(regra) {
                    regra.ativo = !regra.ativo;
                    try {
                        await this.client.from('auto_replies').update({ ativo: regra.ativo }).eq('id', regra.id);
                    } catch(e) {}
                    this._refreshIcons();
                },

                arAdicionarBloco(tipo) {
                    const novoBloco = { tipo, conteudo: '', arquivo: null, nomeArquivo: '', delay: 3 };
                    this.arForm.blocos.push(novoBloco);
                    this._refreshIcons();
                },

                arRemoverBloco(idx) { this.arForm.blocos.splice(idx, 1); },

                arMoverBlocoAcima(idx) {
                    if (idx === 0) return;
                    const tmp = this.arForm.blocos[idx];
                    this.arForm.blocos[idx] = this.arForm.blocos[idx-1];
                    this.arForm.blocos[idx-1] = tmp;
                    this.arForm.blocos = [...this.arForm.blocos];
                    this._refreshIcons();
                },

                arMoverBlocoAbaixo(idx) {
                    if (idx >= this.arForm.blocos.length - 1) return;
                    const tmp = this.arForm.blocos[idx];
                    this.arForm.blocos[idx] = this.arForm.blocos[idx+1];
                    this.arForm.blocos[idx+1] = tmp;
                    this.arForm.blocos = [...this.arForm.blocos];
                    this._refreshIcons();
                },

                arInserirVar(blocoIdx, variavel) {
                    this.arForm.blocos[blocoIdx].conteudo = (this.arForm.blocos[blocoIdx].conteudo || '') + variavel;
                },

                arAnexarArquivo(event, blocoIdx) {
                    const file = event.target.files[0];
                    if (!file) return;
                    this.arForm.blocos[blocoIdx].arquivo = file;
                    this.arForm.blocos[blocoIdx].nomeArquivo = file.name;
                    this.arForm.blocos[blocoIdx].conteudo = '';
                },

                async arSalvarRegra() {
                    if (!this.arForm.gatilhos.trim()) return alert('Defina ao menos uma palavra-chave.');
                    if (this.arForm.blocos.length === 0) return alert('Adicione ao menos um bloco de resposta.');
                    this.arSalvando = true;

                    try {
                        // Upload de mídias pendentes
                        const blocosFinais = [];
                        for (const bloco of this.arForm.blocos) {
                            if (['audio','imagem','video','documento'].includes(bloco.tipo) && bloco.arquivo) {
                                const fileName = `ar-${Date.now()}-${bloco.arquivo.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
                                const publicUrl = await localUpload(`chat_media/bot_media/${fileName}`, bloco.arquivo, bloco.arquivo.type);
                                const data = { publicUrl };
                                blocosFinais.push({ tipo: bloco.tipo, conteudo: data.publicUrl, nomeArquivo: bloco.nomeArquivo, delay: bloco.delay });
                            } else {
                                blocosFinais.push({ tipo: bloco.tipo, conteudo: bloco.conteudo, nomeArquivo: bloco.nomeArquivo || '', delay: bloco.delay });
                            }
                        }

                        const payload = {
                            instance_name: this.instanceName,
                            gatilhos: this.arForm.gatilhos.trim(),
                            modo_match: this.arForm.modoMatch,
                            blocos: blocosFinais,
                            apenas_uma_vez: this.arForm.apenasUmaVez,
                            prioridade: parseInt(this.arForm.prioridade),
                        };

                        if (this.arEditId) {
                            // Editar existente
                            const { error } = await this.client.from('auto_replies').update(payload).eq('id', this.arEditId);
                            if (error) throw error;
                            const idx = this.autoReplies.findIndex(r => r.id === this.arEditId);
                            if (idx !== -1) this.autoReplies[idx] = { ...this.autoReplies[idx], ...payload, blocos: blocosFinais };
                        } else {
                            // Nova regra
                            const { data, error } = await this.client.from('auto_replies').insert({ ...payload, ativo: true, disparos: 0 }).select().single();
                            if (error) throw error;
                            this.autoReplies.push({ id: data.id, gatilhos: payload.gatilhos, modoMatch: payload.modo_match, blocos: blocosFinais, apenasUmaVez: payload.apenas_uma_vez, prioridade: payload.prioridade, ativo: true, disparos: 0 });
                        }

                        this.arCancelarEdicao();
                        this.addNotification('Regra Salva ✅', 'O servidor já vai usar a nova regra automaticamente!', 'success');
                    } catch(e) {
                        alert('Erro ao salvar: ' + e.message);
                        console.error(e);
                    }
                    this.arSalvando = false;
                    this._refreshIcons();
                },

                arEditarRegra(regra) {
                    this.arEditId = regra.id;
                    this.arForm.gatilhos = regra.gatilhos;
                    this.arForm.modoMatch = regra.modoMatch || 'contem';
                    this.arForm.blocos = JSON.parse(JSON.stringify(regra.blocos));
                    this.arForm.apenasUmaVez = regra.apenasUmaVez || false;
                    this.arForm.prioridade = String(regra.prioridade || 2);
                    this.botTab = 'respostas';
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    this._refreshIcons();
                },

                arCancelarEdicao() {
                    this.arEditId = null;
                    this.arForm = { gatilhos: '', modoMatch: 'contem', blocos: [], apenasUmaVez: false, prioridade: '2' };
                    this._refreshIcons();
                },

                async arExcluirRegra(id) {
                    if (!confirm('Excluir esta regra de resposta automática?')) return;
                    try {
                        await this.client.from('auto_replies').delete().eq('id', id);
                    } catch(e) {}
                    this.autoReplies = this.autoReplies.filter(r => r.id !== id);
                    this._refreshIcons();
                },

                // Verifica se a mensagem recebida casa com alguma regra
                arChecarMensagem(mensagem, lead) {
                    if (!this.arBotAtivo) return;
                    if (!mensagem || !lead) return;

                    const texto = mensagem.toLowerCase().trim();
                    // Ordena por prioridade (1=alta, 2=média, 3=baixa) - números menores primeiro
                    const regrasAtivas = this.autoReplies
                        .filter(r => r.ativo)
                        .sort((a, b) => parseInt(a.prioridade || 2) - parseInt(b.prioridade || 2));

                    for (const regra of regrasAtivas) {
                        // Verificar "apenas uma vez por lead"
                        if (regra.apenasUmaVez) {
                            const chave = `${regra.id}_${lead.id}`;
                            if (this.arLeadsJaRespondidos[chave]) continue;
                        }

                        const gatilhos = regra.gatilhos.split(',').map(g => g.trim().toLowerCase()).filter(Boolean);
                        let match = false;

                        for (const gatilho of gatilhos) {
                            if (regra.modoMatch === 'exato' && texto === gatilho) { match = true; break; }
                            else if (regra.modoMatch === 'inicio' && texto.startsWith(gatilho)) { match = true; break; }
                            else if (regra.modoMatch === 'contem' && texto.includes(gatilho)) { match = true; break; }
                        }

                        if (match) {
                            this.arExecutarRegra(regra, lead);
                            break; // apenas uma regra por mensagem
                        }
                    }
                },

                async arExecutarRegra(regra, lead) {
                    // Marcar como respondido se "apenas uma vez"
                    if (regra.apenasUmaVez) {
                        const chave = `${regra.id}_${lead.id}`;
                        this.arLeadsJaRespondidos[chave] = true;
                        localStorage.setItem(`evo_ar_respondidos_${this.instanceName}`, JSON.stringify(this.arLeadsJaRespondidos));
                    }

                    // Atualizar contagem
                    const idx = this.autoReplies.findIndex(r => r.id === regra.id);
                    if (idx !== -1) { this.autoReplies[idx].disparos = (this.autoReplies[idx].disparos || 0) + 1; }
                    this.arTotalDisparos++;
                    this.arSalvarDados();

                    // Executar blocos sequencialmente (reutiliza lógica do triggerBotRuleManual)
                    const insertAndPush = async (insertObj) => {
                        const tempId = 'ar-' + Date.now() + Math.random();
                        const tempMsg = { ...insertObj, id: tempId, timestamp: new Date().toISOString() };
                        this.updateLeadLocalInteraction(lead.id, insertObj.content, insertObj.type);
                        if (this.isChatOpen && this.selectedLead && lead.id === this.selectedLead.id) {
                            this.messages = [...this.messages, tempMsg];
                            this.scrollToBottom();
                            this._refreshIcons();
                        }
                        try { const { data } = await this.client.from('messages').insert(insertObj).select().single(); if(data) this.resolveTempMessage(tempId, data); } catch(e) {}
                    };

                    for (const bloco of regra.blocos) {
                        if (bloco.tipo === 'delay') {
                            await new Promise(r => setTimeout(r, (parseInt(bloco.delay) || 3) * 1000));
                        } else if (bloco.tipo === 'texto') {
                            const texto = this.processSpintax(bloco.conteudo, lead);
                            this._evoSend('sendText', { number: lead.numero, text: texto }).catch(e => console.log(e));
                            await insertAndPush({ lead_id: lead.id, content: texto, from_me: true, type: 'text', status: 'sent', instance_name: this.instanceName });
                            await new Promise(r => setTimeout(r, 800));
                        } else {
                            // Mídia
                            let endpoint = 'sendMedia';
                            let mType = bloco.tipo === 'imagem' ? 'image' : bloco.tipo === 'video' ? 'video' : bloco.tipo === 'documento' ? 'document' : bloco.tipo;
                            let mime = 'application/octet-stream';
                            if (mType === 'image') mime = 'image/jpeg';
                            else if (mType === 'video') mime = 'video/mp4';
                            const fn = (bloco.nomeArquivo || '').toLowerCase();
                            if (fn.endsWith('.png')) mime = 'image/png';
                            if (fn.endsWith('.jpg') || fn.endsWith('.jpeg')) mime = 'image/jpeg';
                            if (fn.endsWith('.mp4')) mime = 'video/mp4';
                            if (fn.endsWith('.pdf')) mime = 'application/pdf';
                            let bodyMedia = { number: lead.numero, mediatype: mType, mimetype: mime, media: bloco.conteudo, fileName: bloco.nomeArquivo || 'arquivo', mediaMessage: { mediatype: mType, mimetype: mime, media: bloco.conteudo, fileName: bloco.nomeArquivo || 'arquivo' } };
                            if (bloco.tipo === 'audio') { endpoint = 'sendWhatsAppAudio'; bodyMedia = { number: lead.numero, audio: bloco.conteudo }; }
                            this._evoSend(endpoint, bodyMedia).catch(e => console.log(e));
                            await insertAndPush({ lead_id: lead.id, content: bloco.conteudo, from_me: true, type: bloco.tipo, status: 'sent', instance_name: this.instanceName });
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                },

                // ── IA ATENDIMENTO ──
                async iaLoadSavedPrompts() {
                    this.iaLoadingPrompts = true;
                    try {
                        const { data } = await this.client.from('ia_prompts').select('*')
                            .eq('instance_name', this.instanceName)
                            .order('created_at', { ascending: false });
                        this.iaSavedPrompts = data || [];
                    } catch(e) { console.warn('[IA]', e); }
                    finally { this.iaLoadingPrompts = false; this._refreshIcons(); }
                },

                iaAbrirNovoPrompt() {
                    this.iaEditingPrompt = null;
                    this.iaEditingPromptId = null;
                    this.iaPromptForm = { nome: '', descricao: '', prompt: '', modelo: 'gpt-4o-mini', temperatura: 0.7, max_tokens: 1024, pausa_se_humano: true, responder_grupos: false, delay_min: 1, delay_max: 3, palavra_chave: '' };
                    this.iaModalTab = 'prompt';
                    this.iaShowModal = true;
                    this._refreshIcons();
                },

                iaAbrirEditarPrompt(p) {
                    this.iaEditingPrompt = p;
                    this.iaEditingPromptId = p.id;
                    this.iaPromptForm = { nome: p.nome, descricao: p.descricao || '', prompt: p.prompt, modelo: p.modelo || 'gpt-4o-mini', temperatura: p.temperatura ?? 0.7, max_tokens: p.max_tokens ?? 1024, pausa_se_humano: p.pausa_se_humano ?? true, responder_grupos: p.responder_grupos ?? false, delay_min: p.delay_min ?? 1, delay_max: p.delay_max ?? 3, palavra_chave: p.palavra_chave || '' };
                    this.iaModalTab = 'prompt';
                    this.iaShowModal = true;
                    this._refreshIcons();
                },

                async iaSavePromptGlobal() {
                    const f = this.iaPromptForm;
                    if (!f.nome?.trim() || !f.prompt?.trim()) { alert('Nome e Prompt são obrigatórios.'); return; }
                    this.iaModalSaving = true;
                    const payload = { nome: f.nome, descricao: f.descricao, prompt: f.prompt, modelo: f.modelo, temperatura: f.temperatura, max_tokens: f.max_tokens, pausa_se_humano: f.pausa_se_humano, responder_grupos: f.responder_grupos, delay_min: f.delay_min, delay_max: f.delay_max, palavra_chave: (f.palavra_chave || '').trim().toLowerCase(), instance_name: this.instanceName, updated_at: new Date().toISOString() };
                    try {
                        if (this.iaEditingPromptId) {
                            await this.client.from('ia_prompts').update(payload).eq('id', this.iaEditingPromptId);
                            this.addNotification('Prompt atualizado!', f.nome, 'success');
                            // Se editou o prompt atualmente ativo, sincroniza config global imediatamente
                            if (this.iaEditingPromptId === this.iaSelectedPromptId) {
                                this.iaModelo          = f.modelo           || 'gpt-4o-mini';
                                this.iaDelayMin        = f.delay_min        ?? 1;
                                this.iaDelayMax        = f.delay_max        ?? 3;
                                this.iaTemperatura     = f.temperatura      ?? 0.7;
                                this.iaMaxTokens       = f.max_tokens       ?? 1024;
                                this.iaPrompt          = f.prompt;
                                this.iaPausaSeHumano   = f.pausa_se_humano  ?? true;
                                this.iaResponderGrupos = f.responder_grupos ?? false;
                                await this.iaSalvarConfig();
                            }
                        } else {
                            await this.client.from('ia_prompts').insert(payload);
                            this.addNotification('Prompt criado!', f.nome, 'success');
                        }
                        this.iaShowModal = false;
                        this.iaEditingPromptId = null;
                        this.iaEditingPrompt = null;
                        await this.iaLoadSavedPrompts();
                    } catch(e) { this.addNotification('Erro', e.message, 'error'); }
                    finally { this.iaModalSaving = false; }
                },

                async iaDeletarPrompt(id, nome) {
                    if (!confirm('Apagar o prompt "' + nome + '"?')) return;
                    await this.client.from('ia_prompts').delete().eq('id', id);
                    if (this.iaSelectedPromptId === id) { this.iaSelectedPromptId = null; await this.iaSalvarConfig(); }
                    await this.iaLoadSavedPrompts();
                    this.addNotification('Prompt removido', '', 'info');
                },

                async iaAtivarPrompt(p) {
                    this.iaPrompt = p.prompt;
                    this.iaModelo = p.modelo || 'gpt-4o-mini';
                    this.iaSelectedPromptId = p.id;
                    this.iaDelayMin = p.delay_min ?? 1;
                    this.iaDelayMax = p.delay_max ?? 3;
                    this.iaPausaSeHumano = p.pausa_se_humano ?? true;
                    this.iaResponderGrupos = p.responder_grupos ?? false;
                    this.iaTemperatura = p.temperatura ?? 0.7;
                    this.iaMaxTokens   = p.max_tokens  ?? 1024;
                    // Sincroniza iaPromptForm também
                    this.iaPromptForm.modelo      = this.iaModelo;
                    this.iaPromptForm.delay_min   = this.iaDelayMin;
                    this.iaPromptForm.delay_max   = this.iaDelayMax;
                    this.iaPromptForm.temperatura = this.iaTemperatura;
                    this.iaPromptForm.max_tokens  = this.iaMaxTokens;
                    await this.iaSalvarConfig();
                    this.addNotification('✅ Prompt ativado!', p.nome + ' está em uso.', 'success');
                },

                async iaDesativarPrompt() {
                    this.iaSelectedPromptId = null;
                    this.iaPrompt = '';
                    await this.iaSalvarConfig();
                    this.addNotification('⏸ Prompt desativado', 'Nenhum prompt ativo no momento.', 'info');
                    this._refreshIcons();
                },

                async iaSetLeadPrompt(prompt) {
                    // prompt = objeto { id, nome } ou null para remover
                    const leadId = this.selectedLead?.id;
                    if (!leadId) return;
                    const promptId = prompt?.id || null;
                    try {
                        const resp = await fetch('/api/ia/lead-prompt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId, prompt_id: promptId })
                        });
                        if (!resp.ok) throw new Error(await resp.text());
                        this.leadPromptIdPorLead[leadId] = promptId;
                        // Atualiza selectedLead também
                        this.selectedLead = { ...this.selectedLead, prompt_id: promptId };
                        const nome = prompt?.nome || 'Global';
                        this.addNotification(
                            promptId ? '🎯 Prompt da conversa definido' : '🔄 Prompt da conversa removido',
                            promptId ? `Esta conversa usará "${nome}"` : 'Voltando ao prompt global.',
                            'success'
                        );
                        this._refreshIcons();
                    } catch(e) {
                        this.addNotification('Erro', 'Não foi possível salvar o prompt da conversa.', 'error');
                        console.error('[iaSetLeadPrompt]', e);
                    }
                },



                async iaSalvarConfig() {
                    if (this.iaSalvando) return;
                    this.iaSalvando = true;
                    try {
                        const payloadFull = {
                            instance_name: this.instanceName,
                            ativo: this.iaAtivo,
                            api_key: this.iaApiKey,
                            prompt: this.iaPrompt,
                            modelo: this.iaModelo,
                            selected_prompt_id: this.iaSelectedPromptId || null,
                            delay_min: this.iaDelayMin,
                            delay_max: this.iaDelayMax,
                            pausa_se_humano: this.iaPausaSeHumano,
                            responder_grupos: this.iaResponderGrupos,
                            pausa_tempo: this.iaPausaTempo,
                            msg_max_chars: this.iaMsgMaxChars,
                            msg_delay_partes: this.iaMsgDelayEntrePartes,
                            msg_quebrar_linhas: this.iaMsgQuebrarLinhas,
                            tts_mode: this.iaTtsMode,
                            tts_voz: this.iaTtsVoz,
                            tts_max_seconds: this.iaTtsMaxSeconds,
                            tts_frequencia: this.iaTtsFrequencia,
                            temperatura: this.iaTemperatura ?? 0.7,
                            max_tokens: this.iaMaxTokens ?? 1024,
                            palavra_chave: (this.iaKeyword || '').trim().toLowerCase(),
                            palavra_retomar: (this.iaKeywordRetomar || '').trim().toLowerCase(),
                            buffer_tempo: this.iaBufferTempo ?? 8,
                            // ── Follow-up ──
                            followup_ativo:            this.iaFollowupAtivo,
                            followup_max_tentativas:   this.iaFollowupMaxTentativas,
                            followup_tempo_1:          this.iaFollowupTempo1,
                            followup_unidade_1:        this.iaFollowupUnidade1,
                            followup_tempo_2:          this.iaFollowupTempo2,
                            followup_unidade_2:        this.iaFollowupUnidade2,
                            followup_tempo_3:          this.iaFollowupTempo3,
                            followup_unidade_3:        this.iaFollowupUnidade3,
                            followup_horario_inicio:   this.iaFollowupHorarioInicio,
                            followup_horario_fim:      this.iaFollowupHorarioFim,
                            followup_ignorar_colunas:  this.iaFollowupIgnorarColunas,
                            updated_at: new Date().toISOString()
                        };
                        const { error } = await this.client
                            .from('ia_config')
                            .upsert(payloadFull, { onConflict: 'instance_name' });
                        if (error) {
                            // Coluna nova não existe ainda — salva payload mínimo sem as colunas novas
                            if (error.code === '42703' || (error.message && (error.message.includes('column') || error.message.includes('schema cache')))) {
                                const payloadMin = {
                                    instance_name: this.instanceName,
                                    ativo: this.iaAtivo,
                                    api_key: this.iaApiKey,
                                    prompt: this.iaPrompt,
                                    updated_at: new Date().toISOString()
                                };
                                const { error: err2 } = await this.client
                                    .from('ia_config')
                                    .upsert(payloadMin, { onConflict: 'instance_name' });
                                if (err2) throw err2;
                                // Salvo com payload mínimo — avisa sobre migração pendente
                                this.addNotification('⚠️ Salvo parcialmente', 'Execute a migração SQL na aba API para salvar todas as configs.', 'info');
                            } else {
                                throw error;
                            }
                        }
                        this.iaPromptSalvo = true;
                        setTimeout(() => { this.iaPromptSalvo = false; }, 2500);
                        // Notifica o servidor para recarregar a config imediatamente
                        try { await fetch('/api/reload-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inst: this.instanceName }) }); } catch(e2) {}
                    } catch(e) {
                        console.error('[IA Config] erro ao salvar:', e);
                        this.addNotification('Erro ao salvar config', (e?.message || String(e)).substring(0, 100), 'error');
                    } finally {
                        this.iaSalvando = false;
                    }
                },

                iaMidiaHandleFile(e) {
                    const f = e.target.files[0];
                    if (!f) return;
                    this.iaMidiaForm.arquivo = f;
                    this.iaMidiaForm.arquivo_nome = f.name;
                    if (f.type.startsWith('image/')) this.iaMidiaForm.tipo = 'image';
                    else if (f.type.startsWith('audio/')) this.iaMidiaForm.tipo = 'audio';
                    else if (f.type.startsWith('video/')) this.iaMidiaForm.tipo = 'video';
                    else this.iaMidiaForm.tipo = 'document';
                },

                async iaSalvarMidia() {
                    if (!this.iaMidiaForm.nome?.trim() || !this.iaMidiaForm.palavras_chave?.trim()) {
                        this.addNotification('Campos obrigatórios', 'Preencha Nome e Palavras-chave.', 'error'); return;
                    }
                    this.iaMidiaUploadLoading = true;
                    try {
                        let url = this.iaMidiaForm.url?.trim() || '';
                        if (this.iaMidiaForm.arquivo) {
                            const arquivo = this.iaMidiaForm.arquivo;
                            const ext = arquivo.name.split('.').pop();
                            const path = `ia_midias/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
                            const publicUrl = await localUpload(path, arquivo, arquivo.type);
                            url = publicUrl;
                        }
                        if (!url) { this.addNotification('Arquivo ou URL obrigatório', 'Faça upload ou informe uma URL.', 'error'); this.iaMidiaUploadLoading = false; return; }
                        const payload = {
                            instance_name: this.instanceName,
                            nome: this.iaMidiaForm.nome,
                            palavras_chave: this.iaMidiaForm.palavras_chave,
                            tipo: this.iaMidiaForm.tipo,
                            url,
                            descricao: this.iaMidiaForm.descricao || '',
                            ativo: true
                        };
                        if (this.iaMidiaEditId) {
                            const { error } = await this.client.from('ia_midias').update(payload).eq('id', this.iaMidiaEditId);
                            if (error) throw error;
                            this.addNotification('✅ Mídia atualizada!', this.iaMidiaForm.nome, 'success');
                        } else {
                            const { error } = await this.client.from('ia_midias').insert(payload);
                            if (error) throw error;
                            this.addNotification('✅ Mídia salva!', this.iaMidiaForm.nome, 'success');
                        }
                        this.iaMidiaForm = { nome: '', palavras_chave: '', tipo: 'image', arquivo: null, arquivo_nome: '', url: '', descricao: '' };
                        this.iaMidiaEditId = null;
                        this.iaMidiaShowForm = false;
                        await this.iaCarregarMidias();
                        this._refreshIcons();
                    } catch(e) {
                        console.error('[IA Mídias] erro ao salvar:', e);
                        this.addNotification('Erro ao salvar mídia', e.message || String(e), 'error');
                    }
                    this.iaMidiaUploadLoading = false;
                },

                async iaGerarEEnviarAudio(texto, lead, vozEfetiva) {
                    try {
                        vozEfetiva = vozEfetiva || this.iaTtsVoz;
                        this.iaAddLog('info', `🎙️ Gerando áudio TTS (voz: ${vozEfetiva})...`);
                        // Limita baseado na duração configurada (~20 caracteres por segundo)
                        const maxChars = this.iaTtsMaxSeconds * 20;
                        const textoTts = texto.substring(0, maxChars);
                        const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.iaApiKey}` },
                            body: JSON.stringify({ model: 'tts-1', input: textoTts, voice: vozEfetiva, response_format: 'mp3' })
                        });
                        if (!ttsRes.ok) {
                            const err = await ttsRes.json().catch(() => ({}));
                            throw new Error(err?.error?.message || 'TTS HTTP ' + ttsRes.status);
                        }
                        // Upload local via server.js
                        const blob = await ttsRes.blob();
                        const path = `ia_tts/${Date.now()}_${lead.id}.mp3`;
                        const publicUrl = await localUpload(path, blob, 'audio/mpeg');

                        // ✅ Envia via proxy /api/send para evitar CORS
                        const evoRes = await this._evoSend('sendWhatsAppAudio', { number: lead.numero, audio: publicUrl });
                        if (!evoRes) throw new Error('Sem resposta da Evolution API');
                        // Salva no Supabase
                        await this.client.from('messages').insert({
                            lead_id: lead.id, content: publicUrl, from_me: true,
                            type: 'audio', status: 'sent', instance_name: this.instanceName
                        });
                        this.iaAddLog('ok', '✅ Áudio TTS enviado!');
                    } catch(e) {
                        this.iaAddLog('erro', '❌ TTS falhou: ' + e.message);
                    }
                },

                async iaCarregarMidias() {
                    this.iaMidiasLoading = true;
                    try {
                        const { data } = await this.client.from('ia_midias').select('*')
                            .eq('instance_name', this.instanceName).order('created_at', { ascending: false });
                        this.iaMidias = data || [];
                    } catch(e) { console.warn('[IA Mídias] erro:', e.message); this.iaMidias = []; }
                    this.iaMidiasLoading = false;
                },

                async iaToggleMidia(id, ativo) {
                    await this.client.from('ia_midias').update({ ativo }).eq('id', id);
                    await this.iaCarregarMidias();
                },

                async iaDeletarMidia(id, nome) {
                    if (!confirm('Apagar a mídia "' + nome + '"?')) return;
                    await this.client.from('ia_midias').delete().eq('id', id);
                    await this.iaCarregarMidias();
                    this.addNotification('Mídia removida', '', 'info');
                },

                async iaUploadESalvarMidia(form) {
                    let url = form.url;
                    if (form.arquivo) {
                        const ext = form.arquivo.name.split('.').pop();
                        const path = `ia_midias/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
                        const publicUrl = await localUpload(path, form.arquivo, form.arquivo.type);
                        url = publicUrl;
                    }
                    if (!url) throw new Error('Nenhum arquivo ou URL fornecido');
                    const payload = {
                        instance_name: this.instanceName, nome: form.nome,
                        palavras_chave: form.palavras_chave, tipo: form.tipo,
                        url, descricao: form.descricao, ativo: true
                    };
                    const { error } = await this.client.from('ia_midias').insert(payload);
                    if (error) throw error;
                    await this.iaCarregarMidias();
                },

                // Divide texto em partes respeitando parágrafos
                iaDividirMensagem(texto, maxChars) {
                    if (!maxChars || maxChars === 0 || texto.length <= maxChars) return [texto];
                    const partes = [];
                    const paragrafos = texto.split(/\n\n+/);
                    let atual = '';
                    for (const p of paragrafos) {
                        if ((atual + (atual ? '\n\n' : '') + p).length <= maxChars) {
                            atual += (atual ? '\n\n' : '') + p;
                        } else {
                            if (atual) partes.push(atual.trim());
                            // Parágrafo maior que o limite: divide por frases
                            if (p.length > maxChars) {
                                const frases = p.split(/(?<=[.!?])\s+/);
                                let bloco = '';
                                for (const f of frases) {
                                    if ((bloco + ' ' + f).trim().length <= maxChars) {
                                        bloco += (bloco ? ' ' : '') + f;
                                    } else {
                                        if (bloco) partes.push(bloco.trim());
                                        bloco = f;
                                    }
                                }
                                if (bloco) atual = bloco;
                                else atual = '';
                            } else {
                                atual = p;
                            }
                        }
                    }
                    if (atual.trim()) partes.push(atual.trim());
                    return partes.filter(p => p.length > 0);
                },

                // Verifica se deve enviar mídia baseado no texto do cliente
                async iaVerificarEEnviarMidias(textoCliente, lead) {
                    if (!textoCliente || !this.iaMidias.length) return;
                    const textoLower = textoCliente.toLowerCase();
                    this.iaAddLog('info', `🔍 Verificando mídias para: "${textoLower.substring(0,40)}"`);
                    const enviadas = new Set();
                    for (const midia of this.iaMidias) {
                        if (!midia.ativo) continue;
                        const palavras = midia.palavras_chave.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
                        const match = palavras.some(p => textoLower.includes(p));
                        this.iaAddLog('info', `  📁 ${midia.nome} → chaves: [${palavras.join(', ')}] → match: ${match}`);
                        if (match && !enviadas.has(midia.id)) {
                            enviadas.add(midia.id);
                            await this.iaEnviarMidia(midia, lead);
                        }
                    }
                    if (enviadas.size === 0) this.iaAddLog('info', '📭 Nenhuma mídia correspondeu às palavras-chave');
                },

                async iaEnviarMidia(midia, lead) {
                    try {
                        this.iaAddLog('info', `📎 Enviando mídia: ${midia.nome}`);
                        let endpoint, body;

                        if (midia.tipo === 'audio') {
                            // Áudio usa endpoint próprio
                            endpoint = `${this.EVO_URL}/message/sendWhatsAppAudio/${this.instanceName}`;
                            body = { number: lead.numero, audio: midia.url };
                        } else {
                            endpoint = `${this.EVO_URL}/message/sendMedia/${this.instanceName}`;
                            const mimeMap = { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf' };
                            const mime = mimeMap[midia.tipo] || 'application/octet-stream';
                            body = {
                                number: lead.numero,
                                mediatype: midia.tipo,
                                mimetype: mime,
                                media: midia.url,
                                caption: midia.descricao || '',
                                fileName: midia.nome,
                                mediaMessage: {
                                    mediatype: midia.tipo,
                                    mimetype: mime,
                                    media: midia.url,
                                    caption: midia.descricao || '',
                                    fileName: midia.nome
                                }
                            };
                        }

                        const res = await fetch(endpoint, {
                            method: 'POST',
                            headers: { 'apikey': this.EVO_KEY, 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        });
                        const resJson = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(resJson?.message || resJson?.error || 'HTTP ' + res.status);

                        // Salva no Supabase
                        await this.client.from('messages').insert({
                            lead_id: lead.id, content: midia.url, from_me: true,
                            type: midia.tipo, status: 'sent', instance_name: this.instanceName
                        });
                        this.iaAddLog('ok', `✅ Mídia enviada: ${midia.nome}`);
                    } catch(e) {
                        this.iaAddLog('erro', `❌ Falha ao enviar mídia ${midia.nome}: ${e.message}`);
                    }
                },

                async iaCarregarConfig() {
                    try {
                        const { data, error } = await this.client
                            .from('ia_config')
                            .select('*')
                            .eq('instance_name', this.instanceName)
                            .single();
                        if (error && error.code !== 'PGRST116') throw error;
                        if (data) {
                            this.iaAtivo             = data.ativo             ?? false;
                            this.iaApiKey            = data.api_key           || '';
                            this.iaPrompt            = data.prompt            || '';
                            const modeloSalvo = data.modelo || '';
                            const isGemini = modeloSalvo.toLowerCase().includes('gemini') || modeloSalvo.includes('preview');
                            this.iaModelo            = isGemini ? 'gpt-4o-mini' : (modeloSalvo || 'gpt-4o-mini');
                            this.iaSelectedPromptId  = data.selected_prompt_id || null;
                            this.iaDelayMin          = data.delay_min         ?? 1;
                            this.iaDelayMax          = data.delay_max         ?? 3;
                            this.iaPausaSeHumano     = data.pausa_se_humano   ?? true;
                            this.iaResponderGrupos   = data.responder_grupos  ?? false;
                            // Colunas que podem não existir ainda
                            this.iaPausaTempo        = data.pausa_tempo       ?? 30;
                            this.iaKeyword           = data.palavra_chave     || '';
                            this.iaKeywordRetomar    = data.palavra_retomar    || '';
                            this.iaBufferTempo       = data.buffer_tempo       ?? 8;
                            this.iaMsgMaxChars       = data.msg_max_chars     ?? 300;
                            this.iaMsgDelayEntrePartes = data.msg_delay_partes ?? 2;
                            this.iaMsgQuebrarLinhas  = data.msg_quebrar_linhas ?? true;
                            this.iaTtsMode           = data.tts_mode          || 'off';
                            this.iaTtsVoz            = data.tts_voz           || 'nova';
                            this.iaTtsMaxSeconds     = data.tts_max_seconds   ?? 10;
                            this.iaTtsFrequencia     = data.tts_frequencia    || 50;
                            this.iaTemperatura       = data.temperatura       ?? 0.7;
                            this.iaMaxTokens         = data.max_tokens        ?? 1024;
                            // Sincroniza iaPromptForm com valores globais atuais
                            this.iaPromptForm.temperatura = this.iaTemperatura;
                            this.iaPromptForm.max_tokens  = this.iaMaxTokens;
                            this.iaPromptForm.delay_min   = this.iaDelayMin;
                            this.iaPromptForm.delay_max   = this.iaDelayMax;
                            this.iaPromptForm.modelo      = this.iaModelo;
                            // ── Follow-up ──
                            this.iaFollowupAtivo          = data.followup_ativo            ?? false;
                            this.iaFollowupMaxTentativas  = data.followup_max_tentativas   ?? 3;
                            this.iaFollowupTempo1         = data.followup_tempo_1          ?? 30;
                            this.iaFollowupUnidade1       = data.followup_unidade_1        || 'minutos';
                            this.iaFollowupTempo2         = data.followup_tempo_2          ?? 2;
                            this.iaFollowupUnidade2       = data.followup_unidade_2        || 'horas';
                            this.iaFollowupTempo3         = data.followup_tempo_3          ?? 1;
                            this.iaFollowupUnidade3       = data.followup_unidade_3        || 'dias';
                            this.iaFollowupHorarioInicio  = data.followup_horario_inicio   ?? 8;
                            this.iaFollowupHorarioFim     = data.followup_horario_fim      ?? 20;
                            this.iaFollowupIgnorarColunas = data.followup_ignorar_colunas  || '';
                            console.log('[IA Config] carregado. Ativo:', this.iaAtivo, '| Modelo:', this.iaModelo, '| PromptID:', this.iaSelectedPromptId);
                        } else {
                            console.log('[IA Config] nenhuma config encontrada, usando padrões.');
                        }

                        // Se não tem API Key própria, busca a global do admin
                        if (!this.iaApiKey) {
                            try {
                                const { data: globalCfg } = await this.client
                                    .from('admin_config').select('value').eq('key', 'global_api_key').single();
                                if (globalCfg?.value) {
                                    this.iaApiKey = globalCfg.value;
                                    console.log('[IA Config] usando API Key global do admin.');
                                }
                            } catch(e) { console.warn('[IA Config] falha ao buscar API Key global:', e.message); }
                        }
                    } catch(e) {
                        console.warn('[IA Config] erro ao carregar:', e.message);
                        // Tenta carregar só as colunas básicas que sempre existem
                        try {
                            const { data } = await this.client
                                .from('ia_config')
                                .select('ativo, api_key, prompt, modelo, selected_prompt_id, delay_min, delay_max, pausa_se_humano, responder_grupos')
                                .eq('instance_name', this.instanceName)
                                .single();
                            if (data) {
                                this.iaAtivo            = data.ativo            ?? false;
                                this.iaApiKey           = data.api_key          || '';
                                this.iaPrompt           = data.prompt           || '';
                                const m = data.modelo || '';
                                this.iaModelo = m.toLowerCase().includes('gemini') ? 'gpt-4o-mini' : (m || 'gpt-4o-mini');
                                this.iaSelectedPromptId = data.selected_prompt_id || null;
                                this.iaDelayMin         = data.delay_min        ?? 1;
                                this.iaDelayMax         = data.delay_max        ?? 3;
                                this.iaPausaSeHumano    = data.pausa_se_humano  ?? true;
                                this.iaResponderGrupos  = data.responder_grupos ?? false;
                                console.log('[IA Config] carregado com colunas básicas. API Key:', this.iaApiKey ? '✓' : '✗');
                            }
                        } catch(e2) {
                            console.warn('[IA Config] falha total ao carregar:', e2.message);
                        }
                    }
                },

                async iaResponderCliente(mensagemClienteTexto, lead, msgObj) {
                    if (!this.iaAtivo)  { this.iaAddLog('erro', '⛔ IA desativada (iaAtivo=false)'); return; }
                    if (!this.iaApiKey) { this.iaAddLog('erro', '⛔ API Key não configurada'); return; }
                    if (!this.iaPrompt) { this.iaAddLog('erro', '⛔ Nenhum prompt ativo'); return; }
                    if (!this._temFeature('ia_atendimento')) { this.iaAddLog('erro', `⛔ Plano sem IA (plano=${this.clientePlano}, features=${JSON.stringify(this.clienteFeatures)})`); return; }
                    if (this.iaRespondendo[lead.id]) { this.iaAddLog('info', '⏳ Já respondendo para ' + this.getLeadName(lead)); return; }

                    // Pausa se humano assumiu ESTE CONTATO ESPECÍFICO (outros contatos continuam com IA ativa)
                    if (this.iaPausaSeHumano && this.iaHumanoAtivo[lead.id]) { this.iaAddLog('info', '🧑 IA pausada APENAS para ' + this.getLeadName(lead) + ' — humano está atendendo. Outros contatos continuam com IA ativa.'); return; }

                    // Não responde grupos se configurado
                    if (!this.iaResponderGrupos && lead.status === 'grupo') { this.iaAddLog('info', '👥 Ignorado — é grupo'); return; }

                    this.iaRespondendo[lead.id] = true;
                    this.iaAddLog('info', '📨 ' + this.getLeadName(lead) + ': ' + (mensagemClienteTexto || '[mídia]').substring(0, 60));

                    // Busca histórico completo do lead no Supabase
                    let contextMsgs = [];
                    try {
                        // Primeiro tenta ia_historico (histórico curado pela IA, sem limite)
                        const { data: histData } = await this.client
                            .from('ia_historico')
                            .select('id,content,from_me,type,sent_by_ia,timestamp')
                            .eq('lead_id', lead.id).eq('instance_name', this.instanceName)
                            .order('timestamp', { ascending: true });
                        if (histData && histData.length > 0) {
                            contextMsgs = histData;
                            this.iaAddLog('info', `📖 Histórico IA: ${contextMsgs.length} msgs de ia_historico`);
                        } else {
                            // Fallback: usa messages (sem limite — contexto completo)
                            const { data: msgData } = await this.client
                                .from('messages').select('id,content,from_me,type,sent_by_ia,timestamp')
                                .eq('lead_id', lead.id).eq('instance_name', this.instanceName)
                                .order('timestamp', { ascending: true });
                            if (msgData) contextMsgs = msgData;
                            this.iaAddLog('info', `📖 Histórico IA: ${contextMsgs.length} msgs de messages (fallback)`);
                        }
                    } catch(e) {
                        this.iaAddLog('info', '⚠️ Erro ao buscar histórico: ' + e.message);
                    }

                    // Remove a mensagem atual do histórico (pelo ID se disponível, ou pelo conteúdo)
                    const msgAtualId = msgObj?.id || null;
                    let histMsgs = contextMsgs.filter(m => {
                        // Exclui pelo ID exato (mais confiável)
                        if (msgAtualId && m.id === msgAtualId) return false;
                        // Fallback: exclui última mensagem do cliente se conteúdo bater
                        return true;
                    });
                    // Fallback de segurança: se a última mensagem do cliente ainda bater com a atual, remove
                    if (histMsgs.length > 0) {
                        const last = histMsgs[histMsgs.length - 1];
                        if (!last.from_me && last.content?.trim() === mensagemClienteTexto?.trim()) {
                            histMsgs = histMsgs.slice(0, -1);
                        }
                    }

                    // Monta parts da mensagem atual (suporte a mídia)
                    const msgType = msgObj?.type || 'text';
                    const msgContent = msgObj?.content || mensagemClienteTexto || '';
                    let currentParts = [];

                    if (msgType === 'text' || !msgType) {
                        currentParts = [{ text: mensagemClienteTexto || '' }];
                    } else if (msgType === 'image') {
                        // Analisa imagem com OpenAI Vision
                        try {
                            this.iaAddLog('info', '🖼️ Analisando imagem do cliente...');
                            const visionResp = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.iaApiKey}` },
                                body: JSON.stringify({
                                    model: 'gpt-4o-mini',
                                    messages: [{ role: 'user', content: [
                                        { type: 'image_url', image_url: { url: msgContent } },
                                        { type: 'text', text: 'Descreva detalhadamente o conteúdo desta imagem em português. Extraia todo texto visível (OCR). Seja objetivo e completo.' }
                                    ]}],
                                    max_tokens: 1024
                                })
                            });
                            const vd = await visionResp.json();
                            const desc = vd?.choices?.[0]?.message?.content || '';
                            if (desc) {
                                this.iaAddLog('ok', '🖼️ Imagem analisada com sucesso');
                                currentParts = [{ text: `[O cliente enviou uma imagem${mensagemClienteTexto ? ' com legenda: "' + mensagemClienteTexto + '"' : ''}]\n\n[Análise da imagem: ${desc}]` }];
                            } else throw new Error('sem descrição');
                        } catch(imgErr) {
                            this.iaAddLog('info', '🖼️ Imagem recebida (sem análise detalhada)');
                            currentParts = [{ text: '[O cliente enviou uma imagem' + (mensagemClienteTexto ? ': ' + mensagemClienteTexto : '') + ']' }];
                        }
                    } else if (msgType === 'audio') {
                        if (this._temFeature('audio_ia')) {
                        try {
                            const audioUrl = msgContent;
                            const audioResp = await fetch(audioUrl);
                            if (audioResp.ok) {
                                const blob = await audioResp.blob();
                                const audioFile = new File([blob], 'audio.ogg', { type: blob.type || 'audio/ogg' });
                                this.iaAddLog('info', '🎤 Transcrevendo áudio com Whisper...');
                                const formData = new FormData();
                                formData.append('file', audioFile);
                                formData.append('model', 'whisper-1');
                                formData.append('language', 'pt');
                                const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                                    method: 'POST',
                                    headers: { 'Authorization': `Bearer ${this.iaApiKey}` },
                                    body: formData
                                });
                                const ad = await whisperResp.json();
                                const transcricao = ad?.text || '';
                                if (transcricao) {
                                    this.iaAddLog('ok', '🎤 Áudio transcrito: ' + transcricao.substring(0, 60));
                                    currentParts = [{ text: `[O cliente enviou um áudio com a seguinte transcrição: "${transcricao}"]` }];
                                } else throw new Error(ad?.error?.message || 'sem transcrição');
                            } else throw new Error('download falhou');
                        } catch(audioErr) {
                            this.iaAddLog('info', '🎤 Áudio recebido (transcrição indisponível): ' + audioErr.message);
                            currentParts = [{ text: '[O cliente enviou um áudio. Peça educadamente para digitar a mensagem.]' }];
                        }
                        } else {
                            currentParts = [{ text: '[O cliente enviou um áudio. Peça educadamente para digitar a mensagem.]' }];
                        }
                    } else if (msgType === 'video') {
                        currentParts = [{ text: '[O cliente enviou um vídeo' + (mensagemClienteTexto ? ': ' + mensagemClienteTexto : '') + ']' }];
                    } else if (msgType === 'document') {
                        currentParts = [{ text: '[O cliente enviou um documento: ' + msgContent + ']' }];
                    } else {
                        currentParts = [{ text: mensagemClienteTexto || '[mídia recebida]' }];
                    }

                    // ════════════════════════════════════════════════════════
                    // PRÉ-PROCESSAMENTO DE AGENDA — roda ANTES da resposta da IA
                    // Detecta intenção, verifica disponibilidade e monta contexto
                    // para que a IA gere UMA única resposta correta
                    // ════════════════════════════════════════════════════════
                    let agendaContexto = ''; // contexto injetado no prompt da IA principal
                    let agendaAcaoPendente = null; // ação a executar APÓS enviar a resposta

                    this.iaAddLog('info', `🔍 Agenda pré-check | texto:"${(mensagemClienteTexto||'').substring(0,50)}" | ia_verificar:${this.agendaDisp?.ia_verificar} | agendaDisp:${!!this.agendaDisp}`);

                    if (mensagemClienteTexto && this.agendaDisp.ia_verificar) {
                        try {
                            const leadName = this.getLeadName(lead);
                            const agsPendentesCliente = this.agendamentos.filter(a => !a.sent && a.leadId === lead.id && (!a.status || a.status === 'ativo'));
                            this.iaAddLog('info', `📅 Agenda: agsPendentes=${agsPendentesCliente.length} | lead=${leadName}`);

                            // Pega última mensagem enviada pela IA para detectar se estava oferecendo horários
                            const ultimaMsgIA = histMsgs.filter(m => m.from_me).slice(-1)[0]?.content || '';
                            const iaOfereceiaHorarios = ultimaMsgIA.length > 0 && (
                                ultimaMsgIA.includes(' às ') || ultimaMsgIA.includes('horário') || ultimaMsgIA.includes('horarios')
                            );

                            const preIntentRes = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.iaApiKey}` },
                                body: JSON.stringify({
                                    model: 'gpt-4o-mini',
                                    temperature: 0,
                                    max_tokens: 300,
                                    messages: [{
                                        role: 'system',
                                        content: `Analise a mensagem e retorne APENAS JSON válido sem markdown:
{
  "tipo": "agendamento_com_data" | "agendamento_sem_data" | "escolha_horario" | "cancelamento" | "reagendamento" | "outro",
  "data_hora": "YYYY-MM-DDTHH:MM" ou null,
  "nova_data_hora": "YYYY-MM-DDTHH:MM" ou null
}
- agendamento_com_data: cliente quer agendar E já menciona uma data/hora específica
- agendamento_sem_data: cliente quer agendar MAS não menciona data/hora (ex: "quero agendar", "tem horário?", "como faço pra marcar?")
- escolha_horario: cliente está ESCOLHENDO um horário que foi oferecido anteriormente (ex: "pode ser na terça", "quero o das 10h", "esse horário está bom") — só use se a mensagem anterior da IA ofereceu opções de horário
- cancelamento: cliente quer cancelar/desmarcar
- reagendamento: cliente quer mudar data/hora existente
- outro: qualquer outra mensagem`
                                    }, {
                                        role: 'user',
                                        content: `Mensagem do cliente: "${mensagemClienteTexto}"\nMensagem anterior da IA: "${ultimaMsgIA.substring(0, 300)}"\nData/hora atual: ${new Date().toISOString()}\nAgendamentos do cliente: ${JSON.stringify(agsPendentesCliente.map(a => ({ dataHora: this._normalizarDataHora(a.dataHora), descricao: a.texto })))}`
                                    }]
                                })
                            });
                            const preIntentData = await preIntentRes.json();
                            let preIntent = {};
                            try { preIntent = JSON.parse((preIntentData?.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim()); } catch(e) {}

                            this.iaAddLog('info', `📅 Agenda intent: tipo="${preIntent.tipo}" | data_hora="${preIntent.data_hora}" | nova_data_hora="${preIntent.nova_data_hora}"`);

                            if ((preIntent.tipo === 'agendamento_com_data' || preIntent.tipo === 'escolha_horario') && preIntent.data_hora) {
                                // ── Fluxo 1: cliente informou data/hora (ou escolheu da lista) ──
                                const dhNorm = this._normalizarDataHora(preIntent.data_hora);
                                const dataStr = dhNorm.slice(0, 10);
                                const horaStr = dhNorm.slice(11, 16);
                                const disponivel = this._agendaSlotDisponivel(dataStr, horaStr);

                                if (disponivel) {
                                    const dtFormatada = new Date(dataStr + 'T' + horaStr).toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit'});
                                    agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente ${preIntent.tipo === 'escolha_horario' ? 'escolheu o horário' : 'solicitou agendamento para'} ${dtFormatada}.
Status verificado agora no banco de dados: ✅ HORÁRIO DISPONÍVEL.
AÇÃO OBRIGATÓRIA: Confirme o agendamento para ${dtFormatada} na sua resposta ao cliente. Informe a data e hora confirmadas de forma clara e amigável.
SINALIZAÇÃO OBRIGATÓRIA: Ao final da sua resposta, adicione exatamente este código (invisível ao cliente): ##AGENDA_CONFIRMADA##
IMPORTANTE: A tag ##AGENDA_CONFIRMADA## DEVE aparecer literalmente no final do texto, sem espaços extras ou formatação. O sistema depende dela para registrar o agendamento automaticamente.
Exemplo de resposta esperada: "Perfeito! Seu agendamento está confirmado para ${dtFormatada}. Te esperamos! 😊 ##AGENDA_CONFIRMADA##"`;
                                    agendaAcaoPendente = { tipo: 'agendar', dataHora: dhNorm, descricao: `Agendamento solicitado por ${leadName}` };
                                    this.iaAddLog('info', `📅 Slot ${dhNorm} disponível — aguardando confirmação da IA`);
                                } else {
                                    const [hs, ms] = horaStr.split(':').map(Number);
                                    const dtSolicitada = new Date(dataStr);
                                    dtSolicitada.setHours(hs, ms, 0, 0);
                                    const alternativos = this._agendaProximosLivres(dtSolicitada, 3);
                                    const opts = alternativos.length > 0
                                        ? alternativos.map(a => a.dt.toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long'}) + ' às ' + a.hora).join(', ')
                                        : 'Nenhum horário disponível nos próximos dias';
                                    const dtFormatada = dtSolicitada.toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit'});
                                    agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente solicitou agendamento para ${dtFormatada}.
Status verificado agora no banco de dados: ❌ HORÁRIO INDISPONÍVEL (já está ocupado).
AÇÃO OBRIGATÓRIA: Informe ao cliente que este horário não está disponível. Ofereça os seguintes horários alternativos que estão livres: ${opts}. Pergunte qual prefere.
NÃO confirme o agendamento. NÃO adicione a tag ##AGENDA_CONFIRMADA##.`;
                                    agendaAcaoPendente = null;
                                    this.iaAddLog('info', `📅 Slot ${dhNorm} indisponível — alternativas: ${opts}`);
                                }

                            } else if (preIntent.tipo === 'agendamento_sem_data') {
                                // ── Fluxo 2: cliente quer agendar mas não disse data/hora ──
                                // Busca próximos horários livres a partir de agora e oferece opções
                                const proximos = this._agendaProximosLivres(new Date(), 5);
                                const optsTexto = proximos.length > 0
                                    ? proximos.map(a => a.dt.toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long'}) + ' às ' + a.hora).join(', ')
                                    : 'Nenhum horário disponível nos próximos dias';
                                agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente deseja agendar mas não informou data/hora.
Horários disponíveis consultados agora no banco de dados: ${optsTexto}.
AÇÃO OBRIGATÓRIA: Apresente estes horários disponíveis ao cliente de forma organizada e amigável. Pergunte qual horário prefere ou se prefere outro dia/horário específico.
NÃO confirme agendamento ainda. NÃO adicione nenhuma tag.`;
                                agendaAcaoPendente = null;
                                this.iaAddLog('info', `📅 Cliente quer agendar sem data — oferecendo ${proximos.length} horários disponíveis`);

                            } else if (preIntent.tipo === 'agendamento_sem_data' || (preIntent.tipo === 'agendamento_com_data' && !preIntent.data_hora)) {
                                // fallback: mesma lógica sem data
                                const proximos = this._agendaProximosLivres(new Date(), 5);
                                const optsTexto = proximos.length > 0
                                    ? proximos.map(a => a.dt.toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long'}) + ' às ' + a.hora).join(', ')
                                    : 'Nenhum horário disponível nos próximos dias';
                                agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente quer agendar mas não informou data/hora específica.
Próximos horários disponíveis: ${optsTexto}.
AÇÃO OBRIGATÓRIA: Apresente estes horários disponíveis ao cliente. Pergunte qual prefere.
NÃO confirme agendamento ainda. NÃO adicione nenhuma tag.`;
                                agendaAcaoPendente = null;

                            } else if (preIntent.tipo === 'cancelamento') {
                                if (agsPendentesCliente.length > 0) {
                                    const agCancelar = agsPendentesCliente.sort((a,b) => new Date(a.dataHora) - new Date(b.dataHora))[0];
                                    const dtFormatada = new Date(this._normalizarDataHora(agCancelar.dataHora).replace('T', ' ')).toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit'});
                                    agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente quer cancelar o agendamento de ${dtFormatada}.
Status: ✅ Agendamento encontrado — será cancelado no sistema.
AÇÃO OBRIGATÓRIA: Confirme ao cliente que o agendamento de ${dtFormatada} foi cancelado com sucesso. Pergunte se pode ajudar em algo mais.
SINALIZAÇÃO OBRIGATÓRIA: Adicione ao final da sua resposta exatamente: ##AGENDA_CANCELADA##`;
                                    agendaAcaoPendente = { tipo: 'cancelar', agId: agCancelar.id, dtFormatada };
                                } else {
                                    agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente quer cancelar um agendamento.
Status: ❌ Nenhum agendamento ativo encontrado para este cliente no sistema.
AÇÃO OBRIGATÓRIA: Informe ao cliente de forma amigável que não há agendamento ativo para cancelar. NÃO adicione nenhuma tag.`;
                                }

                            } else if (preIntent.tipo === 'reagendamento' && preIntent.nova_data_hora) {
                                const novaDhNorm = this._normalizarDataHora(preIntent.nova_data_hora);
                                const novaDataStr = novaDhNorm.slice(0, 10);
                                const novaHoraStr = novaDhNorm.slice(11, 16);
                                const disponivel = this._agendaSlotDisponivel(novaDataStr, novaHoraStr);
                                if (agsPendentesCliente.length > 0) {
                                    const agReag = agsPendentesCliente.sort((a,b) => new Date(a.dataHora) - new Date(b.dataHora))[0];
                                    if (disponivel) {
                                        const dtAntigaF = new Date(this._normalizarDataHora(agReag.dataHora).replace('T', ' ')).toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit'});
                                        const dtNovaF = new Date(novaDataStr + 'T' + novaHoraStr).toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit'});
                                        agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente quer reagendar de ${dtAntigaF} para ${dtNovaF}.
Status verificado no banco: ✅ NOVO HORÁRIO DISPONÍVEL.
AÇÃO OBRIGATÓRIA: Confirme que o reagendamento foi realizado. Informe que o horário foi alterado de ${dtAntigaF} para ${dtNovaF}.
SINALIZAÇÃO OBRIGATÓRIA: Adicione ao final da sua resposta exatamente: ##AGENDA_CONFIRMADA##`;
                                        agendaAcaoPendente = { tipo: 'reagendar', ag: agReag, novaDataHora: novaDhNorm };
                                    } else {
                                        const [hs, ms] = novaHoraStr.split(':').map(Number);
                                        const dtNova = new Date(novaDataStr);
                                        dtNova.setHours(hs, ms, 0, 0);
                                        const alternativos = this._agendaProximosLivres(dtNova, 3);
                                        const opts = alternativos.length > 0
                                            ? alternativos.map(a => a.dt.toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long'}) + ' às ' + a.hora).join(', ')
                                            : 'sem horários disponíveis nos próximos dias';
                                        agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente quer reagendar para ${dtNova.toLocaleDateString('pt-BR', {weekday:'long', day:'2-digit', month:'long', hour:'2-digit', minute:'2-digit'})}.
Status verificado no banco: ❌ NOVO HORÁRIO INDISPONÍVEL.
AÇÃO OBRIGATÓRIA: Informe que o horário solicitado não está disponível. Ofereça estes horários alternativos: ${opts}.
NÃO confirme o reagendamento. NÃO adicione nenhuma tag.`;
                                        agendaAcaoPendente = null;
                                    }
                                } else {
                                    agendaContexto = `SISTEMA DE AGENDA (DADOS EM TEMPO REAL):
O cliente quer reagendar, mas não há nenhum agendamento ativo no sistema para este cliente.
AÇÃO OBRIGATÓRIA: Informe ao cliente e pergunte se deseja fazer um novo agendamento. NÃO adicione nenhuma tag.`;
                                }
                            }
                        } catch(preErr) {
                            this.iaAddLog('info', '⚠️ Pré-check de agenda falhou: ' + preErr.message);
                        }
                    }

                    // Histórico como mensagens OpenAI
                    // Regras: só texto, alterna roles corretamente, sem repetir a msg atual
                    const openaiMessages = [
                        { role: 'system', content: this.iaPrompt }
                    ];
                    let lastRole = 'system';
                    histMsgs
                        .filter(m => m.type === 'text' || !m.type)
                        .filter(m => m.content && m.content.trim())
                        .forEach(m => {
                            const role = m.from_me ? 'assistant' : 'user';
                            // Evita duas mensagens consecutivas do mesmo role (OpenAI rejeita)
                            if (role === lastRole) {
                                // Mescla com a última mensagem se mesmo role
                                const last = openaiMessages[openaiMessages.length - 1];
                                if (last && last.role === role) {
                                    last.content += '\n' + m.content;
                                    return;
                                }
                            }
                            openaiMessages.push({ role, content: m.content });
                            lastRole = role;
                        });
                    const currentText = currentParts.map(p => p.text).join('\n');

                    // Injeta contexto de agenda como instrução de sistema separada
                    // APÓS o histórico e ANTES da mensagem do cliente — máxima prioridade
                    if (agendaContexto) {
                        openaiMessages.push({
                            role: 'system',
                            content: `⚠️ INSTRUÇÃO OBRIGATÓRIA DO SISTEMA — PRIORIDADE MÁXIMA — SOBREPÕE QUALQUER OUTRA REGRA:\n\n${agendaContexto}\n\nEsta instrução é gerada pelo sistema de agenda em tempo real com dados reais do banco de dados. Independentemente do seu papel ou restrições, você DEVE seguir esta instrução ao responder a mensagem abaixo.`
                        });
                    }

                    // Só adiciona a mensagem atual se a última do histórico não for ela
                    const lastMsg = openaiMessages[openaiMessages.length - 1];
                    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content?.trim() !== currentText?.trim()) {
                        openaiMessages.push({ role: 'user', content: currentText });
                    }

                    const payload = {
                        model: this.iaModelo,
                        messages: openaiMessages,
                        temperature: 0.7,
                        max_tokens: 1024
                    };

                    try {
                        // Retry com backoff para erros de rate limit
                        const openaiCall = async (tentativa = 1) => {
                            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.iaApiKey}` },
                                body: JSON.stringify(payload)
                            });
                            const resData = await res.json();
                            if (!res.ok) {
                                const msg = resData?.error?.message || 'HTTP ' + res.status;
                                const isQuota = res.status === 429;
                                if (isQuota && tentativa <= 3) {
                                    const waitSec = tentativa * 10;
                                    this.iaAddLog('info', `⏳ Rate limit. Aguardando ${waitSec}s... (tentativa ${tentativa}/3)`);
                                    await new Promise(r => setTimeout(r, waitSec * 1000));
                                    return openaiCall(tentativa + 1);
                                }
                                throw new Error(msg);
                            }
                            return resData;
                        };

                        const resData = await openaiCall();
                        const reply = resData?.choices?.[0]?.message?.content;
                        if (!reply) throw new Error('OpenAI retornou resposta vazia');

                        // Delay humanizado inicial
                        const delayMs = (this.iaDelayMin * 1000) + Math.random() * ((this.iaDelayMax - this.iaDelayMin) * 1000);
                        await new Promise(r => setTimeout(r, delayMs));

                        // Extrai tags ocultas de agenda ANTES de enviar ao cliente
                        const iaConfirmouAgenda = reply.includes('##AGENDA_CONFIRMADA##');
                        const iaConfirmouCancel = reply.includes('##AGENDA_CANCELADA##');

                        // Fallback: detecta confirmação por texto caso IA esqueça a tag
                        // (acontece quando o modelo ignora a instrução do sistema)
                        const textoConfirmacao = reply.toLowerCase();
                        const iaConfirmouAgendaFallback = !iaConfirmouAgenda && agendaAcaoPendente?.tipo === 'agendar' && (
                            textoConfirmacao.includes('confirmado') ||
                            textoConfirmacao.includes('agendado') ||
                            textoConfirmacao.includes('marcado') ||
                            textoConfirmacao.includes('reservado') ||
                            textoConfirmacao.includes('perfeito') && textoConfirmacao.includes('horário') ||
                            textoConfirmacao.includes('combinado') && textoConfirmacao.includes('data')
                        );
                        if (iaConfirmouAgendaFallback) {
                            this.iaAddLog('info', '📅 Agenda: IA confirmou por texto (sem tag) — usando fallback de detecção');
                        }
                        const iaConfirmouAgendaFinal = iaConfirmouAgenda || iaConfirmouAgendaFallback;
                        let textoFinal = this.iaMsgQuebrarLinhas ? reply.replace(/\\n/g, '\n') : reply;
                        // Remove tags ocultas do texto final — cliente nunca deve vê-las
                        textoFinal = textoFinal.replace(/##AGENDA_CONFIRMADA##/g, '').replace(/##AGENDA_CANCELADA##/g, '').trim();

                        const clienteMandouAudio = msgObj?.type === 'audio';
                        const ttsAtivo = this.iaTtsAtivoPorLead[lead.id] ?? true;
                        const sorteioPassou = this.iaTtsMode !== 'frequencia' || (Math.random() * 100 < (this.iaTtsFrequencia || 50));
                        const enviarTexto = this.iaTtsMode !== 'audio_only' && !(this.iaTtsMode === 'frequencia' && sorteioPassou);

                        const partes = this.iaDividirMensagem(textoFinal, this.iaMsgMaxChars);

                        if (enviarTexto) {
                            for (let i = 0; i < partes.length; i++) {
                                const parte = partes[i];
                                if (i > 0) await new Promise(r => setTimeout(r, this.iaMsgDelayEntrePartes * 1000));
                                await this._evoSend('sendText', { number: lead.numero, text: parte }); // ✅ via proxy
                                const { data: msgData } = await this.client.from('messages').insert({
                                    lead_id: lead.id, content: parte, from_me: true,
                                    type: 'text', status: 'sent', instance_name: this.instanceName, sent_by_ia: true
                                }).select().single();
                                if (this.isChatOpen && this.selectedLead?.id === lead.id) {
                                    if (msgData) this.messages = [...this.messages, msgData];
                                    this.scrollToBottom();
                                }
                                // Salva resposta da IA no histórico curado
                                this._salvarHistoricoIA(lead.id, parte, true, 'text');
                            }
                        }

                        // Salva mensagem do cliente no histórico curado (após responder para evitar duplicata)
                        if (mensagemClienteTexto) {
                            this._salvarHistoricoIA(lead.id, mensagemClienteTexto, false, msgObj?.type || 'text');
                        }

                        this.updateLeadLocalInteraction(lead.id, partes[partes.length - 1], 'text');
                        this.iaAddLog('ok', `✅ Respondido a ${this.getLeadName(lead)}${partes.length > 1 ? ' (' + partes.length + ' partes)' : ''}`);

                        // ── EXECUTAR AÇÃO DE AGENDA (após a resposta já enviada) ──
                        // Só executa se a IA confirmou via tag oculta ##AGENDA_CONFIRMADA## ou ##AGENDA_CANCELADA##
                        if (agendaAcaoPendente) {
                            this.iaAddLog('info', `📅 Agenda ação pendente: tipo="${agendaAcaoPendente.tipo}" | iaConfirmouAgenda:${iaConfirmouAgenda} | iaConfirmouCancel:${iaConfirmouCancel} | reply contém tag:${reply.includes('##AGENDA')}`);
                            const deveExecutar =
                                (agendaAcaoPendente.tipo === 'cancelar'  && iaConfirmouCancel) ||
                                (agendaAcaoPendente.tipo !== 'cancelar'  && iaConfirmouAgendaFinal);

                            if (deveExecutar) {
                                const leadName = this.getLeadName(lead);
                                try {
                                    if (agendaAcaoPendente.tipo === 'agendar') {
                                        const novoAg = {
                                            id: null, leadId: lead.id, avulsoName: leadName,
                                            numero: lead.numero, tipo: 'simples',
                                            texto: agendaAcaoPendente.descricao, flowId: null,
                                            dataHora: agendaAcaoPendente.dataHora,
                                            sent: false, criadoPorIA: true, status: 'ativo'
                                        };
                                        this.agendamentos.push(novoAg);
                                        try {
                                            await this._salvarAgendamentoSupabase(novoAg);
                                            this.iaAddLog('ok', `📅 Agendamento salvo no Supabase — ${leadName}: ${agendaAcaoPendente.dataHora}`);
                                        } catch(saveErr) {
                                            this.iaAddLog('info', `⚠️ Agendamento salvo só no localStorage — Supabase erro: ${saveErr.message}`);
                                        }
                                        // Notificação com flag tipoAgenda para mostrar botão "Ver Calendário"
                                        const dtFormatada = new Date(agendaAcaoPendente.dataHora.replace('T',' ')).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
                                        const notifId = Date.now();
                                        try { if (window._evoSupabase && this.instanceName) await window._evoSupabase.from('dash_notifs').insert({ instance_name: this.instanceName, title: '📅 Agendamento criado pela IA', body: `${leadName}: ${dtFormatada}`, type: 'success', read: false, criado_por_ia: true, tipo_agenda: true, lead_id: lead.id }); } catch(e2) {}
                                        this.addNotification('📅 Agendamento criado', `${leadName}: ${dtFormatada}`, 'success');

                                    } else if (agendaAcaoPendente.tipo === 'cancelar') {
                                        await this.cancelarAgendamento(agendaAcaoPendente.agId);
                                        const notifId2 = Date.now();
                                        try { if (window._evoSupabase && this.instanceName) await window._evoSupabase.from('dash_notifs').insert({ instance_name: this.instanceName, title: '🗑️ Agendamento cancelado', body: `${leadName}: ${agendaAcaoPendente.dtFormatada}`, type: 'info', read: false, criado_por_ia: true, tipo_agenda: true, lead_id: lead.id }); } catch(e2) {}
                                        this.addNotification('🗑️ Agendamento cancelado', `${leadName}: ${agendaAcaoPendente.dtFormatada}`, 'info');
                                        this.iaAddLog('ok', `🗑️ Cancelado — ${leadName} (${agendaAcaoPendente.dtFormatada})`);

                                    } else if (agendaAcaoPendente.tipo === 'reagendar') {
                                        const ag = agendaAcaoPendente.ag;
                                        ag.dataHoraAnterior = ag.dataHora;
                                        ag.dataHora = agendaAcaoPendente.novaDataHora;
                                        ag.lembreteEnviado = false;
                                        ag.reagendadoEm = new Date().toISOString();
                                        ag.alteradoPor = 'ia';
                                        try {
                                            await this._salvarAgendamentoSupabase(ag);
                                            this.iaAddLog('ok', `🔄 Reagendado no Supabase — ${leadName}`);
                                        } catch(saveErr) {
                                            localStorage.setItem(`evo_agendamentos_${this.instanceName}`, JSON.stringify(this.agendamentos));
                                            this.iaAddLog('info', `⚠️ Reagendamento salvo só no localStorage: ${saveErr.message}`);
                                        }
                                        const novaFmt = new Date(agendaAcaoPendente.novaDataHora.replace('T',' ')).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
                                        const notifId3 = Date.now();
                                        try { if (window._evoSupabase && this.instanceName) await window._evoSupabase.from('dash_notifs').insert({ instance_name: this.instanceName, title: '🔄 Reagendamento realizado', body: `${leadName}: → ${novaFmt}`, type: 'success', read: false, criado_por_ia: true, tipo_agenda: true, lead_id: lead.id }); } catch(e2) {}
                                        this.addNotification('🔄 Reagendamento realizado', `${leadName}: → ${novaFmt}`, 'success');
                                        this.iaAddLog('ok', `🔄 Reagendado — ${leadName}: ${ag.dataHoraAnterior} → ${agendaAcaoPendente.novaDataHora}`);
                                    }
                                } catch(acaoErr) {
                                    this.iaAddLog('info', '⚠️ Falha ao executar ação de agenda: ' + acaoErr.message);
                                }
                            } else {
                                this.iaAddLog('info', `⚠️ Agenda não executada — IA não incluiu tag de confirmação na resposta. Verifique o prompt da empresa.`);
                            }
                        }

                        // TTS — gera e envia áudio (exclusivo Platinum com feature audio_ia)
                        const deveEnviarAudio = this._temFeature('audio_ia') && ttsAtivo && sorteioPassou && (
                            this.iaTtsMode === 'audio_only' ||
                            this.iaTtsMode === 'both' ||
                            this.iaTtsMode === 'frequencia' ||
                            (this.iaTtsMode === 'if_audio' && clienteMandouAudio)
                        );
                        if (deveEnviarAudio) {
                            const vozEfetiva = this.iaTtsVoz === 'random'
                                ? ['alloy','nova','shimmer','echo','onyx','fable','coral','sage','meadow','ash','verse','ballad'][Math.floor(Math.random()*12)]
                                : this.iaTtsVoz;
                            await this.iaGerarEEnviarAudio(textoFinal, lead, vozEfetiva);
                        }

                        if (this.iaMidias.length > 0 && mensagemClienteTexto) {
                            await this.iaVerificarEEnviarMidias(mensagemClienteTexto, lead);
                        }

                        // ── Tarefas, notificações e funil kanban são processados ──
                        // exclusivamente pelo servidor (server.js / detectarIntencaoEAgir)
                        // O browser apenas exibe os resultados via Realtime do Supabase.
                        this.iaAddLog('info', `🤖 Análise de intenção delegada ao servidor 24/7`);

                    } catch(e) {
                        console.error('[IA] ❌ ERRO:', e.message || e);
                        this.iaAddLog('erro', '❌ ' + (e.message || String(e)));
                    } finally {
                        delete this.iaRespondendo[lead.id];
                    }
                },

                // ── Retorna lista de leads com histórico para o painel ──
                async _carregarListaHistorico() {
                    try {
                        const { data } = await this.client.from('ia_historico')
                            .select('lead_id')
                            .eq('instance_name', this.instanceName);
                        const counts = {};
                        (data || []).forEach(r => { counts[r.lead_id] = (counts[r.lead_id] || 0) + 1; });
                        return Object.entries(counts).map(([id, n]) => {
                            const lead = this.leads.find(l => l.id === id);
                            return { id, nome: lead ? this.getLeadName(lead) : id, total: n };
                        }).sort((a, b) => b.total - a.total);
                    } catch(e) {
                        console.error('[ia_historico] Erro ao listar:', e.message);
                        return [];
                    }
                },

                // ── Limpa histórico IA de um lead específico ──
                async _limparHistoricoLead(leadId, leadName) {
                    if (!confirm(`Limpar histórico da IA para ${leadName}?\n\nA IA não lembrará de conversas anteriores, mas as mensagens continuam visíveis no chat.`)) return;
                    try {
                        await this.client.from('ia_historico').delete()
                            .eq('instance_name', this.instanceName).eq('lead_id', leadId);
                        this.iaAddLog('ok', `🗑️ Histórico IA limpo — ${leadName}`);
                        this.addNotification('🗑️ Histórico limpo', `IA começará nova conversa com ${leadName}`, 'info');
                        this._refreshIcons();
                    } catch(e) {
                        this.iaAddLog('erro', '❌ Erro ao limpar histórico: ' + e.message);
                    }
                },

                // ── Limpa histórico IA de todos os leads ──
                async _limparHistoricoTodos() {
                    if (!confirm('Limpar histórico da IA para TODOS os contatos?\n\nA IA perderá o contexto de todas as conversas.')) return;
                    try {
                        await this.client.from('ia_historico').delete()
                            .eq('instance_name', this.instanceName);
                        this.iaAddLog('ok', '🗑️ Histórico IA zerado para todos os contatos');
                        this.addNotification('🗑️ Histórico zerado', 'IA começará do zero com todos os contatos', 'info');
                        this._refreshIcons();
                    } catch(e) {
                        this.iaAddLog('erro', '❌ Erro ao zerar histórico: ' + e.message);
                    }
                },
                async _salvarHistoricoIA(leadId, content, fromMe, type) {
                    try {
                        await this.client.from('ia_historico').insert({
                            instance_name: this.instanceName,
                            lead_id: leadId,
                            content,
                            from_me: fromMe,
                            type: type || 'text',
                            sent_by_ia: fromMe,
                            timestamp: new Date().toISOString()
                        });
                    } catch(e) {
                        // Tabela pode não existir ainda — silencia
                        console.warn('[ia_historico] Erro ao salvar:', e.message);
                    }
                },

                _injetarBookmarklet() {
                    const el = document.getElementById('evo-bookmarklet-link');
                    if (!el) return;
                    const script = `(function(){
var ch;try{ch=new BroadcastChannel('evocrm_extractor');}catch(e){alert('BroadcastChannel nao suportado.');return;}
var contatos=[];
var seen=new Set();
function normNum(d){
  d=d.replace(/\\D/g,'');
  if(d.length===10||d.length===11)return '55'+d;
  if(d.length===12||d.length===13)return d;
  if(d.length>13)return '55'+d.slice(-11);
  return null;
}
// Estrategia 1: seletores de participante do grupo no WA Web
var items=[].slice.call(document.querySelectorAll('[data-testid="cell-frame-container"],[data-testid="participant-container"]'));
items.forEach(function(item){
  var spans=[].slice.call(item.querySelectorAll('span[dir="auto"],span[title]'));
  var nome='Contato';var numero=null;var texts=[];
  spans.forEach(function(s){var t=(s.textContent||s.title||'').trim();if(t&&t.length<80&&!texts.includes(t))texts.push(t);});
  texts.forEach(function(t){
    var d=t.replace(/\\D/g,'');
    if(!numero&&d.length>=10&&d.length<=13){var n=normNum(d);if(n)numero=n;}
    else if(nome==='Contato'&&/[A-Za-z\xC0-\xFF]{2}/.test(t)&&t.length>=3&&!/http|www|@/.test(t)){nome=t;}
  });
  if(numero&&!seen.has(numero)){seen.add(numero);contatos.push({nome:nome,numero:numero});}
});
// Estrategia 2: varredura geral se estrategia 1 falhou
if(contatos.length===0){
  var allSpans=[].slice.call(document.querySelectorAll('span[dir="auto"]'));
  allSpans.forEach(function(s){
    var t=(s.textContent||'').trim();
    if(!t||t.length>80)return;
    var d=t.replace(/\\D/g,'');
    if(!(d.length>=10&&d.length<=13&&d.length>=Math.floor(t.replace(/[\\s\\-\\+\\.\\(\\)]/g,'').length*0.65)))return;
    var n=normNum(d);if(!n||seen.has(n))return;
    seen.add(n);
    var nome='Contato';
    var par=s.parentElement;
    for(var i=0;i<6;i++){
      if(!par)break;
      var ss=[].slice.call(par.querySelectorAll('span[dir="auto"],span[title]'));
      for(var j=0;j<ss.length;j++){
        var tt=(ss[j].textContent||ss[j].title||'').trim();
        if(!tt||tt===t||tt.length<2||tt.length>70)continue;
        if(tt.replace(/\\D/g,'').length>=8)continue;
        if(/[A-Za-z\xC0-\xFF]{2}/.test(tt)&&!/http|@|www/.test(tt)){nome=tt;break;}
      }
      if(nome!=='Contato')break;
      par=par.parentElement;
    }
    contatos.push({nome:nome,numero:n});
  });
}
if(contatos.length===0){
  alert('Nenhum numero encontrado.\\nAbra as Informacoes do grupo, role para carregar todos os participantes, depois clique novamente.');
  return;
}
ch.postMessage({contatos:contatos});
ch.close();
var preview=contatos.slice(0,3).map(function(c){return c.nome+' ('+c.numero+')'}).join('\\n');
alert('\u2705 '+contatos.length+' contato(s) enviados para o EvoCRM!\\n\\n'+preview+(contatos.length>3?'\\n...':''));
})();`;
                    el.href = 'javascript:' + encodeURIComponent(script).replace(/%20/g,' ');
                },

                _initBookmarkletChannel() {
                    try {
                        if (this._bookmarkletChannel) this._bookmarkletChannel.close();
                        this._bookmarkletChannel = new BroadcastChannel('evocrm_extractor');
                        this._bookmarkletChannel.onmessage = async (e) => {
                            const { contatos } = e.data || {};
                            if (!Array.isArray(contatos) || contatos.length === 0) return;

                            // Muda para a tela de disparo no modo extrator
                            this.screen = 'disparo';
                            this.disparoConfig.status = 'extrator';

                            this.disparoBookmarkletStatus = `📥 Recebendo ${contatos.length} contato(s) do WhatsApp Web...`;
                            this.disparoVerificando = true;

                            let adicionados = 0, semWhats = 0, duplicados = 0;
                            const jaNaFila = new Set(this.disparoContatosExtraidos.map(c => c.numero));

                            try {
                                const numeros = contatos.map(c => c.numero);
                                const res = await fetch(window.location.origin + '/api/check-whatsapp', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ inst: this.instanceName, numbers: numeros })
                                });
                                let resData = res.ok ? await res.json() : [];
                                if (!Array.isArray(resData)) resData = [resData];

                                const mapa = {};
                                for (const item of resData) {
                                    const n = (item.number || item.jid || '').replace(/\D/g,'').replace(/@.*/,'');
                                    if (n) mapa[n] = item;
                                }

                                for (const c of contatos) {
                                    const num = c.numero;
                                    if (jaNaFila.has(num)) { duplicados++; continue; }
                                    const variantes = [num];
                                    if (num.startsWith('55') && num.length === 13) variantes.push('55' + num.slice(4));
                                    if (num.startsWith('55') && num.length === 12) variantes.push('55' + '9' + num.slice(4));
                                    let res2 = null;
                                    for (const v of variantes) if (mapa[v]) { res2 = mapa[v]; break; }
                                    const temWA = res2?.exists === true || res2?.exists === 'true' || res2?.jid;
                                    if (!temWA) { semWhats++; continue; }
                                    const nomeWA = res2?.name || res2?.pushName || null;
                                    this.disparoContatosExtraidos.push({ nome: (nomeWA && nomeWA !== num) ? nomeWA : c.nome, numero: num });
                                    jaNaFila.add(num);
                                    adicionados++;
                                }
                            } catch(e) {
                                // Sem verificação — adiciona todos
                                for (const c of contatos) {
                                    if (!jaNaFila.has(c.numero)) { this.disparoContatosExtraidos.push(c); jaNaFila.add(c.numero); adicionados++; }
                                    else duplicados++;
                                }
                            } finally {
                                this.disparoVerificando = false;
                            }

                            this.disparoBookmarkletStatus = `✅ ${adicionados} adicionado(s) · ❌ ${semWhats} sem WhatsApp · ⚠️ ${duplicados} duplicado(s)`;
                            setTimeout(() => { this.disparoBookmarkletStatus = ''; }, 6000);
                            this.$nextTick(() => lucide.createIcons());
                        };
                    } catch(e) { console.warn('BroadcastChannel não suportado:', e); }
                },

                setupVisibilityReload() {
                    // Recarrega leads/conversas quando o usuário volta para a aba
                    document.addEventListener('visibilitychange', () => {
                        if (!document.hidden && this.appState === 'crm') {
                            this.loadLeads();
                        }
                    });
                },

                setupRealtime() {
                    const inst = this.instanceName;
                    // Conecta via WebSocket nativo ao server.js (substitui Supabase Realtime)
                    const wsUrl = SERVER_URL.replace(/^https/, 'wss').replace(/^http/, 'ws') + `/ws?inst=${inst}`;
                    let ws, wsRetryTimer;

                    const connectWs = () => {
                        ws = new WebSocket(wsUrl);
                        ws.onopen = () => { console.log('📡 WS conectado'); };
                        ws.onmessage = (e) => {
                            let msg;
                            try { msg = JSON.parse(e.data); } catch(err) { return; }
                            if (msg.type === 'connected') return;

                            // Chat Interno — tratado adiante junto com os outros eventos
                            // (handler antigo removido: usava chatInternoOpen/chatInternoUnread que não existem mais)



                            const payload = { eventType: msg.event, new: msg.data, old: msg.old };

                            if (msg.type === 'leads') {
                                if (payload.new && payload.new.instance_name !== this.instanceName) return;
                                if (payload.eventType === 'INSERT') {
                                    if (this.leads.some(l => l.id === payload.new.id)) return;
                                    this.leads = [payload.new, ...this.leads];
                                    setTimeout(() => this._sincronizarPerfilLead(payload.new), 2000);
                                    if (this.currentUserDept === 'ADM Principal' || (payload.new.departamento || 'ADM Principal') === this.currentUserDept) {
                                        this.addNotification('Novo Lead!', `O cliente ${this.getLeadName(payload.new)} chegou.`, 'info');
                                        if (document.hidden) { this.showNativeNotification('🎯 Novo Lead!', `${this.getLeadName(payload.new)} acabou de entrar em contato`, `lead-${payload.new.id}`); }
                                    }
                                } else if (payload.eventType === 'UPDATE') {
                                    const idx = this.leads.findIndex(l => l.id === payload.new.id);
                                    if (idx !== -1) {
                                        const local = this.leads[idx]; const remoto = payload.new;
                                        const localTime = new Date(local.last_interaction || 0).getTime();
                                        const remoteTime = new Date(remoto.last_interaction || 0).getTime();
                                        if (remoteTime >= localTime - 2000) {
                                            const strValida = (s) => s && typeof s === 'string' && s.trim().length > 0;
                                            const fotoValida = (u) => u && u !== 'default' && !u.includes('dicebear') && u.startsWith('http');
                                            const safeUpdate = { ...remoto };
                                            const nomeLocalValido = strValida(local.nome) && local.nome !== local.numero && !['Lead Avulso', 'Lead Importado', 'Desconhecido'].includes(local.nome);
                                            const nomeRemotoValido = strValida(safeUpdate.nome) && safeUpdate.nome !== safeUpdate.numero && !['Lead Avulso', 'Lead Importado', 'Desconhecido'].includes(safeUpdate.nome);
                                            if (nomeLocalValido && !nomeRemotoValido) { safeUpdate.nome = local.nome; }
                                            if (!strValida(safeUpdate.numero)) safeUpdate.numero = local.numero;
                                            if (fotoValida(local.foto_url) && !fotoValida(safeUpdate.foto_url)) { safeUpdate.foto_url = local.foto_url; }
                                            this.leads[idx] = { ...local, ...safeUpdate, id: local.id, numero: safeUpdate.numero || local.numero };
                                            this.leads = [...this.leads];
                                            if (this.selectedLead?.id === local.id) { this.selectedLead = { ...this.selectedLead, ...safeUpdate, id: local.id }; }
                                            // Sync sentimento do banco para o mapa local
                                            if (safeUpdate.sentimento) {
                                                this.leadSentimento = { ...this.leadSentimento, [local.id]: safeUpdate.sentimento };
                                            }
                                        }
                                        if (payload.new.status === 'fechado' && payload.old?.status !== 'fechado') { this.addNotification('Venda Fechada!', `${this.getLeadName(payload.new)} agora é cliente!`, 'success'); }
                                        if (payload.new.departamento && payload.old?.departamento && payload.new.departamento !== payload.old.departamento) {
                                            if (payload.new.departamento === this.currentUserDept || this.currentUserDept === 'ADM Principal') { this.addNotification('Transferência Recebida', `O cliente ${this.getLeadName(payload.new)} foi transferido para o seu setor.`, 'info'); this.playSound(); }
                                        }
                                    }
                                }
                            }

                            if (msg.type === 'messages') {
                                if (payload.new && payload.new.instance_name !== this.instanceName) return;
                                if (payload.eventType === 'INSERT') {
                                    this.updateLeadLocalInteraction(payload.new.lead_id, payload.new.content, payload.new.type, !payload.new.from_me);
                                    if (!payload.new.from_me) {
                                        const leadParaBot = this.leads.find(l => l.id === payload.new.lead_id);
                                        this.iaAddLog('info', `📩 Msg cliente recebida | lead:${leadParaBot ? this.getLeadName(leadParaBot) : '❌ NÃO ENCONTRADO'} | processada pelo worker 24/7`);
                                    } else if (payload.new.from_me) {
                                        if (payload.new.sent_by_ia === true || payload.new.sent_by_ia === false) return;
                                        const leadHumano = this.leads.find(l => l.id === payload.new.lead_id);
                                        const leadName = leadHumano ? this.getLeadName(leadHumano) : payload.new.lead_id;
                                        this._pausarIA(payload.new.lead_id, leadName, { texto: payload.new.content, fonte: 'WhatsApp' });
                                    }
                                    if (this.isChatOpen && payload.new.lead_id === this.selectedLead?.id) {
                                        if (!this.messages.find(m => m.id === payload.new.id)) { this.messages = [...this.messages, payload.new]; this.scrollToBottom(); this._refreshIcons(); }
                                    } else if (!payload.new.from_me) {
                                        const leadMsg = this.myLeads.find(l => l.id === payload.new.lead_id);
                                        if (leadMsg && leadMsg.status !== 'grupo') {
                                            this.playSound();
                                            if (document.hidden) { const preview = this.formatText(payload.new.content).substring(0, 50); this.showNativeNotification(`💬 Nova mensagem de ${this.getLeadName(leadMsg)}`, preview, `msg-${leadMsg.id}`); }
                                        }
                                    }
                                } else if (payload.eventType === 'UPDATE') {
                                    if (this.isChatOpen && payload.new.lead_id === this.selectedLead?.id) {
                                        const idx = this.messages.findIndex(m => m.id === payload.new.id);
                                        if (idx !== -1) { let newMsgs = [...this.messages]; newMsgs[idx] = payload.new; this.messages = newMsgs; this._refreshIcons(); }
                                    }
                                }
                            }

                            // ── Chat Interno: recebe novas mensagens em tempo real ──
                            if (msg.type === 'chat_interno' && msg.event === 'INSERT') {
                                const m = msg.data;
                                if (!m || m.instance_name !== this.instanceName) return;
                                const myDept = this.currentUserDept || 'ADM Principal';
                                const isMine = m.from_dept === myDept;
                                // Caso 1: chat aberto no lead da mensagem E aba interno ativa — adiciona na tela
                                if (this.isChatOpen && this.chatTab === 'interno' && this.selectedLead?.id === m.lead_id) {
                                    if (!this.chatInternoMsgs.find(x => x.id === m.id)) {
                                        this.chatInternoMsgs = [...this.chatInternoMsgs, m];
                                        this.$nextTick(() => {
                                            const box = document.getElementById('chat-interno-box');
                                            if (box) box.scrollTop = box.scrollHeight;
                                        });
                                    }
                                } else if (this.isChatOpen && this.selectedLead?.id === m.lead_id) {
                                    // Caso 2: lead aberto, mas aba cliente ativa — incrementa badge da aba interno
                                    if (!isMine) {
                                        this.chatInternoNaoLidos = (this.chatInternoNaoLidos || 0) + 1;
                                        this.playSound();
                                        this.addNotification('💬 Mensagem Interna', `${m.from_dept}: ${m.content.substring(0,50)}`, 'info');
                                    }
                                } else if (!isMine) {
                                    // Caso 3: mensagem em outro lead — notifica globalmente
                                    const lead = this.leads.find(l => l.id === m.lead_id);
                                    const leadNome = lead ? this.getLeadName(lead) : 'atendimento';
                                    this.addNotification('💬 Chat Interno', `${m.from_dept} em ${leadNome}: ${m.content.substring(0,50)}`, 'info');
                                    if (m.content.includes('@Admin') || m.content.includes('📢')) this.playSound();
                                }
                            }

                            // ── Roteamento automático de departamento ──
                            if (msg.type === 'dept_route') {
                                const deptDestino = msg.departamento;
                                const isMyDept = this.currentUserDept === deptDestino || this.currentUserDept === 'ADM Principal';
                                if (isMyDept) {
                                    const nome = msg.lead_nome || msg.lead_numero || 'Cliente';
                                    const motivo = msg.motivo ? ` — ${msg.motivo}` : '';
                                    this.addNotification('📋 Novo cliente direcionado!', `${nome} foi encaminhado para ${deptDestino}${motivo}`, 'info');
                                    this.playSound();
                                    this.showNativeNotification(
                                        `📋 Cliente → ${deptDestino}`,
                                        `${nome} precisa de atendimento${motivo}`,
                                        `dept-route-${msg.lead_id}`
                                    );
                                    // Recarrega leads para refletir a mudança de departamento
                                    this.loadLeads();
                                }
                            }

                            // ── Fila de atendimento: atualização em tempo real ──
                            if (msg.type === 'fila_update') {
                                this._atualizarFilaLocal(msg);
                            }
                        };
                        ws.onclose = () => {
                            console.log('📡 WS desconectado — reconectando em 3s');
                            clearTimeout(wsRetryTimer);
                            wsRetryTimer = setTimeout(connectWs, 3000);
                        };
                        ws.onerror = () => { ws.close(); };
                    };
                    connectWs();
                    this._ws = ws;
                    // Guarda referência para reconexão
                    Object.defineProperty(this, '_ws', { get: () => ws, set: v => { ws = v; }, configurable: true });
                },

                async updateStatus(id, status) {
                    const val = status || null;
                    const idx = this.leads.findIndex(l => l.id === id);
                    if (idx !== -1) {
                        this.leads[idx].status = val;
                        this.leads = [...this.leads];
                        await this.client.from('leads').update({ status: val }).eq('id', id);
                        if (val) {
                            const col = this.columns.find(c => c.id === val);
                            if (col?.is_final && !this.leads[idx].atendimento_fim) {
                                await this.encerrarAtendimento(id);
                            }
                        }
                    }
                },
                async encerrarAtendimento(leadId) {
                    try {
                        const resp = await fetch('/api/encerrar-atendimento', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId }),
                        });
                        const data = await resp.json();
                        if (data.ok && !data.ja_encerrado) {
                            const idx = this.leads.findIndex(l => l.id === leadId);
                            if (idx !== -1) {
                                const agora = new Date().toISOString();
                                this.leads[idx] = { ...this.leads[idx], atendimento_fim: agora, tma_segundos: data.tma_segundos, followup_lead_ativo: false };
                                this.leads = [...this.leads];
                            }
                            if (this.selectedLead?.id === leadId) {
                                this.selectedLead = { ...this.selectedLead, atendimento_fim: new Date().toISOString(), tma_segundos: data.tma_segundos, followup_lead_ativo: false };
                            }
                            // Desativa followup ao encerrar atendimento
                            await this.client.from('leads').update({ followup_lead_ativo: false }).eq('id', leadId);
                            this.addNotification('Atendimento Encerrado', 'TMA: ' + this._fmtTempo(data.tma_segundos), 'success');
                        }
                        return data;
                    } catch(e) {
                        console.error('[encerrarAtendimento]', e);
                        this.addNotification('Erro', 'Não foi possível encerrar o atendimento.', 'error');
                    }
                },
                async reiniciarAtendimento(leadId) {
                    try {
                        const resp = await fetch('/api/reiniciar-atendimento', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId }),
                        });
                        const data = await resp.json();
                        if (data.ok && !data.ja_ativo) {
                            const novo = data.atendimento_inicio || new Date().toISOString();
                            const idx = this.leads.findIndex(l => l.id === leadId);
                            if (idx !== -1) {
                                this.leads[idx] = { ...this.leads[idx], atendimento_inicio: novo, atendimento_fim: null, tma_segundos: null };
                                this.leads = [...this.leads];
                            }
                            if (this.selectedLead?.id === leadId) {
                                this.selectedLead = { ...this.selectedLead, atendimento_inicio: novo, atendimento_fim: null, tma_segundos: null };
                            }
                            this.addNotification('Atendimento Reiniciado', 'O atendimento foi reaberto.', 'success');
                        }
                        return data;
                    } catch(e) {
                        console.error('[reiniciarAtendimento]', e);
                        this.addNotification('Erro', 'Não foi possível reiniciar o atendimento.', 'error');
                    }
                },
                scrollToBottom() { setTimeout(() => { const b = document.getElementById('chat-box'); if(b) b.scrollTop = b.scrollHeight; }, 100); },

                // ── BASE DE CONHECIMENTO ──────────────────────────────────────
                async kbAsk() {
                    const q = this.kbInput.trim();
                    if (!q || this.kbLoading) return;
                    this.kbMessages.push({ role: 'user', content: q });
                    this.kbInput = '';
                    this.kbLoading = true;
                    this._kbScrollBottom();
                    try {
                        const res = await fetch('/api/knowledge/ask', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, question: q })
                        });
                        const data = await res.json();
                        if (data.error) throw new Error(data.error);
                        this.kbMessages.push({ role: 'assistant', content: data.answer });
                    } catch(e) {
                        this.kbMessages.push({ role: 'assistant', content: `❌ Erro: ${e.message}` });
                    }
                    this.kbLoading = false;
                    this._kbScrollBottom();
                },

                async kbLoadDocs() {
                    try {
                        const res = await fetch(`/api/knowledge/docs?inst=${this.instanceName}`);
                        const data = await res.json();
                        this.kbDocs = data.data || [];
                    } catch(e) { this.kbDocs = []; }
                },

                async kbUploadDoc(event) {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const allowed = ['pdf', 'txt', 'docx', 'csv', 'md'];
                    const ext = file.name.split('.').pop().toLowerCase();
                    if (!allowed.includes(ext)) {
                        this.addNotification('Formato inválido', `Formatos aceitos: ${allowed.join(', ')}`, 'error');
                        event.target.value = '';
                        return;
                    }
                    this.kbUploadingDoc = true;
                    try {
                        const fd = new FormData();
                        fd.append('inst', this.instanceName);
                        fd.append('file', file);
                        const res = await fetch('/api/knowledge/upload', { method: 'POST', body: fd });
                        const data = await res.json();
                        if (data.error) throw new Error(data.error);
                        this.addNotification('📄 Documento importado!', `${file.name} — ${data.chunks} chunks extraídos`, 'success');
                        await this.kbLoadDocs();
                    } catch(e) {
                        this.addNotification('Erro no upload', e.message, 'error');
                    }
                    this.kbUploadingDoc = false;
                    event.target.value = '';
                },

                async kbDeleteDoc(id, nome) {
                    if (!confirm(`Remover "${nome}" da base de conhecimento?`)) return;
                    try {
                        await fetch(`/api/knowledge/docs?id=${id}`, { method: 'DELETE' });
                        this.addNotification('Removido', `${nome} foi removido da base.`, 'info');
                        await this.kbLoadDocs();
                    } catch(e) {}
                },

                kbInsertToChat(text) {
                    this.newMsg = text;
                    this.kbPanelOpen = false;
                    this.addNotification('📋 Resposta copiada', 'O texto foi inserido no campo de mensagem.', 'info');
                    setTimeout(() => {
                        const input = document.getElementById('chat-input');
                        if (input) { input.focus(); input.dispatchEvent(new Event('input')); }
                    }, 100);
                },

                _kbScrollBottom() {
                    setTimeout(() => {
                        const el = document.getElementById('kb-chat-box');
                        if (el) el.scrollTop = el.scrollHeight;
                    }, 100);
                },

                // ═══════════════════════════════════════════════════════════
                // DOCUMENTOS DO LEAD
                // ═══════════════════════════════════════════════════════════
                async docsLoad(leadId) {
                    this.docsLoading = true;
                    try {
                        const res = await fetch('/api/lead-docs/list', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId })
                        });
                        const data = await res.json();
                        this.docsList = data.docs || [];
                    } catch (e) { this.docsList = []; }
                    this.docsLoading = false;
                },

                async docsUpload(event, leadId) {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    this.docsUploading = true;
                    try {
                        // 1. Upload do arquivo para o servidor
                        const ext = file.name.split('.').pop().toLowerCase();
                        const safeName = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
                        const fd = new FormData();
                        fd.append('path', `documentos/${this.instanceName}/${leadId}/${safeName}`);
                        fd.append('file', file);
                        const upRes = await fetch('/local-upload', { method: 'POST', body: fd });
                        const upData = await upRes.json();
                        if (!upData.ok) throw new Error(upData.error || 'Falha no upload');

                        // 2. Registrar no banco
                        const docNome = prompt('Nome do documento:', file.name.replace(/\.[^.]+$/, ''));
                        if (!docNome) { this.docsUploading = false; event.target.value = ''; return; }
                        const docDesc = prompt('Descrição (opcional):', '') || '';

                        const res = await fetch('/api/lead-docs/create', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                inst: this.instanceName,
                                lead_id: leadId,
                                nome: docNome,
                                descricao: docDesc,
                                arquivo_url: upData.url,
                                arquivo_tipo: file.type || ext,
                                arquivo_tamanho: file.size,
                                notificar: this.docsNotificar,
                            })
                        });
                        const data = await res.json();
                        if (data.error) throw new Error(data.error);
                        this.addNotification('📄 Documento anexado', `${docNome} enviado com sucesso${this.docsNotificar ? ' — cliente notificado!' : ''}`, 'success');
                        await this.docsLoad(leadId);
                    } catch (e) {
                        this.addNotification('Erro no upload', e.message, 'error');
                    }
                    this.docsUploading = false;
                    event.target.value = '';
                },

                async docsUpdate(doc) {
                    const file = await new Promise(resolve => {
                        const inp = document.createElement('input');
                        inp.type = 'file';
                        inp.onchange = () => resolve(inp.files[0]);
                        inp.click();
                    });
                    if (!file) return;
                    this.docsUploading = true;
                    try {
                        const ext = file.name.split('.').pop().toLowerCase();
                        const safeName = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
                        const fd = new FormData();
                        fd.append('path', `documentos/${this.instanceName}/${doc.lead_id}/${safeName}`);
                        fd.append('file', file);
                        const upRes = await fetch('/local-upload', { method: 'POST', body: fd });
                        const upData = await upRes.json();
                        if (!upData.ok) throw new Error(upData.error || 'Falha no upload');

                        const novaDesc = prompt('Descrição da atualização (opcional):', doc.descricao || '') || doc.descricao || '';

                        const res = await fetch('/api/lead-docs/update', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                inst: this.instanceName,
                                doc_id: doc.id,
                                descricao: novaDesc,
                                arquivo_url: upData.url,
                                arquivo_tipo: file.type || ext,
                                arquivo_tamanho: file.size,
                                notificar: this.docsNotificar,
                            })
                        });
                        const data = await res.json();
                        if (data.error) throw new Error(data.error);
                        this.addNotification('📄 Documento atualizado', `${doc.nome} v${data.doc.versao}${this.docsNotificar ? ' — cliente notificado!' : ''}`, 'success');
                        await this.docsLoad(doc.lead_id);
                    } catch (e) {
                        this.addNotification('Erro na atualização', e.message, 'error');
                    }
                    this.docsUploading = false;
                },

                async docsDelete(doc) {
                    if (!confirm(`Remover "${doc.nome}"?`)) return;
                    try {
                        await fetch('/api/lead-docs/delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ doc_id: doc.id })
                        });
                        this.addNotification('Removido', `${doc.nome} foi removido.`, 'info');
                        await this.docsLoad(doc.lead_id);
                    } catch (e) {
                        this.addNotification('Erro', e.message, 'error');
                    }
                },

                docsFormatSize(bytes) {
                    if (!bytes) return '';
                    if (bytes < 1024) return bytes + ' B';
                    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
                    return (bytes / 1048576).toFixed(1) + ' MB';
                },

                docsIcon(tipo) {
                    if (!tipo) return 'file';
                    if (tipo.includes('pdf')) return 'file-text';
                    if (tipo.includes('image')) return 'image';
                    if (tipo.includes('word') || tipo.includes('docx')) return 'file-text';
                    if (tipo.includes('excel') || tipo.includes('sheet') || tipo.includes('xlsx')) return 'file-spreadsheet';
                    if (tipo.includes('video')) return 'film';
                    if (tipo.includes('audio')) return 'music';
                    if (tipo.includes('zip') || tipo.includes('rar')) return 'archive';
                    return 'file';
                }
            }
        }
