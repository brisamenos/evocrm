// app-autoreply.js — Mixin extraído do app.js
function autoReplyMixin() {
    return {
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

    };
}
