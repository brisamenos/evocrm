// app-disparo.js — Mixin extraído do app.js
function disparoMixin() {
    return {
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

    };
}
