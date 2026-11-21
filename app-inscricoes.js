// ── Inscrições do site ─────────────────────────────────────────────────────────
// Tela do CRM que conecta formulários de sites, mostra os inscritos e configura o
// fluxo que cada inscrito recebe no WhatsApp. A lógica de envio roda no servidor
// (inscricoes.js), então funciona com o CRM fechado.
function inscricoesMixin() {
    const novoId = p => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ETAPA_NOVA = {
        texto:     () => ({ tipo: 'texto', texto: '' }),
        audio:     () => ({ tipo: 'audio', url: '' }),
        imagem:    () => ({ tipo: 'imagem', url: '', legenda: '' }),
        video:     () => ({ tipo: 'video', url: '', legenda: '' }),
        documento: () => ({ tipo: 'documento', url: '', legenda: '', nome_arquivo: '' }),
        botoes:    () => ({ tipo: 'botoes', texto: 'Como posso te ajudar?', opcoes: [{ titulo: '', acao: 'ia', resposta: '', contexto_ia: '' }] }),
        agenda:    () => ({ tipo: 'agenda', texto: '' }),
        menu:      () => ({ tipo: 'menu' }),
    };
    return {
        insAba: 'inscritos',
        insFontes: [],
        insFonteId: '',
        insFonte: null,            // cópia editável da fonte selecionada
        insCarregando: false,
        insSalvando: false,
        insAlterado: false,
        insItens: [], insTotal: 0, insPagina: 1, insPaginas: 1,
        insFiltro: { q: '', status: '', fluxo: '', de: '', ate: '' },
        insAberto: null,           // id da inscrição expandida
        insCodigoVisivel: false,
        insSim: { nome: '', telefone: '', cidade: '' },
        insSimulando: false,
        insUploadIdx: -1,
        insNovaEtapaTipo: 'texto',
        _insBuscaT: null,

        insTiposEtapa: [
            { v: 'texto', l: '💬 Mensagem de texto' }, { v: 'audio', l: '🎤 Áudio (nota de voz)' },
            { v: 'imagem', l: '🖼️ Imagem' }, { v: 'video', l: '🎬 Vídeo' }, { v: 'documento', l: '📄 Documento / PDF' },
            { v: 'botoes', l: '👆 Botões de resposta' }, { v: 'agenda', l: '📅 Horários para agendar' }, { v: 'menu', l: '🧭 Menu com Botões (Automação)' },
        ],
        insStatusOpcoes: [
            { v: 'novo', l: 'Novo' }, { v: 'em_contato', l: 'Em contato' }, { v: 'agendado', l: 'Agendado' },
            { v: 'cliente', l: 'Virou cliente' }, { v: 'descartado', l: 'Descartado' },
        ],
        insFluxoOpcoes: [
            { v: 'agendado', l: 'Na fila' }, { v: 'concluido', l: 'Concluído' }, { v: 'aguardando_clique', l: 'Aguardando clique' },
            { v: 'respondeu', l: 'Cliente respondeu' }, { v: 'interrompido', l: 'Atendente assumiu' }, { v: 'erro', l: 'Erro' },
            { v: 'sem_whatsapp', l: 'Sem WhatsApp' }, { v: 'repetida', l: 'Repetida' }, { v: 'cancelado', l: 'Cancelado' },
        ],

        _insIcons() { setTimeout(() => window.lucide && lucide.createIcons(), 60); },
        async _insApi(caminho, corpo) {
            const opts = corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inst: this.instanceName, ...corpo }) } : {};
            const r = await fetch(caminho, opts);
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d.ok === false) throw new Error(d.error || `Erro ${r.status}`);
            return d;
        },

        async insAbrir() {
            await this.insCarregarFontes();
            if (this.insFonteId) await this.insCarregarLista(1);
            this._insIcons();
        },

        async insCarregarFontes(manterEdicao = false) {
            if (!this.instanceName) return;
            this.insCarregando = true;
            try {
                const d = await this._insApi(`/api/inscricoes/fontes?inst=${encodeURIComponent(this.instanceName)}`);
                this.insFontes = d.fontes || [];
                if (!this.insFontes.some(f => f.id === this.insFonteId)) this.insFonteId = this.insFontes[0]?.id || '';
                if (!manterEdicao || !this.insFonte) this._insSelecionar(this.insFonteId);
                else {
                    // Atualiza só os números e o código, sem perder o que está sendo editado
                    const f = this.insFontes.find(x => x.id === this.insFonteId);
                    if (f && this.insFonte) Object.assign(this.insFonte, { codigo: f.codigo, total: f.total, hoje: f.hoje, erros: f.erros, na_fila: f.na_fila });
                }
            } catch (e) { this.addNotification('Inscrições do site', e.message, 'error'); }
            this.insCarregando = false;
            this._insIcons();
        },

        _insSelecionar(id) {
            const f = this.insFontes.find(x => x.id === id);
            this.insFonteId = f ? f.id : '';
            this.insFonte = f ? JSON.parse(JSON.stringify(f)) : null;
            if (this.insFonte) this.insFonte.config.etapas = (this.insFonte.config.etapas || []).map(e => ({ ...e, _uid: novoId('u') }));
            this.insAlterado = false;
            this.insCodigoVisivel = false;
        },
        async insTrocarFonte(id) {
            if (this.insAlterado && !confirm('Há alterações não salvas nesta fonte. Descartar?')) return;
            this._insSelecionar(id);
            this.insPagina = 1;
            await this.insCarregarLista(1);
        },
        insMarcar() { this.insAlterado = true; },

        async insCriarFonte() {
            const nome = prompt('Nome do site ou formulário (ex.: Site Usucapião):', 'Site Usucapião');
            if (nome === null) return;
            try {
                const d = await this._insApi('/api/inscricoes/fontes', { fonte: { nome: nome.trim() || 'Meu site', ativo: true, config: this.insModeloPadrao() } });
                this.insFonteId = d.id;
                await this.insCarregarFontes();
                this.insAba = 'conexao';
                this.addNotification('Site criado ✅', 'Copie o código de conexão e cole no Admin do site.', 'success', 10000);
            } catch (e) { this.addNotification('Inscrições do site', e.message, 'error'); }
        },

        insModeloPadrao() {
            return {
                atraso_seg: 20, reenvio_dias: 7, parar_se_responder: true, apos_fluxo: 'ia', etiqueta: 'site', notificar: true,
                horario: { ativo: false, inicio: '08:00', fim: '20:00', dias: [1, 2, 3, 4, 5, 6] },
                contexto_ia: 'Este contato se inscreveu no site "{site}" em {data}. Nome: {nome}. Cidade/Estado: {cidade}. Use isso para personalizar o atendimento e não peça de novo dados que ele já informou.',
                etapas: [
                    { id: 'e1', tipo: 'texto', espera_seg: 0, texto: 'Olá, {primeiro_nome}! 👋 Aqui é do escritório do advogado *Levi Farias*. Recebemos sua inscrição pelo site sobre *usucapião*.' },
                    { id: 'e2', tipo: 'botoes', espera_seg: 4, texto: 'Para te atender melhor, como prefere seguir?', opcoes: [
                        { titulo: '📅 Agendar conversa', acao: 'agenda', resposta: '', contexto_ia: '' },
                        { titulo: '💬 Explicar meu caso', acao: 'ia', resposta: '', contexto_ia: 'Peça que ele conte, em poucas palavras, há quanto tempo mora no imóvel e se tem algum documento. Uma pergunta por vez.' },
                        { titulo: '⚖️ Falar c/ advogado', acao: 'humano', resposta: 'Perfeito! Já avisei o Dr. Levi e ele vai te responder por aqui o quanto antes. 🙏', contexto_ia: '' },
                    ] },
                ],
            };
        },

        async insSalvarFonte(silencioso = false) {
            if (!this.insFonte) return false;
            const c = this.insFonte.config;
            for (const [i, e] of c.etapas.entries()) {
                if (['audio', 'imagem', 'video', 'documento'].includes(e.tipo) && !e.url) { this.addNotification('Fluxo', `A mensagem ${i + 1} (${e.tipo}) está sem arquivo.`, 'warn'); return false; }
                if (e.tipo === 'texto' && !String(e.texto || '').trim()) { this.addNotification('Fluxo', `A mensagem ${i + 1} está vazia.`, 'warn'); return false; }
                if (e.tipo === 'botoes' && !(e.opcoes || []).some(o => String(o.titulo || '').trim())) { this.addNotification('Fluxo', `A mensagem ${i + 1} precisa de pelo menos um botão.`, 'warn'); return false; }
            }
            this.insSalvando = true;
            try {
                const fonte = JSON.parse(JSON.stringify({ id: this.insFonte.id, nome: this.insFonte.nome, ativo: this.insFonte.ativo, config: c }));
                fonte.config.etapas = fonte.config.etapas.map(({ _uid, ...e }) => e);
                await this._insApi('/api/inscricoes/fontes', { fonte });
                this.insAlterado = false;
                if (!silencioso) this.addNotification('Inscrições do site', 'Salvo ✅ As próximas inscrições já recebem este fluxo.', 'success');
                const id = this.insFonte.id;
                await this.insCarregarFontes();
                this._insSelecionar(id);
                return true;
            } catch (e) { this.addNotification('Inscrições do site', 'Erro ao salvar: ' + e.message, 'error'); return false; }
            finally { this.insSalvando = false; }
        },

        async insExcluirFonte() {
            if (!this.insFonte) return;
            if (!confirm(`Excluir "${this.insFonte.nome}"? O site deixa de enviar inscrições para o CRM (o código para de funcionar).`)) return;
            const apagar = confirm('Apagar também as inscrições já recebidas desta fonte?\n\nOK = apagar  •  Cancelar = manter o histórico');
            try {
                await this._insApi('/api/inscricoes/fontes/excluir', { id: this.insFonte.id, apagar_inscricoes: apagar });
                this.insFonteId = ''; this.insFonte = null;
                await this.insCarregarFontes();
                await this.insCarregarLista(1);
            } catch (e) { this.addNotification('Inscrições do site', e.message, 'error'); }
        },

        async insTrocarCodigo() {
            if (!this.insFonte) return;
            if (!confirm('Gerar um novo código de conexão?\n\nO código antigo para de funcionar na hora: você vai precisar colar o novo no Admin do site.')) return;
            try {
                await this._insApi('/api/inscricoes/fontes/token', { id: this.insFonte.id });
                await this.insCarregarFontes(true);
                this.insCodigoVisivel = true;
                this.addNotification('Novo código gerado', 'Cole o novo código no Admin do site.', 'warn', 10000);
            } catch (e) { this.addNotification('Inscrições do site', e.message, 'error'); }
        },
        async insCopiarCodigo() {
            const cod = this.insFonte?.codigo || '';
            try { await navigator.clipboard.writeText(cod); this.addNotification('Código copiado', 'Cole no Admin do site → Conexão com o CRM.', 'success'); }
            catch (e) { this.insCodigoVisivel = true; prompt('Copie o código:', cod); }
        },

        // ── etapas do fluxo ──
        insAddEtapa() {
            const nova = { id: novoId('e'), espera_seg: this.insFonte.config.etapas.length ? 3 : 0, _uid: novoId('u'), ...ETAPA_NOVA[this.insNovaEtapaTipo]() };
            this.insFonte.config.etapas.push(nova);
            this.insMarcar(); this._insIcons();
        },
        insRemoverEtapa(i) { this.insFonte.config.etapas.splice(i, 1); this.insMarcar(); },
        insMoverEtapa(i, d) {
            const arr = this.insFonte.config.etapas, k = i + d;
            if (k < 0 || k >= arr.length) return;
            const [x] = arr.splice(i, 1); arr.splice(k, 0, x); this.insMarcar();
        },
        insAddBotao(e) { if ((e.opcoes || []).length < 6) { e.opcoes.push({ titulo: '', acao: 'ia', resposta: '', contexto_ia: '' }); this.insMarcar(); this._insIcons(); } },
        insRemoverBotao(e, j) { e.opcoes.splice(j, 1); this.insMarcar(); },
        insTamanho(t) { return [...String(t || '')].length; },
        insLimitarTitulo(o) { if ([...o.titulo].length > 20) o.titulo = [...o.titulo].slice(0, 20).join(''); this.insMarcar(); },

        // espera exibida em minutos/horas/dias
        insEsperaValor(e) { const s = e.espera_seg || 0; return s % 86400 === 0 && s ? s / 86400 : s % 3600 === 0 && s ? s / 3600 : s % 60 === 0 && s ? s / 60 : s; },
        insEsperaUnidade(e) { const s = e.espera_seg || 0; return s % 86400 === 0 && s ? 'd' : s % 3600 === 0 && s ? 'h' : s % 60 === 0 && s ? 'm' : 's'; },
        insSetEspera(e, valor, unidade) {
            const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unidade] || 1;
            e.espera_seg = Math.max(0, Math.round((parseFloat(valor) || 0) * mult));
            this.insMarcar();
        },
        insDescricaoEspera(s) {
            s = parseInt(s) || 0;
            if (!s) return 'logo em seguida';
            if (s < 60) return `${s} s depois`;
            if (s < 3600) return `${Math.round(s / 60)} min depois`;
            if (s < 86400) return `${+(s / 3600).toFixed(1)} h depois`;
            return `${+(s / 86400).toFixed(1)} dia(s) depois`;
        },
        insToggleDia(di) {
            const a = this.insFonte.config.horario.dias;
            const k = a.indexOf(di);
            if (k >= 0) a.splice(k, 1); else a.push(di);
            this.insMarcar();
        },
        insInserirVar(e, campo, v) { e[campo] = `${e[campo] || ''}${v}`; this.insMarcar(); },

        async insUpload(ev, e, i) {
            const f = ev.target.files?.[0];
            ev.target.value = '';
            if (!f) return;
            if (f.size > 60 * 1024 * 1024) { this.addNotification('Arquivo', 'Arquivo muito grande (máx. 60 MB).', 'warn'); return; }
            this.insUploadIdx = i;
            try {
                const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
                const pasta = this.instanceName.replace(/[^a-zA-Z0-9_-]/g, '_');
                const fd = new FormData();
                fd.append('path', `inscricoes/${pasta}/${e.tipo}_${Date.now()}.${ext}`);
                fd.append('file', f);
                const r = await fetch('/local-upload', { method: 'POST', body: fd });
                const d = await r.json();
                if (!r.ok || !d.url) throw new Error(d.error || 'falha no upload');
                e.url = d.url;
                if (e.tipo === 'documento' && !e.nome_arquivo) e.nome_arquivo = f.name;
                this.insMarcar();
                this.addNotification('Arquivo enviado', 'Clique em "Salvar fluxo" para usar.', 'success');
            } catch (err) { this.addNotification('Arquivo', 'Erro no upload: ' + err.message, 'error'); }
            this.insUploadIdx = -1;
        },

        // ── lista de inscritos ──
        async insCarregarLista(pagina) {
            if (!this.instanceName) return;
            if (pagina) this.insPagina = pagina;
            const p = new URLSearchParams({ inst: this.instanceName, pagina: this.insPagina });
            if (this.insFonteId) p.set('fonte', this.insFonteId);
            for (const k of ['q', 'status', 'fluxo', 'de', 'ate']) if (this.insFiltro[k]) p.set(k, this.insFiltro[k]);
            try {
                const d = await this._insApi(`/api/inscricoes/lista?${p}`);
                this.insItens = d.itens || []; this.insTotal = d.total || 0; this.insPaginas = d.paginas || 1;
            } catch (e) { this.addNotification('Inscrições do site', e.message, 'error'); }
            this._insIcons();
        },
        insBuscar() { clearTimeout(this._insBuscaT); this._insBuscaT = setTimeout(() => this.insCarregarLista(1), 350); },
        insLimparFiltros() { this.insFiltro = { q: '', status: '', fluxo: '', de: '', ate: '' }; this.insCarregarLista(1); },
        insExportar() {
            const p = new URLSearchParams({ inst: this.instanceName });
            if (this.insFonteId) p.set('fonte', this.insFonteId);
            window.open(`/api/inscricoes/exportar?${p}`, '_blank');
        },
        async insAcao(item, acao, valor) {
            if (acao === 'excluir' && !confirm(`Excluir a inscrição de ${item.nome || item.numero}? (o contato continua no CRM)`)) return;
            if (acao === 'reenviar' && !confirm(`Enviar o fluxo de novo para ${item.nome || item.numero}, do começo, com as mensagens atuais?`)) return;
            if (acao === 'cancelar' && !confirm('Cancelar as mensagens que ainda não saíram?')) return;
            try {
                await this._insApi('/api/inscricoes/acao', { id: item.id, acao, valor });
                if (acao === 'status') { item.status = valor; this.addNotification('Inscrição', 'Status atualizado', 'success'); return; }
                if (acao === 'observacao') { this.addNotification('Inscrição', 'Observação salva', 'success'); return; }
                await this.insCarregarLista();
                await this.insCarregarFontes(true);
                if (acao === 'reenviar') this.addNotification('Fluxo', 'Reenvio colocado na fila ✅', 'success');
            } catch (e) { this.addNotification('Inscrição', e.message, 'error'); }
        },
        async insAbrirConversa(item) {
            let lead = (this.leads || []).find(l => l.id === item.lead_id);
            if (!lead && item.lead_id) {
                try { const { data } = await this.client.from('leads').select('*').eq('id', item.lead_id).single(); if (data) { lead = data; this.leads.unshift(data); } } catch (e) {}
            }
            if (!lead) { this.addNotification('Conversa', 'Contato não encontrado no CRM.', 'warn'); return; }
            this.screen = 'chats';
            this.$nextTick(() => this.openChat(lead));
        },
        async insSimular() {
            const tel = String(this.insSim.telefone || '').replace(/\D/g, '');
            if (tel.length < 10) { this.addNotification('Teste', 'Digite o WhatsApp com DDD.', 'warn'); return; }
            if (this.insAlterado && !(await this.insSalvarFonte(true))) return;
            this.insSimulando = true;
            try {
                const r = await this._insApi('/api/inscricoes/simular', { fonte_id: this.insFonteId, nome: this.insSim.nome || 'Teste', telefone: tel, cidade: this.insSim.cidade });
                const msg = r.fluxo_status === 'agendado' ? 'Inscrição de teste criada. O fluxo sai em alguns segundos no WhatsApp informado.'
                    : `Inscrição criada, mas o fluxo não vai sair: ${r.motivo || r.fluxo_status}`;
                this.addNotification('Teste', msg, r.fluxo_status === 'agendado' ? 'success' : 'warn', 12000);
                this.insAba = 'inscritos';
                await this.insCarregarLista(1);
            } catch (e) { this.addNotification('Teste', e.message, 'error'); }
            this.insSimulando = false;
        },

        // ── exibição ──
        insFmtData(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); },
        insFmtFone(n) { const m = String(n || '').replace(/\D/g, '').match(/^55(\d{2})(\d{4,5})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || ''); },
        insCorFluxo(s) {
            return ({ agendado: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300', enviando: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
                concluido: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', aguardando_clique: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
                respondeu: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300', interrompido: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
                erro: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', sem_whatsapp: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' }[s])
                || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
        },
        insProgresso(item) {
            if (!item.total_etapas) return '';
            const p = Math.min(item.fluxo_passo || 0, item.total_etapas);
            return `${p}/${item.total_etapas} mensagens`;
        },
        insOnWs(msg) {
            if (msg.type !== 'inscricoes') return;
            if (msg.event === 'nova') {
                this.addNotification('📝 Nova inscrição do site', msg.nome || 'Novo inscrito', 'success', 8000);
                try { this.playSound(); } catch (e) {}
            }
            if (this.screen === 'inscricoes') {
                clearTimeout(this._insWsT);
                this._insWsT = setTimeout(() => { this.insCarregarLista(); this.insCarregarFontes(true); }, 600);
            }
        },
    };
}
