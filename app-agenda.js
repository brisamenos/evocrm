// app-agenda.js — Mixin extraído do app.js
function agendaMixin() {
    return {
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

    };
}
