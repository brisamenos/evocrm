// ── Menu interativo com botões (boas-vindas por áudio + botões) ──
// A lógica roda no servidor (server.js → fluxoProcessar). Aqui só fica a configuração.
function fluxoBotoesMixin() {
    const novoId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const vazio = () => ({ ativo: false, audio_url: '', texto_boas_vindas: '', delay_seg: 2, formato: 'botoes', rodape: '',
                          ao_digitar: 'ia', palavra_menu: 'menu', etapa_inicial: 'inicio', etapas: [] });
    return {
        fbCfg: vazio(),
        fbCarregado: false,
        fbSalvando: false,
        fbEnviandoAudio: false,
        fbTesteNumero: '',
        fbTestando: false,

        async fbCarregar() {
            if (!this.instanceName) return;
            try {
                const r = await fetch(`/api/fluxo-botoes?inst=${encodeURIComponent(this.instanceName)}`);
                const d = await r.json();
                if (d.config) this.fbCfg = { ...vazio(), ...d.config };
                this.fbCarregado = true;
            } catch (e) { this.addNotification('Menu com botões', 'Não foi possível carregar: ' + e.message, 'error'); }
            setTimeout(() => window.lucide && lucide.createIcons(), 60);
        },

        async fbSalvar(silencioso = false) {
            const c = this.fbCfg;
            for (const e of c.etapas) {
                for (const o of e.opcoes) {
                    if (o.acao === 'etapa' && !c.etapas.some(x => x.id === o.destino)) {
                        this.addNotification('Menu com botões', `O botão "${o.titulo || 'sem nome'}" manda para uma etapa que não existe. Escolha a etapa.`, 'warn');
                        return false;
                    }
                }
            }
            if (c.ativo && !c.etapas.length && !c.audio_url && !String(c.texto_boas_vindas || '').trim()) {
                this.addNotification('Menu com botões', 'Adicione o áudio, a mensagem ou pelo menos uma etapa com botões.', 'warn');
                return false;
            }
            this.fbSalvando = true;
            try {
                const r = await fetch('/api/fluxo-botoes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ inst: this.instanceName, config: c }) });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'erro');
                this.fbCfg = { ...vazio(), ...d.config };
                if (!silencioso) this.addNotification('Menu com botões', c.ativo ? 'Salvo e ativo ✅' : 'Salvo (desativado)', 'success');
                return true;
            } catch (e) { this.addNotification('Menu com botões', 'Erro ao salvar: ' + e.message, 'error'); return false; }
            finally { this.fbSalvando = false; setTimeout(() => window.lucide && lucide.createIcons(), 60); }
        },

        fbToggle() { this.fbCfg.ativo = !this.fbCfg.ativo; this.fbSalvar(); },

        fbAddEtapa() {
            const id = this.fbCfg.etapas.length ? novoId('etapa_') : 'inicio';
            this.fbCfg.etapas.push({ id, nome: this.fbCfg.etapas.length ? `Etapa ${this.fbCfg.etapas.length + 1}` : 'Menu inicial', texto: '', botao_lista: 'Ver opções', opcoes: [] });
            if (this.fbCfg.etapas.length === 1) this.fbCfg.etapa_inicial = id;
            this.fbAddOpcao(this.fbCfg.etapas[this.fbCfg.etapas.length - 1]);
        },
        fbRemoverEtapa(i) {
            const e = this.fbCfg.etapas[i];
            if (!confirm(`Remover a etapa "${e.nome || e.id}"?`)) return;
            this.fbCfg.etapas.splice(i, 1);
            this.fbCfg.etapas.forEach(x => x.opcoes.forEach(o => { if (o.destino === e.id) { o.acao = 'ia'; o.destino = ''; } }));
            if (this.fbCfg.etapa_inicial === e.id) this.fbCfg.etapa_inicial = this.fbCfg.etapas[0]?.id || '';
        },
        fbAddOpcao(etapa) {
            if (etapa.opcoes.length >= 10) return;
            etapa.opcoes.push({ id: novoId('op_'), titulo: '', descricao: '', acao: 'ia', destino: '', resposta: '', contexto_ia: '' });
            setTimeout(() => window.lucide && lucide.createIcons(), 60);
        },
        fbRemoverOpcao(etapa, j) { etapa.opcoes.splice(j, 1); },
        fbMoverOpcao(etapa, j, d) {
            const k = j + d;
            if (k < 0 || k >= etapa.opcoes.length) return;
            const [o] = etapa.opcoes.splice(j, 1); etapa.opcoes.splice(k, 0, o);
        },
        fbNomeEtapa(id) { const e = this.fbCfg.etapas.find(x => x.id === id); return e ? (e.nome || e.id) : '—'; },

        async fbUploadAudio(ev) {
            const f = ev.target.files?.[0];
            ev.target.value = '';
            if (!f) return;
            if (f.size > 16 * 1024 * 1024) { this.addNotification('Áudio', 'Arquivo muito grande (máx. 16 MB).', 'warn'); return; }
            this.fbEnviandoAudio = true;
            try {
                const ext = (f.name.split('.').pop() || 'ogg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'ogg';
                const pasta = this.instanceName.replace(/[^a-zA-Z0-9_-]/g, '_');
                const fd = new FormData();
                fd.append('path', `fluxo_botoes/${pasta}/boas_vindas_${Date.now()}.${ext}`);
                fd.append('file', f);
                const r = await fetch('/local-upload', { method: 'POST', body: fd });
                const d = await r.json();
                if (!r.ok || !d.url) throw new Error(d.error || 'falha no upload');
                this.fbCfg.audio_url = d.url;
                const salvou = await this.fbSalvar(true);
                if (!salvou) throw new Error('o arquivo subiu, mas o menu não foi salvo. Corrija o aviso acima e clique em "Salvar menu".');
                const conf = await (await fetch(`/api/fluxo-botoes?inst=${encodeURIComponent(this.instanceName)}`)).json();
                if (!conf?.config?.audio_url) throw new Error('o servidor não guardou o áudio. Tente de novo.');
                this.addNotification('Áudio de boas-vindas', 'Áudio salvo no menu ✅ Ele vai como mensagem de voz.', 'success');
            } catch (e) { this.addNotification('Áudio', 'Erro no upload: ' + e.message, 'error'); }
            this.fbEnviandoAudio = false;
        },
        fbAudioPlayer(url) { return url ? `/api/audio?src=${encodeURIComponent(url)}` : ''; },
        async fbRemoverAudio() { this.fbCfg.audio_url = ''; await this.fbSalvar(true); },

        async fbTestar() {
            const n = String(this.fbTesteNumero || '').replace(/\D/g, '');
            if (n.length < 10) { this.addNotification('Testar menu', 'Digite o número com DDD.', 'warn'); return; }
            if (!(await this.fbSalvar(true))) return;
            this.fbTestando = true;
            try {
                const r = await fetch('/api/fluxo-botoes/testar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ inst: this.instanceName, numero: n }) });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || 'erro');
                if (d.avisos && d.avisos.length) this.addNotification('Testar menu — atenção', d.avisos.join(' • '), 'warn', 15000);
                else this.addNotification('Testar menu', 'Enviado! Abra o WhatsApp desse número e toque nos botões.', 'success');
            } catch (e) { this.addNotification('Testar menu', e.message, 'error'); }
            this.fbTestando = false;
        },

        fbModeloLevi() {
            if (this.fbCfg.etapas.length && !confirm('Substituir as etapas atuais pelo modelo do Dr. Levi Farias? O áudio que você enviou é mantido.')) return;
            this.fbCfg = {
                ...this.fbCfg,
                formato: 'botoes',
                delay_seg: 3,
                ao_digitar: 'ia',
                palavra_menu: 'menu',
                rodape: 'Dr. Levi Farias • OAB/CE 44.641',
                // Curto de propósito: o áudio já apresenta o Dr. Levi; o texto vai junto com os botões (1 mensagem só)
                texto_boas_vindas: '',
                etapa_inicial: 'inicio',
                etapas: [
                    {
                        id: 'inicio', nome: 'Menu inicial', botao_lista: 'Ver opções',
                        texto: 'Olá, {nome}! 👋 Aqui é o atendimento do advogado *Levi Farias* (OAB/CE 44.641), especialista em atraso na entrega de imóveis.\n\nComo posso te ajudar? Toque em uma opção ou me conte o que aconteceu 👇',
                        opcoes: [
                            { id: 'atraso', titulo: '🏗️ Atraso na entrega', descricao: '', acao: 'ia', destino: '', resposta: '',
                              contexto_ia: 'Situação: atraso na entrega do imóvel. Responda em no máximo 2 frases curtas: acolha e peça que ele conte o que aconteceu. Uma pergunta só.' },
                            { id: 'recuperar', titulo: '💰 Recuperar dinheiro', descricao: '', acao: 'ia', destino: '', resposta: '',
                              contexto_ia: 'Situação: o cliente pensa em encerrar o contrato e recuperar o que pagou. Em no máximo 2 frases, acolha e pergunte o que aconteceu, sem induzir a decisão.' },
                            { id: 'agendar', titulo: 'Agendar atendimento', descricao: '', acao: 'agenda', destino: '', resposta: '', contexto_ia: '' },
                        ],
                    },
                ],
            };
            this.addNotification('Modelo carregado', 'Revise o texto, envie o áudio e clique em Salvar menu.', 'info');
            setTimeout(() => window.lucide && lucide.createIcons(), 60);
        },
    };
}
