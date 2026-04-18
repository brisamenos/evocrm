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
                ...sonsMixin(),
                ...docsMixin(),
                ...agendaMixin(),
                ...disparoMixin(),
                ...autoReplyMixin(),
                ...iaAtendMixin(),
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
                chatListTab: 'chats',     // 'chats' | 'fila' | 'contatos' (para supervisor/atendente)
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
                // Modal de transferência
                showTransferModal: false, transferLeadId: null, transferDeptSelecionado: '', transferMotivo: '',
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

                // → docsMixin() — ver app-docs.js
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
                // → sonsMixin() — ver app-sons.js
                
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

                get userRole() {
                    if (this.currentUserDept === 'ADM Principal') return 'admin';
                    if (this.isSupervisor) return 'supervisor';
                    return 'atendente';
                },

                get filteredNavItems() {
                    const role = this.userRole;
                    return [...this.navItems]
                        .filter(item => !item.roles || item.roles.includes(role))
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
                        // Gerar supervisor_id se supervisor novo (sem ID ainda)
                        let supId = this.editingDeptId ? (this.departmentsDB.find(d => d.id === this.editingDeptId)?.supervisor_id || null) : null;
                        if (this.newDeptSupervisorNome.trim() && this.newDeptSupervisorKey.trim() && !supId) {
                            supId = 'SUP-' + Math.random().toString(36).substring(2, 6).toUpperCase();
                        }
                        if (!this.newDeptSupervisorNome.trim()) supId = null;

                        const deptPayload = {
                            name: this.newDeptName.trim(),
                            access_key: this.newDeptKey.trim() || 'admin123',
                            palavras_chave: this.newDeptKeywords.trim(),
                            msg_roteamento: this.newDeptMsg.trim(),
                            supervisor_nome: this.newDeptSupervisorNome.trim() || null,
                            supervisor_key: this.newDeptSupervisorKey.trim() || null,
                            supervisor_id: supId
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
                        if (this.currentUserDept === 'ADM Principal') this.loadStaffLogins();
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
                        const atdId = 'ATD-' + Math.random().toString(36).substring(2, 6).toUpperCase();
                        const { error } = await this.client.from('dept_atendentes').insert({
                            id: atdId,
                            instance_name: this.instanceName,
                            dept_id: deptDb.id,
                            nome: nome.trim(),
                            senha: senha.trim(),
                            ativo: 1
                        });
                        if (error) throw error;
                        this.addNotification('Sucesso', `Atendente "${nome}" criado! ID: ${atdId}`, 'success');
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

                abrirTransferModal(leadId) {
                    this.transferLeadId = leadId;
                    this.transferDeptSelecionado = '';
                    this.transferMotivo = '';
                    this.showTransferModal = true;
                    this.$nextTick(() => lucide.createIcons());
                },
                async confirmarTransferencia() {
                    const leadId = this.transferLeadId;
                    const novoDept = this.transferDeptSelecionado;
                    const motivo = this.transferMotivo.trim();
                    if (!leadId || !novoDept) return;
                    this.showTransferModal = false;

                    const idx = this.leads.findIndex(l => l.id === leadId);
                    if (idx !== -1) {
                        this.leads[idx].departamento = novoDept;
                        this.leads[idx].atendente_nome = null;
                        this.leads[idx].transfer_motivo = motivo;
                        this.leads[idx].transfer_de = this.currentUserDept;
                        this.leads = [...this.leads];
                        await this.client.from('leads').update({ departamento: novoDept, atendente_nome: null, transfer_motivo: motivo, transfer_de: this.currentUserDept }).eq('id', leadId);
                        this.addNotification('Transferido', `Cliente enviado para fila de ${novoDept}.`, 'success');
                        
                        const motivoTxt = motivo ? `\nMotivo: _${motivo}_` : '';
                        const sysMsg = `*Transferência de Setor*\nO cliente foi transferido de ${this.currentUserDept} para: *${novoDept}*.${motivoTxt}`;
                        const tempId = 'sys-' + Date.now();
                        const tempMsgObj = { id: tempId, lead_id: leadId, content: sysMsg, from_me: true, type: 'text', status: 'sent', timestamp: new Date().toISOString() };
                        
                        if (this.isChatOpen && this.selectedLead?.id === leadId) {
                            this.messages = [...this.messages, tempMsgObj];
                            this.scrollToBottom();
                        }
                        this.updateLeadLocalInteraction(leadId, sysMsg, 'type');
                        this.client.from('messages').insert({ lead_id: leadId, content: sysMsg, from_me: true, type: 'text', status: 'sent', instance_name: this.instanceName }).then();

                        // Enfileirar o lead no novo departamento
                        fetch('/api/fila/entrar', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                inst: this.instanceName,
                                lead_id: leadId,
                                numero: this.leads[idx]?.numero || '',
                                nome: this.leads[idx]?.nome || '',
                                departamento: novoDept,
                                motivo: motivo || 'Transferência manual'
                            })
                        }).then(() => this.carregarFila()).catch(() => {});

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

                    const filaAntes = this.filaLista.length;
                    // Recarrega e notifica atendente se houver gente esperando
                    this.carregarFila().then(() => {
                        // Se a ação foi encerramento/início e ainda há gente na fila, avisa o atendente
                        if ((update.acao === 'encerrado' || update.acao === 'inicio' || update.acao === 'reposicao') && this.filaLista.length > 0) {
                            const prox = this.filaLista[0];
                            this.addNotification('📋 Próximo na fila', `${prox.nome || prox.numero} está aguardando atendimento.`, 'info');
                            this.playSound();
                        }
                        // Se entrou alguém novo na fila
                        if (update.acao === 'entrada' && this.filaLista.length > filaAntes) {
                            this.addNotification('🔔 Nova entrada na fila', `${update.nome || 'Cliente'} entrou na fila.`, 'info');
                            this.playSound();
                        }
                    });
                },

                get ativosAgoraPorDept() {
                    void this._tickSegundo;
                    const ativos = this.leads.filter(l => l.instance_name === this.instanceName && l.atendimento_inicio && !l.atendimento_fim && (l.departamento || 'ADM Principal') !== 'ADM Principal');
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
                
                staffLogins: [],

                async doStaffLogin(loginId, senha) {
                    if (!loginId?.trim() || !senha?.trim()) return;
                    this.isCheckingLicense = true;
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/auth/staff-login`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ login_id: loginId.trim(), senha: senha.trim() })
                        });
                        const result = await resp.json();
                        if (!resp.ok || result.error) {
                            this._setStaffError(result.error || 'ID ou senha inválidos');
                            this.isCheckingLicense = false;
                            return;
                        }
                        this._completeStaffLogin(result);
                    } catch(e) {
                        this._setStaffError('Erro de conexão');
                    }
                    this.isCheckingLicense = false;
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


                // Admin: carregar todos os logins de staff
                async loadStaffLogins() {
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/staff-logins?inst=${encodeURIComponent(this.instanceName)}`);
                        this.staffLogins = await resp.json();
                    } catch(e) { this.staffLogins = []; }
                },

                staffDashData: [],
                staffDashLoading: false,

                async loadStaffDashboard() {
                    this.staffDashLoading = true;
                    try {
                        const dept = (this.userRole === 'supervisor') ? `&dept=${encodeURIComponent(this.currentUserDept)}` : '';
                        const resp = await fetch(`${SERVER_URL}/api/stats/staff-dashboard?inst=${encodeURIComponent(this.instanceName)}${dept}`);
                        const data = await resp.json();
                        if (data.ok) this.staffDashData = data.departamentos || [];
                    } catch(e) { this.staffDashData = []; }
                    this.staffDashLoading = false;
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
                    if (this.currentUserDept === 'ADM Principal') this.loadStaffLogins();
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
                    // Refresh periódico da fila para supervisor/atendente (10s)
                    if (this.userRole !== 'admin') {
                        setInterval(() => { this.carregarFila(); }, 10000);
                    }
                    
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
                
                // → agendaMixin() — ver app-agenda.js
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

                    // Admin: tira da fila ao abrir (comportamento original)
                    // Admin: NÃO registra atendimento próprio (TMA/TME é só dos atendentes)
                    if (this.userRole === 'admin') {
                        // Apenas tira da fila se estava aguardando, sem registrar como atendente
                        if (this.filaPorLead && this.filaPorLead[lead.id]) {
                            fetch('/api/fila/iniciar', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ inst: this.instanceName, lead_id: lead.id, agente_nome: '' })
                            }).catch(() => {});
                        }
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
                    const leadId = this.selectedLead.id;

                    // Supervisor/Atendente: primeira mensagem inicia o atendimento (tira da fila, atribui nome)
                    if (this.userRole !== 'admin' && this.filaPorLead[leadId]) {
                        const meuNome = this.loggedUserName || this.currentUserDept || 'Atendente';
                        fetch('/api/fila/iniciar', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId, agente_nome: meuNome })
                        }).then(() => this.carregarFila()).catch(() => {});
                        // Atribui atendente ao lead
                        const idx = this.leads.findIndex(l => l.id === leadId);
                        if (idx !== -1) {
                            this.leads[idx].atendente_nome = meuNome;
                            this.leads = [...this.leads];
                        }
                        this.selectedLead.atendente_nome = meuNome;
                        this.client.from('leads').update({ atendente_nome: meuNome }).eq('id', leadId);
                    } else if (this.userRole !== 'admin') {
                        // Sem fila — registra início para contabilizar TMA/TME
                        const meuNome = this.loggedUserName || this.currentUserDept || 'Atendente';
                        if (!this.selectedLead.atendente_nome || this.selectedLead.atendente_nome !== meuNome) {
                            this.selectedLead.atendente_nome = meuNome;
                            const idx = this.leads.findIndex(l => l.id === leadId);
                            if (idx !== -1) { this.leads[idx].atendente_nome = meuNome; this.leads = [...this.leads]; }
                            this.client.from('leads').update({ atendente_nome: meuNome }).eq('id', leadId);
                        }
                        fetch('/api/registrar-inicio-atendimento', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId, agente_nome: meuNome })
                        }).catch(() => {});
                    }

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
                    const leadId = this.selectedLead.id;
                    // Supervisor/Atendente: primeira mensagem (mídia) inicia o atendimento
                    if (this.userRole !== 'admin' && this.filaPorLead[leadId]) {
                        const meuNome = this.loggedUserName || this.currentUserDept || 'Atendente';
                        fetch('/api/fila/iniciar', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId, agente_nome: meuNome })
                        }).then(() => this.carregarFila()).catch(() => {});
                        const idx = this.leads.findIndex(l => l.id === leadId);
                        if (idx !== -1) { this.leads[idx].atendente_nome = meuNome; this.leads = [...this.leads]; }
                        this.selectedLead.atendente_nome = meuNome;
                        this.client.from('leads').update({ atendente_nome: meuNome }).eq('id', leadId);
                    } else if (this.userRole !== 'admin') {
                        const meuNome = this.loggedUserName || this.currentUserDept || 'Atendente';
                        if (!this.selectedLead.atendente_nome || this.selectedLead.atendente_nome !== meuNome) {
                            this.selectedLead.atendente_nome = meuNome;
                            const idx = this.leads.findIndex(l => l.id === leadId);
                            if (idx !== -1) { this.leads[idx].atendente_nome = meuNome; this.leads = [...this.leads]; }
                            this.client.from('leads').update({ atendente_nome: meuNome }).eq('id', leadId);
                        }
                        fetch('/api/registrar-inicio-atendimento', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ inst: this.instanceName, lead_id: leadId, agente_nome: meuNome })
                        }).catch(() => {});
                    }
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

                // → disparoMixin() — ver app-disparo.js
                // ══════════════════════════════════════════════════════════
                //  MÉTODOS: RESPOSTAS AUTOMÁTICAS (Chatbot por palavra-chave)
                // → autoReplyMixin() — ver app-autoreply.js
                // → iaAtendMixin() — ver app-ia-atend.js
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

// ═══════════════════════════════════════════════════════════════
// Alpine.data() — componentes extraídos do index.html inline
// ═══════════════════════════════════════════════════════════════

document.addEventListener('alpine:init', () => {

    // ── Dashboard (tasks, notifs, KPIs) ──
    Alpine.data('dashComponent', () => ({
        dashTab: 'overview',
        tasks: [],
        dashNotifs: [],
        taskForm: { title: '', desc: '', priority: 'media', due: '', tag: 'geral' },
        notifForm: { title: '', body: '', type: 'info', scheduled: '' },
        taskFilter: 'todas',
        showTaskModal: false,
        showNotifModal: false,
        showNotifDetail: false,
        notifDetail: null,
        editTaskId: null,
        _dbClient() { return window._evoSupabase || null; },
        _inst() { return instanceName || ''; },
        async saveTasks() {},
        async saveDashNotifs() {},
        async refreshDashNotifs() {
            try {
                const db = window._evoSupabase;
                if (!db || !this._inst()) return;
                const { data } = await db.from('dash_notifs').select('*').eq('instance_name', this._inst()).order('created_at', { ascending: false }).limit(200);
                if (data) this.dashNotifs = data.map(r => ({ id: r.id, title: r.title, body: r.body, type: r.type, scheduled: r.scheduled || '', read: r.read, createdAt: r.created_at, criadoPorIA: r.criado_por_ia, leadId: r.lead_id, tipoAgenda: r.tipo_agenda }));
            } catch(e) { console.warn('[dashNotifs]', e); }
        },
        async refreshTasks() {
            try {
                const db = window._evoSupabase;
                if (!db || !this._inst()) return;
                const { data } = await db.from('dash_tasks').select('*').eq('instance_name', this._inst()).order('created_at', { ascending: false }).limit(500);
                if (data) this.tasks = data.map(r => ({ id: r.id, title: r.title, desc: r.desc || '', priority: r.priority, due: r.due || '', tag: r.tag || 'geral', done: r.done, createdAt: r.created_at, criadoPorIA: r.criado_por_ia, leadId: r.lead_id }));
            } catch(e) { console.warn('[dashTasks]', e); }
        },
        async addTask() {
            if (!this.taskForm.title.trim()) return;
            const db = window._evoSupabase;
            if (this.editTaskId) {
                const idx = this.tasks.findIndex(t => t.id === this.editTaskId);
                if (idx !== -1) {
                    this.tasks[idx] = { ...this.tasks[idx], ...this.taskForm };
                    if (db) await db.from('dash_tasks').update({ title: this.taskForm.title, desc: this.taskForm.desc, priority: this.taskForm.priority, due: this.taskForm.due || null, tag: this.taskForm.tag }).eq('id', this.editTaskId);
                }
                this.editTaskId = null;
            } else {
                const newTask = { id: Date.now(), ...this.taskForm, done: false, createdAt: new Date().toISOString() };
                this.tasks.unshift(newTask);
                if (db && this._inst()) await db.from('dash_tasks').insert({ instance_name: this._inst(), title: newTask.title, desc: newTask.desc, priority: newTask.priority, due: newTask.due || null, tag: newTask.tag, done: false, criado_por_ia: false });
            }
            this.taskForm = { title: '', desc: '', priority: 'media', due: '', tag: 'geral' };
            this.showTaskModal = false;
            setTimeout(() => lucide.createIcons(), 50);
        },
        async deleteTask(id) { this.tasks = this.tasks.filter(t => t.id !== id); const db = window._evoSupabase; if (db) await db.from('dash_tasks').delete().eq('id', id); },
        async toggleTask(id) { const t = this.tasks.find(t => t.id === id); if (t) { t.done = !t.done; const db = window._evoSupabase; if (db) await db.from('dash_tasks').update({ done: t.done }).eq('id', id); } },
        editTask(t) { this.taskForm = { title: t.title, desc: t.desc, priority: t.priority, due: t.due, tag: t.tag }; this.editTaskId = t.id; this.showTaskModal = true; setTimeout(() => lucide.createIcons(), 50); },
        filteredTasks() {
            let t = this.tasks;
            if (this.taskFilter === 'pendentes') t = t.filter(x => !x.done);
            if (this.taskFilter === 'concluidas') t = t.filter(x => x.done);
            if (this.taskFilter === 'urgente') t = t.filter(x => x.priority === 'alta' && !x.done);
            return t;
        },
        async addDashNotif() {
            if (!this.notifForm.title.trim()) return;
            const newNotif = { id: Date.now(), ...this.notifForm, read: false, createdAt: new Date().toISOString() };
            this.dashNotifs.unshift(newNotif);
            const db = window._evoSupabase;
            if (db && this._inst()) await db.from('dash_notifs').insert({ instance_name: this._inst(), title: newNotif.title, body: newNotif.body, type: newNotif.type, scheduled: newNotif.scheduled || null, read: false, criado_por_ia: false, lead_id: null });
            this.notifForm = { title: '', body: '', type: 'info', scheduled: '' };
            this.showNotifModal = false;
            setTimeout(() => lucide.createIcons(), 50);
        },
        async openNotifDetail(notif) {
            this.notifDetail = notif; this.showNotifDetail = true;
            if (!notif.read) { notif.read = true; const db = window._evoSupabase; if (db) await db.from('dash_notifs').update({ read: true }).eq('id', notif.id); }
            setTimeout(() => lucide.createIcons(), 50);
        },
        abrirChatDaNotif(notif) {
            if (!notif.leadId) return;
            const lead = myLeads.find(l => l.id === notif.leadId);
            if (lead) { this.showNotifDetail = false; screen = 'chats'; this.$nextTick(() => openChat(lead)); }
        },
        async markRead(id) { const n = this.dashNotifs.find(n => n.id === id); if (n) { n.read = true; const db = window._evoSupabase; if (db) await db.from('dash_notifs').update({ read: true }).eq('id', id); } },
        async markAllRead() { this.dashNotifs.forEach(n => n.read = true); const db = window._evoSupabase; if (db && this._inst()) await db.from('dash_notifs').update({ read: true }).eq('instance_name', this._inst()).eq('read', false); },
        async deleteNotif(id) { this.dashNotifs = this.dashNotifs.filter(n => n.id !== id); if (this.notifDetail?.id === id) this.showNotifDetail = false; const db = window._evoSupabase; if (db) await db.from('dash_notifs').delete().eq('id', id); },
        unreadCount() { return this.dashNotifs.filter(n => !n.read).length; },
        iaNotifs() { return this.dashNotifs.filter(n => n.criadoPorIA); },
        iaUnreadCount() { return this.dashNotifs.filter(n => n.criadoPorIA && !n.read).length; },
        tasksDoneToday() { const today = new Date().toDateString(); return this.tasks.filter(t => t.done && new Date(t.createdAt).toDateString() === today).length; },
        tasksOverdue() { const now = new Date(); return this.tasks.filter(t => !t.done && t.due && new Date(t.due) < now).length; },
        priorityColor(p) { return p==='alta' ? 'text-red-500' : p==='media' ? 'text-amber-500' : 'text-[#6366f1]'; },
        priorityBg(p) { return p==='alta' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/40' : p==='media' ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40' : 'bg-[#e0e7ff] dark:bg-[#3730a3]/20 border-[#e0e7ff] dark:border-[#3730a3]/40'; },
        tagColor(tag) { const m={geral:'bg-slate-100 dark:bg-[#21262d] text-slate-600 dark:text-slate-300',vendas:'bg-blue-50 dark:bg-blue-900/20 text-blue-600',suporte:'bg-purple-50 dark:bg-purple-900/20 text-purple-600',marketing:'bg-pink-50 dark:bg-pink-900/20 text-pink-600',financeiro:'bg-amber-50 dark:bg-amber-900/20 text-amber-600',ti:'bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600'}; return m[tag]||m.geral; },
        notifIcon(type) { return type==='success'?'check-circle':type==='error'?'alert-circle':type==='warning'?'alert-triangle':'bell'; },
        notifBorder(type) { return type==='success'?'border-l-[#6366f1]':type==='error'?'border-l-red-500':type==='warning'?'border-l-amber-500':'border-l-blue-500'; },
        notifIconColor(type) { return type==='success'?'text-[#6366f1]':type==='error'?'text-red-500':type==='warning'?'text-amber-500':'text-blue-500'; },
        notifBg(type) { return type==='success'?'bg-[#e0e7ff] dark:bg-[#3730a3]/30':type==='error'?'bg-red-50 dark:bg-red-900/20':type==='warning'?'bg-amber-50 dark:bg-amber-900/20':'bg-blue-50 dark:bg-blue-900/20'; },
        formatDue(due) { if (!due) return ''; const d=new Date(due); const now=new Date(); const diff=Math.ceil((d-now)/(1000*60*60*24)); if (diff<0) return 'Atrasada'; if (diff===0) return 'Hoje'; if (diff===1) return 'Amanhã'; return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'}); },
        isDueUrgent(due) { if (!due) return false; const d=new Date(due); const now=new Date(); return (d-now)/(1000*60*60*24) <= 1; },
        iaAgendamentosPendentes() { return (agendamentos||[]).filter(a => !a.sent && a.criadoPorIA); },
        iaTarefasPendentes() { return this.tasks.filter(t => !t.done && t.criadoPorIA); }
    }));

    // ── Som de notificação ──
    Alpine.data('somConfig', () => ({
        somAtual: localStorage.getItem('evo_som_notif') || 'whatsapp',
        volume: parseFloat(localStorage.getItem('evo_som_volume') || '1'),
        sons: [
            { id: 'whatsapp', label: 'WhatsApp', desc: 'Ping duplo clássico' },
            { id: 'pop',      label: 'Pop',      desc: 'Bolha suave' },
            { id: 'chime',    label: 'Chime',    desc: 'Três notas ascendentes' },
            { id: 'ping',     label: 'Ping',     desc: 'Tom único cristalino' },
            { id: 'ding',     label: 'Ding',     desc: 'Campainha leve' },
            { id: 'none',     label: 'Sem som',  desc: 'Silencioso' },
        ],
        setSom(id) { this.somAtual = id; localStorage.setItem('evo_som_notif', id); if (id !== 'none') previewSom(id); },
        setVolume(v) { this.volume = v; localStorage.setItem('evo_som_volume', v); }
    }));

    // ── IA Gerador de Prompts ──
    Alpine.data('iaGerador', () => ({
        geradorForm: { nicho: '', objetivo: '', tom: 'profissional', restricoes: '', extras: '' },
        geradorResultado: '',
        geradorLoading: false,
        async gerarPrompt() {
            if (!this.geradorForm.nicho || !this.geradorForm.objetivo) { alert('Preencha ao menos o nicho e o objetivo.'); return; }
            if (!iaApiKey) { iaTab = 'config'; addNotification('API Key necessária', 'Configure sua chave OpenAI para continuar.', 'info'); return; }
            this.geradorLoading = true; this.geradorResultado = '';
            try {
                const instrucao = `Você é especialista em criar prompts de sistema para assistentes de atendimento ao cliente via WhatsApp.\nCrie um prompt de sistema completo, detalhado e profissional com as seguintes características:\n- Nicho/Empresa: ${this.geradorForm.nicho}\n- Objetivo principal: ${this.geradorForm.objetivo}\n- Tom de comunicação: ${this.geradorForm.tom}\n- Restrições/Regras: ${this.geradorForm.restricoes || 'Nenhuma específica'}\n- Extras: ${this.geradorForm.extras || 'Nenhum'}\n\nO prompt deve:\n1. Definir claramente o papel e identidade da IA\n2. Estabelecer tom e estilo de comunicação\n3. Listar o que pode e não pode fazer\n4. Incluir instruções sobre como lidar com situações comuns\n5. Ter formatação clara com emojis onde apropriado\n6. Ser escrito em português brasileiro\n\nRetorne APENAS o prompt pronto para ser usado, sem explicações adicionais.`;
                const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + iaApiKey },
                    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: instrucao }], temperature: 0.8, max_tokens: 2048 })
                });
                const data = await resp.json();
                this.geradorResultado = data?.choices?.[0]?.message?.content || data?.error?.message || 'Erro ao gerar.';
            } catch(e) { this.geradorResultado = 'Erro: ' + e.message; }
            this.geradorLoading = false;
        },
        copiarPrompt() { navigator.clipboard.writeText(this.geradorResultado); }
    }));

    // ── IA Transcrição (áudio + imagem) ──
    Alpine.data('iaTranscricao', () => ({
        transcricaoTab: 'audio',
        audioFile: null, audioFileName: '', audioTranscricao: '', audioLoading: false,
        imgFile: null, imgPreview: '', imgTranscricao: '', imgLoading: false,
        async transcreverAudio() {
            if (!this.audioFile) { alert('Selecione um arquivo de áudio.'); return; }
            if (!iaApiKey) { iaTab = 'config'; addNotification('API Key necessária', 'Configure sua chave OpenAI para continuar.', 'info'); return; }
            this.audioLoading = true; this.audioTranscricao = '';
            try {
                const formData = new FormData(); formData.append('file', this.audioFile); formData.append('model', 'whisper-1'); formData.append('language', 'pt');
                const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + iaApiKey }, body: formData });
                const data = await resp.json();
                this.audioTranscricao = data?.text || data?.error?.message || 'Não foi possível transcrever.';
            } catch(e) { this.audioTranscricao = 'Erro: ' + e.message; }
            this.audioLoading = false;
        },
        async transcreverImagem() {
            if (!this.imgFile) { alert('Selecione uma imagem.'); return; }
            if (!iaApiKey) { iaTab = 'config'; addNotification('API Key necessária', 'Configure sua chave OpenAI para continuar.', 'info'); return; }
            this.imgLoading = true; this.imgTranscricao = '';
            try {
                const toBase64 = f => new Promise((res,rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
                const dataUrl = await toBase64(this.imgFile);
                const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + iaApiKey },
                    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: 'Analise esta imagem e extraia todo o texto visível (OCR). Descreva também o conteúdo visual de forma detalhada. Responda em português.' }] }], max_tokens: 2048 })
                });
                const data = await resp.json();
                this.imgTranscricao = data?.choices?.[0]?.message?.content || data?.error?.message || 'Não foi possível analisar.';
            } catch(e) { this.imgTranscricao = 'Erro: ' + e.message; }
            this.imgLoading = false;
        },
        handleAudioFile(e) { const f = e.target.files[0]; if (f) { this.audioFile = f; this.audioFileName = f.name; } },
        handleImgFile(e) { const f = e.target.files[0]; if (f) { this.imgFile = f; const reader = new FileReader(); reader.onload = ev => this.imgPreview = ev.target.result; reader.readAsDataURL(f); } }
    }));

});
