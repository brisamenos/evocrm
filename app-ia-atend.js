// app-ia-atend.js — Mixin extraído do app.js
function iaAtendMixin() {
    return {
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

    };
}
