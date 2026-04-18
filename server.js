// -*- coding: utf-8 -*-
process.stdout.setEncoding && process.stdout.setEncoding("utf8");
/**
 * IA WORKER - CRM EVO
 * Servidor Node.js que roda 24/7 no EasyPanel
 * Escuta Supabase Realtime e responde clientes com OpenAI automaticamente
 */

const db = require('./db.js');
const { initDb } = require('./db.js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');


// ─── STORAGE LOCAL (salva arquivos no disco do container) ─────────────────────
// Os arquivos ficam em /app/uploads/ e são servidos em /uploads/*
// Configure um Volume Persistente no EasyPanel apontando para /app/uploads
// para que os arquivos sobrevivam a reinicializações do container.
//
// EasyPanel → Services → seu-server → Volumes → Add Volume
//   Host Path:      uploads_data   (named volume)
//   Container Path: /app/uploads
// ─────────────────────────────────────────────────────────────────────────────
const fsSync = require('fs');
const pathMod = require('path');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || 'https://sites-crm.xtknqq.easypanel.host';

// Garante que a pasta existe ao iniciar
if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log(`📁 [Storage] Pasta criada: ${UPLOADS_DIR}`);
}

// Subpastas organizadas por tipo (criadas sob demanda)
function ensureDir(subpath) {
    const full = pathMod.join(UPLOADS_DIR, subpath);
    if (!fsSync.existsSync(full)) fsSync.mkdirSync(full, { recursive: true });
    return full;
}

// Salva um Buffer no disco e retorna a URL pública
function localSave(subpath, fileName, buffer) {
    ensureDir(subpath);
    const filePath = pathMod.join(UPLOADS_DIR, subpath, fileName);
    fsSync.writeFileSync(filePath, buffer);
    const url = `${SERVER_PUBLIC_URL}/uploads/${subpath}/${fileName}`;
    console.log(`💾 [Storage] Salvo: ${filePath} → ${url}`);
    return url;
}

// ─── GERADOR DE CSV ───────────────────────────────────────────────────────────
function gerarCSV(dados, campos) {
    const header = campos.join(',');
    const rows = dados.map(row =>
        campos.map(c => {
            const val = row[c] ?? '';
            const str = String(val).replace(/"/g, '""');
            return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
        }).join(',')
    );
    return [header, ...rows].join('\n');
}

// ─── CACHE DE AVATARES ────────────────────────────────────────────────────────
// Baixa e salva localmente a foto de perfil do WhatsApp.
// Retorna URL local se já em cache (< 24h) ou null se indisponível.
async function fetchAndCacheAvatar(inst, number) {
    const safeName = number.replace(/[^0-9]/g, '');
    const fileName = `${safeName}.jpg`;
    const localPath = pathMod.join(UPLOADS_DIR, 'avatares', fileName);

    // Cache válido por 24h
    if (fsSync.existsSync(localPath)) {
        const ageHours = (Date.now() - fsSync.statSync(localPath).mtime.getTime()) / 3600000;
        if (ageHours < 24) return `${SERVER_PUBLIC_URL}/uploads/avatares/${fileName}`;
    }

    // Busca URL da foto na Evolution API
    let picUrl = null;
    try {
        const r = await fetch(`${EVO_URL}/chat/fetchProfilePictureUrl/${inst}`, {
            method: 'POST',
            headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ number })
        });
        if (r.ok) {
            const d = await r.json().catch(() => ({}));
            picUrl = d.profilePictureUrl || d.pictureUrl || d.picture || d.url || null;
        }
        // Fallback GET
        if (!picUrl) {
            const rg = await fetch(`${EVO_URL}/chat/fetchProfilePictureUrl/${inst}?number=${number}`, {
                headers: { 'apikey': EVO_KEY }
            });
            if (rg.ok) {
                const dg = await rg.json().catch(() => ({}));
                picUrl = dg.profilePictureUrl || dg.pictureUrl || dg.picture || dg.url || null;
            }
        }
    } catch(e) { return null; }

    if (!picUrl) return null;

    // Faz download e salva em disco
    try {
        const imgRes = await fetch(picUrl);
        if (!imgRes.ok) return null;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        localSave('avatares', fileName, buf);
        console.log(`🖼️ [Avatar] Cache salvo: ${number}`);
        return `${SERVER_PUBLIC_URL}/uploads/avatares/${fileName}`;
    } catch(e) {
        console.error('[Avatar] Erro ao salvar:', e.message);
        return null;
    }
}

// ─── BACKUP AUTOMÁTICO ────────────────────────────────────────────────────────
// Exporta tabelas críticas do Supabase para JSON no disco.
// Mantém os últimos 7 backups e remove os mais antigos.
const BACKUP_TABELAS = ['leads', 'agendamentos_crm', 'ia_config', 'licenses', 'auto_replies'];

async function executarBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultado = {};
    let totalRegistros = 0;

    for (const tabela of BACKUP_TABELAS) {
        try {
            const { data } = await db.from(tabela).select('*');
            resultado[tabela] = data || [];
            totalRegistros += (data || []).length;
            console.log(`💾 [Backup] ${tabela}: ${(data || []).length} registros`);
        } catch(e) {
            console.warn(`⚠️ [Backup] Falha em ${tabela}: ${e.message}`);
        }
    }

    const fileName = `backup_${timestamp}.json`;
    const buffer = Buffer.from(JSON.stringify({ gerado_em: new Date().toISOString(), tabelas: resultado }, null, 2), 'utf8');
    const url = localSave('backups', fileName, buffer);

    // Remove backups excedentes — mantém apenas os 7 mais recentes
    try {
        const dir = pathMod.join(UPLOADS_DIR, 'backups');
        const arquivos = fsSync.readdirSync(dir)
            .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
            .map(f => ({ name: f, time: fsSync.statSync(pathMod.join(dir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
        for (const f of arquivos.slice(7)) {
            fsSync.unlinkSync(pathMod.join(dir, f.name));
            console.log(`🗑️ [Backup] Removido backup antigo: ${f.name}`);
        }
    } catch(e) {}

    console.log(`✅ [Backup] Concluído: ${url} (${totalRegistros} registros totais)`);
    return { url, timestamp, totalRegistros, tabelas: Object.keys(resultado).map(t => ({ tabela: t, registros: resultado[t].length })) };
}

// Parser de multipart simples (para o endpoint /local-upload)
function parseMultipart(buffer, boundary) {
    const sep = Buffer.from('--' + boundary);
    const parts = [];
    let pos = 0;
    while (pos < buffer.length) {
        const start = buffer.indexOf(sep, pos);
        if (start === -1) break;
        pos = start + sep.length;
        if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
        if (buffer[pos] === 0x0d) pos += 2;
        const headerEnd = buffer.indexOf('\r\n\r\n', pos);
        if (headerEnd === -1) break;
        const rawHeaders = buffer.slice(pos, headerEnd).toString();
        pos = headerEnd + 4;
        const nextSep = buffer.indexOf(sep, pos);
        const bodyEnd = nextSep === -1 ? buffer.length : nextSep - 2;
        const body = buffer.slice(pos, bodyEnd);
        pos = nextSep === -1 ? buffer.length : nextSep;
        const disp = rawHeaders.split('\r\n').find(l => l.toLowerCase().includes('content-disposition')) || '';
        const nameMatch = disp.match(/name="([^"]+)"/);
        const fileMatch = disp.match(/filename="([^"]+)"/);
        const ctLine = rawHeaders.split('\r\n').find(l => l.toLowerCase().startsWith('content-type:'));
        const ct = ctLine ? ctLine.split(':')[1].trim() : 'application/octet-stream';
        parts.push({ name: nameMatch?.[1] || '', filename: fileMatch?.[1] || '', contentType: ct, data: body });
    }
    return parts;
}

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────
const EVO_URL = process.env.EVO_URL || 'http://projeto-evolution-api:8080';
const EVO_KEY = process.env.EVO_KEY || '429683C4C977415CAAFCCE10F7D57E11';
const PORT    = process.env.PORT          || 3000;

// ─── MERCADO PAGO: tokens armazenados no Supabase (admin_config) ─────────────
const MP_DEFAULTS = {
    mp_access_token: process.env.MP_ACCESS_TOKEN || '',
    mp_public_key:   process.env.MP_PUBLIC_KEY   || '',
};

async function seedMpConfig() {
    for (const [key, value] of Object.entries(MP_DEFAULTS)) {
        try {
            const { data: existing } = await db.from('admin_config').select('key').eq('key', key).single();
            if (!existing) {
                await db.from('admin_config').insert({ key, value });
                console.log('✅ [MP] admin_config.' + key + ' inserido no Supabase');
            }
        } catch(e) {
            try { await db.from('admin_config').insert({ key, value }); } catch(e) {}
        }
    }
}

const _mpCache = {};
async function getMpConfig(key) {
    const agora = Date.now();
    if (_mpCache[key] && (agora - _mpCache[key].at) < 5 * 60 * 1000) return _mpCache[key].value;
    // 1. Variável de ambiente
    const envKey = key.toUpperCase();
    if (process.env[envKey]) { _mpCache[key] = { value: process.env[envKey], at: agora }; return _mpCache[key].value; }
    // 2. Supabase admin_config
    try {
        const { data } = await db.from('admin_config').select('value').eq('key', key).single();
        if (data?.value) { _mpCache[key] = { value: data.value, at: agora }; return _mpCache[key].value; }
    } catch(e) { console.error('[MercadoPago] Falha ao buscar ' + key + ' do Supabase: ' + e.message); }
    // 3. Fallback direto: MP_DEFAULTS em memória
    if (MP_DEFAULTS[key]) {
        console.log('[MercadoPago] Usando fallback MP_DEFAULTS para ' + key);
        _mpCache[key] = { value: MP_DEFAULTS[key], at: agora };
        return MP_DEFAULTS[key];
    }
    return null;
}

// Garante token síncrono sempre disponível (nunca null em produção)
function getMpTokenSync() { return process.env.MP_ACCESS_TOKEN || MP_DEFAULTS.mp_access_token; }
function getMpPublicKeySync() { return process.env.MP_PUBLIC_KEY || MP_DEFAULTS.mp_public_key; }

const getMpToken     = async () => (await getMpConfig('mp_access_token')) || getMpTokenSync();
const getMpPublicKey = async () => (await getMpConfig('mp_public_key'))   || getMpPublicKeySync();


// ─── ESTADO GLOBAL (por instância) ───────────────────────────────────────────
const state = {};

function getState(inst) {
    if (!state[inst]) {
        state[inst] = {
            config:      null, // ia_config do Supabase
            features:    {},   // features da licença { agenda, ia_atendimento, audio_ia, ... }
            leads:       {},
            bufferMsgs:  {},
            bufferTimers:{},
            humanoAtivo: {},
            humanoTimers:{},
            respondendo: {},
            midias:      [],
            msgRateTracker: {}, // { leadId: [timestamps] } — detecta loop de bot
        };
    }
    return state[inst];
}

// ─── FEATURES DA LICENÇA ─────────────────────────────────────────────────────
const PLANO_FEATURES = {
    basico:   { bot:true, disparo:false, agenda:false, setores:false, ia_atendimento:false, audio_ia:false },
    premium:  { bot:true, disparo:true,  agenda:true,  setores:true,  ia_atendimento:false, audio_ia:false },
    platinum: { bot:true, disparo:true,  agenda:true,  setores:true,  ia_atendimento:true,  audio_ia:true  },
};
// Default liberal — instâncias sem licença explícita não são bloqueadas
const FEATURES_DEFAULT = { bot:true, disparo:true, agenda:true, setores:true, ia_atendimento:true, audio_ia:false };

async function carregarFeatures(inst) {
    const s = getState(inst);
    try {
        const { data } = await db
            .from('licenses')
            .select('features, plano')
            .eq('instance_name', inst)
            .eq('status', 'active')
            .single();
        if (!data) {
            log(inst, 'warn', '[Features] Sem licença ativa — usando defaults (tudo liberado exceto audio_ia)');
            s.features = { ...FEATURES_DEFAULT };
            return;
        }
        // features explícitas {id: bool} têm prioridade sobre o plano
        if (data.features && typeof data.features === 'object' && !Array.isArray(data.features)) {
            s.features = { ...FEATURES_DEFAULT, ...data.features };
        } else {
            s.features = { ...FEATURES_DEFAULT, ...(PLANO_FEATURES[data.plano] || {}) };
        }
        log(inst, 'ok', `[Features] plano=${data.plano} | ia=${s.features.ia_atendimento} | agenda=${s.features.agenda} | audio=${s.features.audio_ia}`);
    } catch(e) {
        log(inst, 'warn', `[Features] Erro: ${e.message} — usando defaults`);
        s.features = { ...FEATURES_DEFAULT };
    }
}

function temFeature(inst, featureId) {
    return getState(inst).features?.[featureId] === true;
}

// ─── AGENDA IA ───────────────────────────────────────────────────────────────
function normalizarDH(dh) {
    if (!dh) return '';
    return dh.replace('Z','').replace(/\.\d+/,'').replace(/[+-]\d{2}:\d{2}$/,'').slice(0,16);
}

function agSlotsLivres(cfg, dataStr) {
    const d = new Date(dataStr + 'T12:00:00');
    if (!cfg.dias_semana[String(d.getDay())]) return [];
    const [hI,mI]=cfg.horario_inicio.split(':').map(Number);
    const [hF,mF]=cfg.horario_fim.split(':').map(Number);
    const [hAI,mAI]=cfg.almoco_inicio.split(':').map(Number);
    const [hAF,mAF]=cfg.almoco_fim.split(':').map(Number);
    const slots=[]; let cur=hI*60+mI; const fim=hF*60+mF; const dur=cfg.duracao_slot||60;
    while (cur+dur<=fim) {
        const emAlmoco=cfg.almoco_ativo&&cur>=hAI*60+mAI&&cur<hAF*60+mAF;
        if (!emAlmoco) slots.push(`${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`);
        cur+=dur;
    }
    return slots;
}

function agSlotOcupado(ags, dataStr, horaStr) {
    return ags.some(a => {
        if (a.sent||(a.status&&a.status!=='ativo')) return false;
        return normalizarDH(a.data_hora||a.dataHora).startsWith(`${dataStr}T${horaStr}`);
    });
}

function agMaxDia(cfg, ags, dataStr) {
    const count=ags.filter(a=>!a.sent&&(!a.status||a.status==='ativo')&&normalizarDH(a.data_hora||a.dataHora).slice(0,10)===dataStr).length;
    return count>=(cfg.max_por_dia||8);
}

function agSlotDisponivel(cfg, ags, dataStr, horaStr) {
    if (!cfg.dias_semana[String(new Date(dataStr+'T12:00:00').getDay())]) return false;
    if (agMaxDia(cfg,ags,dataStr)) return false;
    const slots=agSlotsLivres(cfg,dataStr); if (!slots.length) return false;
    const [hR,mR]=horaStr.split(':').map(Number); const minR=hR*60+mR; const dur=cfg.duracao_slot||60;
    const slot=slots.find(s=>{const [hs,ms]=s.split(':').map(Number);const minS=hs*60+ms;return minR>=minS&&minR<minS+dur;});
    return slot?!agSlotOcupado(ags,dataStr,slot):false;
}

function agProximos(cfg, ags, de, qtd=5) {
    const livres=[]; const pad=n=>String(n).padStart(2,'0');
    const toStr=dt=>`${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
    let d=new Date(de); d.setSeconds(0,0);
    for (let i=0;i<60&&livres.length<qtd;i++) {
        const ds=toStr(d);
        if (!agMaxDia(cfg,ags,ds)) {
            for (const slot of agSlotsLivres(cfg,ds)) {
                if (livres.length>=qtd) break;
                if (!agSlotOcupado(ags,ds,slot)) {
                    const [hs,ms]=slot.split(':').map(Number);
                    const dt2=new Date(ds+'T12:00:00'); dt2.setHours(hs,ms,0,0);
                    if (dt2>de) livres.push({data:ds,hora:slot,dt:dt2});
                }
            }
        }
        d.setDate(d.getDate()+1); d.setHours(0,0,0,0);
    }
    return livres;
}

function fmtDT(dataStr, horaStr) {
    try { return new Date(dataStr+'T'+horaStr).toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit'}); }
    catch(e) { return `${dataStr} às ${horaStr}`; }
}

async function agendaPreCheck(inst, lead, mensagemTexto, histMsgs, apiKey) {
    if (!temFeature(inst,'agenda')) {
        log(inst,'info','[Agenda] Feature agenda não ativa — pulando');
        return { agendaContexto:'', agendaAcaoPendente:null };
    }
    let cfg;
    try {
        const {data} = await db.from('agenda_config').select('*').eq('instance_name',inst).single();
        if (!data||!data.ia_verificar) {
            log(inst,'info','[Agenda] ia_verificar desativado — pulando');
            return { agendaContexto:'', agendaAcaoPendente:null };
        }
        cfg = {
            dias_semana:    data.dias_semana    ||{'1':true,'2':true,'3':true,'4':true,'5':true},
            horario_inicio: data.horario_inicio ||'08:00',
            horario_fim:    data.horario_fim    ||'18:00',
            duracao_slot:   data.duracao_slot   ||60,
            almoco_ativo:   data.almoco_ativo   ??false,
            almoco_inicio:  data.almoco_inicio  ||'12:00',
            almoco_fim:     data.almoco_fim     ||'13:00',
            max_por_dia:    data.max_por_dia    ||8,
        };
    } catch(e) { return { agendaContexto:'', agendaAcaoPendente:null }; }

    let ags=[];
    try { const {data}=await db.from('agendamentos_crm').select('*').eq('instance_name',inst).eq('sent',false).eq('status','ativo'); ags=data||[]; } catch(e) {}

    const leadName=getLeadName(lead);
    const agsPend=ags.filter(a=>a.lead_id===lead.id);
    const ultimaIA=(histMsgs||[]).filter(m=>m.from_me).slice(-1)[0]?.content||'';

    let intent={};
    try {
        const res=await fetch('https://api.openai.com/v1/chat/completions',{
            method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
            body:JSON.stringify({model:'gpt-4o-mini',temperature:0,max_tokens:200,messages:[{
                role:'system',
                content:`Analise a mensagem e retorne APENAS JSON sem markdown:
{"tipo":"agendamento_com_data"|"agendamento_sem_data"|"escolha_horario"|"cancelamento"|"reagendamento"|"outro","data_hora":"YYYY-MM-DDTHH:MM ou null","nova_data_hora":"YYYY-MM-DDTHH:MM ou null"}`
            },{role:'user',content:`Msg cliente: "${mensagemTexto}"\nMsg anterior IA: "${ultimaIA.substring(0,200)}"\nData atual: ${new Date().toISOString()}\nAgendamentos: ${JSON.stringify(agsPend.map(a=>({dh:normalizarDH(a.data_hora||a.dataHora)})))}`}]})
        });
        const d=await res.json();
        intent=JSON.parse((d?.choices?.[0]?.message?.content||'{}').replace(/```json|```/g,'').trim());
    } catch(e) { log(inst,'warn',`[Agenda] Falha intent: ${e.message}`); return {agendaContexto:'',agendaAcaoPendente:null}; }

    log(inst,'info',`[Agenda] intent: tipo="${intent.tipo}" | dh="${intent.data_hora}"`);

    let agendaContexto='', agendaAcaoPendente=null;

    if ((intent.tipo==='agendamento_com_data'||intent.tipo==='escolha_horario')&&intent.data_hora) {
        const dh=normalizarDH(intent.data_hora), ds=dh.slice(0,10), hs=dh.slice(11,16);
        if (agSlotDisponivel(cfg,ags,ds,hs)) {
            const dtF=fmtDT(ds,hs);
            agendaContexto=`SISTEMA DE AGENDA:\nHorário ${dtF}: ✅ DISPONÍVEL.\nAÇÃO: Confirme o agendamento de forma amigável.\nSINALIZAÇÃO: coloque ##AGENDA_CONFIRMADA## ao final da resposta.`;
            agendaAcaoPendente={tipo:'agendar',dataHora:dh,descricao:`Agendamento — ${leadName}`};
            log(inst,'info',`[Agenda] ✅ Slot ${dh} disponível — pendente`);
        } else {
            const alts=agProximos(cfg,ags,new Date(),3);
            const opts=alts.length?alts.map(a=>fmtDT(a.data,a.hora)).join(', '):'sem horários nos próximos dias';
            agendaContexto=`SISTEMA DE AGENDA:\nHorário ${fmtDT(ds,hs)}: ❌ INDISPONÍVEL.\nAÇÃO: Informe e ofereça alternativas: ${opts}.\nNÃO use ##AGENDA_CONFIRMADA##.`;
            log(inst,'info',`[Agenda] ❌ Slot ${dh} indisponível`);
        }
    } else if (intent.tipo==='agendamento_sem_data'||(intent.tipo==='agendamento_com_data'&&!intent.data_hora)) {
        const prox=agProximos(cfg,ags,new Date(),5);
        const opts=prox.length?prox.map(a=>fmtDT(a.data,a.hora)).join(', '):'Nenhum horário disponível';
        agendaContexto=`SISTEMA DE AGENDA:\nCliente quer agendar. Horários disponíveis: ${opts}.\nAÇÃO: Apresente e pergunte qual prefere. NÃO use ##AGENDA_CONFIRMADA## ainda.`;
    } else if (intent.tipo==='cancelamento') {
        if (agsPend.length>0) {
            const ag=agsPend[0], dh=normalizarDH(ag.data_hora||ag.dataHora), dtF=fmtDT(dh.slice(0,10),dh.slice(11,16));
            agendaContexto=`SISTEMA DE AGENDA:\nCliente quer cancelar agendamento de ${dtF}.\nAÇÃO: Confirme o cancelamento.\nSINALIZAÇÃO: coloque ##AGENDA_CANCELADA## ao final.`;
            agendaAcaoPendente={tipo:'cancelar',agId:ag.id,dtFormatada:dtF};
        } else {
            agendaContexto=`SISTEMA DE AGENDA:\nNenhum agendamento ativo para cancelar. Informe de forma amigável.`;
        }
    } else if (intent.tipo==='reagendamento'&&intent.nova_data_hora) {
        const novaDH=normalizarDH(intent.nova_data_hora), nDs=novaDH.slice(0,10), nHs=novaDH.slice(11,16);
        if (agsPend.length>0) {
            const agR=agsPend[0], dhAnt=normalizarDH(agR.data_hora||agR.dataHora), dtAF=fmtDT(dhAnt.slice(0,10),dhAnt.slice(11,16));
            if (agSlotDisponivel(cfg,ags,nDs,nHs)) {
                agendaContexto=`SISTEMA DE AGENDA:\nReagendamento de ${dtAF} para ${fmtDT(nDs,nHs)}: ✅ DISPONÍVEL.\nAÇÃO: Confirme.\nSINALIZAÇÃO: coloque ##AGENDA_CONFIRMADA## ao final.`;
                agendaAcaoPendente={tipo:'reagendar',ag:agR,novaDataHora:novaDH};
            } else {
                const alts=agProximos(cfg,ags,new Date(),3);
                const opts=alts.length?alts.map(a=>fmtDT(a.data,a.hora)).join(', '):'sem horários';
                agendaContexto=`SISTEMA DE AGENDA:\nNovo horário ${fmtDT(nDs,nHs)}: ❌ INDISPONÍVEL.\nAÇÃO: Ofereça: ${opts}. NÃO use ##AGENDA_CONFIRMADA##.`;
            }
        } else {
            agendaContexto=`SISTEMA DE AGENDA:\nNenhum agendamento para reagendar. Pergunte se quer novo agendamento.`;
        }
    }

    return {agendaContexto, agendaAcaoPendente};
}

async function agendaExecutar(inst, lead, pendente, iaTexto) {
    if (!pendente) return;
    const confirmou   = iaTexto.includes('##AGENDA_CONFIRMADA##');
    const cancelouTag = iaTexto.includes('##AGENDA_CANCELADA##');
    const leadName = getLeadName(lead);

    if (pendente.tipo==='cancelar'&&!cancelouTag) { log(inst,'warn','[Agenda] ##AGENDA_CANCELADA## ausente — ação abortada'); return; }
    if (pendente.tipo!=='cancelar'&&!confirmou)  { log(inst,'warn','[Agenda] ##AGENDA_CONFIRMADA## ausente — ação abortada'); return; }

    try {
        if (pendente.tipo==='agendar') {
            const {error}=await db.from('agendamentos_crm').insert({
                instance_name:inst, lead_id:lead.id, numero:lead.numero,
                tipo:'simples', texto:pendente.descricao, data_hora:pendente.dataHora,
                sent:false, criado_por_ia:true, status:'ativo',
            });
            if (error) throw new Error(error.message);
            const dtF=new Date(pendente.dataHora.replace('T',' ')).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
            await db.from('dash_notifs').insert({instance_name:inst,title:`📅 Agendamento criado pela IA`,body:`${leadName}: ${dtF}`,type:'success',read:false,criado_por_ia:true,lead_id:lead.id});
            await db.from('dash_tasks').insert({instance_name:inst,title:`Agendamento: ${leadName}`,"desc": `Agendamento para ${dtF}.\nCliente: ${leadName} (${lead.numero})`,priority:'media',tag:'agenda',done:false,criado_por_ia:true,lead_id:lead.id});
            log(inst,'ok',`[Agenda] ✅ Agendamento + notif + tarefa criados — ${leadName}: ${pendente.dataHora}`);

        } else if (pendente.tipo==='cancelar') {
            await db.from('agendamentos_crm').update({status:'cancelado',sent:true}).eq('id',pendente.agId);
            await db.from('dash_notifs').insert({instance_name:inst,title:`🗑️ Agendamento cancelado`,body:`${leadName}: ${pendente.dtFormatada}`,type:'info',read:false,criado_por_ia:true,lead_id:lead.id});
            log(inst,'ok',`[Agenda] 🗑️ Cancelado — ${leadName}`);

        } else if (pendente.tipo==='reagendar') {
            await db.from('agendamentos_crm').update({data_hora:pendente.novaDataHora,lembrete_enviado:false,reagendado_em:new Date().toISOString(),alterado_por:'ia'}).eq('id',pendente.ag.id);
            const novaF=new Date(pendente.novaDataHora.replace('T',' ')).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
            await db.from('dash_notifs').insert({instance_name:inst,title:`🔄 Reagendamento realizado`,body:`${leadName}: → ${novaF}`,type:'success',read:false,criado_por_ia:true,lead_id:lead.id});
            log(inst,'ok',`[Agenda] 🔄 Reagendado — ${leadName}: → ${pendente.novaDataHora}`);
        }
    } catch(e) { log(inst,'warn',`[Agenda] Falha ação: ${e.message}`); }
}

// ─── LOG ─────────────────────────────────────────────────────────────────────
function log(inst, tipo, msg) {
    const hora = new Date().toLocaleTimeString('pt-BR');
    const icon = tipo === 'ok' ? '✅' : tipo === 'erro' ? '❌' : tipo === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`[${hora}] [${inst}] ${icon} ${msg}`);
}

// ─── CARREGAR CONFIGURAÇÃO DA IA ─────────────────────────────────────────────
async function carregarConfig(inst) {
    const s = getState(inst);
    try {
        const { data, error } = await db.from('ia_config').select('*').eq('instance_name', inst).single();
        if (error && error.code !== 'PGRST116') throw error;
        if (!data) { log(inst, 'warn', 'Nenhuma config encontrada no banco'); return; }

        // Corrige modelo Gemini para gpt
        const modelo = (data.modelo || '').toLowerCase().includes('gemini') ? 'gpt-4o-mini' : (data.modelo || 'gpt-4o-mini');

        s.config = {
            ativo:             data.ativo ?? false,
            apiKey:            data.api_key || '',
            prompt:            data.prompt || '',
            modelo:            modelo,
            selectedPromptId:  data.selected_prompt_id || null,
            delayMin:          data.delay_min ?? 1,
            delayMax:          data.delay_max ?? 3,
            pausaSeHumano:     data.pausa_se_humano ?? true,
            responderGrupos:   data.responder_grupos ?? false,
            pausaTempo:        data.pausa_tempo ?? 30,
            keyword:           data.palavra_chave || '',
            keywordRetomar:    data.palavra_retomar || '',
            bufferTempo:       data.buffer_tempo ?? 8,
            msgMaxChars:       data.msg_max_chars ?? 300,
            msgDelayPartes:    data.msg_delay_partes ?? 2,
            ttsMode:           data.tts_mode || 'off',
            ttsVoz:            data.tts_voz || 'nova',
            ttsMaxSeconds:     data.tts_max_seconds ?? 10,
            ttsFrequencia:     data.tts_frequencia || 50,
            temperatura:       data.temperatura ?? 0.7,
            maxTokens:         data.max_tokens   ?? 1024,
            // ── Proteção anti-bot-loop ──────────────────────────────────────
            botIdentifiers:    data.bot_identifiers || '',   // CSV de nomes/palavras que indicam outro bot
            botRateLimit:      data.bot_rate_limit  ?? 6,    // máx msgs do mesmo lead por janela de tempo
            botRateWindowSec:  data.bot_rate_window ?? 60,   // janela em segundos para o rate limit
            msgQuebrarLinhas:  data.msg_quebrar_linhas ?? true, // quebra mensagens longas em partes
            // ── Follow-up / Reengajamento ──
            followupAtivo:           data.followup_ativo            ?? false,
            followupMaxTentativas:   data.followup_max_tentativas   ?? 3,
            followupTempo1:          data.followup_tempo_1          ?? 30,
            followupUnidade1:        data.followup_unidade_1        || 'minutos',
            followupTempo2:          data.followup_tempo_2          ?? 2,
            followupUnidade2:        data.followup_unidade_2        || 'horas',
            followupTempo3:          data.followup_tempo_3          ?? 1,
            followupUnidade3:        data.followup_unidade_3        || 'dias',
            followupHorarioInicio:   data.followup_horario_inicio   ?? 8,
            followupHorarioFim:      data.followup_horario_fim      ?? 20,
            followupIgnorarColunas:  data.followup_ignorar_colunas  || '',
        };

        // Se não tem API Key própria, busca a global
        if (!s.config.apiKey) {
            const { data: globalCfg } = await db.from('admin_config').select('value').eq('key', 'global_api_key').single();
            if (globalCfg?.value) { s.config.apiKey = globalCfg.value; log(inst, 'info', 'Usando API Key global do admin'); }
        }

        // ── Fallback: se prompt vazio mas há selected_prompt_id, busca na ia_prompts ──
        if (!s.config.prompt && s.config.selectedPromptId) {
            try {
                const { data: p } = await db.from('ia_prompts')
                    .select('prompt, conteudo')
                    .eq('id', s.config.selectedPromptId).single();
                if (p) s.config.prompt = p.prompt || p.conteudo || '';
                if (s.config.prompt) log(inst, 'ok', `[Config] Prompt recuperado da biblioteca (${s.config.selectedPromptId.substring(0,8)}...)`);
            } catch(e) { log(inst, 'warn', '[Config] Falha ao recuperar prompt da biblioteca: ' + e.message); }
        }

        log(inst, 'ok', `Config carregada. IA: ${s.config.ativo ? 'ATIVA' : 'INATIVA'} | Modelo: ${s.config.modelo} | Prompt: ${s.config.prompt ? 'OK' : 'VAZIO'} | ApiKey: ${s.config.apiKey ? 'OK' : 'VAZIO'}`);
    } catch (e) {
        log(inst, 'erro', 'Falha ao carregar config: ' + e.message);
    }
}

// ─── IA UTILS — API KEY HELPER ───────────────────────────────────────────────
// Retorna a API Key da instância (de estado, banco, ou global). Prioridade:
// 1. Estado em memória (já carregado)  2. ia_config do banco  3. admin global
async function getApiKey(inst) {
    const s = getState(inst);
    if (s.config?.apiKey) return s.config.apiKey;
    try {
        const { data } = await db.from('ia_config').select('api_key').eq('instance_name', inst).single();
        if (data?.api_key) return data.api_key;
    } catch(e) {}
    try {
        const { data: gCfg } = await db.from('admin_config').select('value').eq('key', 'global_api_key').single();
        if (gCfg?.value) return gCfg.value;
    } catch(e) {}
    return null;
}

// ─── IA: ANÁLISE DE SENTIMENTO (server-side) ─────────────────────────────────
// Busca as últimas mensagens do cliente, classifica sentimento e salva no lead.
async function analisarSentimentoLead(inst, leadId, apiKey) {
    if (!apiKey || !leadId) return null;
    try {
        const { data: msgs } = await db.from('messages')
            .select('content, from_me, type')
            .eq('lead_id', leadId)
            .eq('instance_name', inst)
            .eq('from_me', false)
            .eq('type', 'text')
            .order('created_at', { ascending: false })
            .limit(5);

        const textos = (msgs || []).map(m => m.content).filter(c => c && c.length > 5).join(' ');
        if (!textos.trim()) return null;

        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini', max_tokens: 10, temperature: 0,
                messages: [
                    { role: 'system', content: 'Classifique o sentimento em UMA palavra: positivo, negativo ou neutro. Responda APENAS a palavra.' },
                    { role: 'user', content: textos }
                ]
            })
        });
        const d = await r.json();
        const s = (d?.choices?.[0]?.message?.content || '').toLowerCase().trim();
        if (['positivo', 'negativo', 'neutro'].includes(s)) {
            await db.from('leads').update({ sentimento: s }).eq('id', leadId);
            log(inst, 'info', `[Sentimento] Lead ${leadId}: ${s}`);
            return s;
        }
    } catch(e) {
        log(inst, 'warn', `[Sentimento] Falha: ${e.message}`);
    }
    return null;
}


// Busca o push name do WhatsApp conectado na instância via Evolution API.
// Armazena em s.operatorNames para NUNCA salvar o nome do operador como nome de lead.
async function carregarNomeOperador(inst) {
    const s = getState(inst);
    if (!s.operatorNames) s.operatorNames = new Set();
    try {
        const res = await fetch(`${EVO_URL}/instance/fetchInstances`, {
            headers: { 'apikey': EVO_KEY }
        });
        if (!res.ok) return;
        const lista = await res.json();
        const instancias = Array.isArray(lista) ? lista : [lista];
        for (const item of instancias) {
            const info = item?.instance || item;
            const nome = info?.profileName || null;
            const instNome = info?.instanceName || item?.name || '';
            if (nome && instNome === inst) {
                s.operatorNames.add(nome.trim());
                log(inst, 'ok', `[Operador] Nome do operador carregado: "${nome}"`);
            }
        }
    } catch (e) {
        log(inst, 'warn', `[Operador] Falha ao buscar nome da instância: ${e.message}`);
    }
}

// ─── CARREGAR LEADS ───────────────────────────────────────────────────────────
async function carregarLeads(inst) {
    const s = getState(inst);
    try {
        const { data } = await db.from('leads').select('*').eq('instance_name', inst);
        if (data) {
            s.leads = {};
            data.forEach(l => { s.leads[l.id] = l; });
            log(inst, 'ok', `${data.length} leads carregados`);
        }
    } catch (e) {
        log(inst, 'erro', 'Falha ao carregar leads: ' + e.message);
    }
}

// ─── CARREGAR MÍDIAS ─────────────────────────────────────────────────────────
async function carregarMidias(inst) {
    const s = getState(inst);
    try {
        const { data } = await db.from('ia_midias').select('*').eq('instance_name', inst);
        if (data) { s.midias = data; log(inst, 'info', `${data.length} mídias carregadas`); }
    } catch (e) {
        log(inst, 'warn', 'Falha ao carregar mídias: ' + e.message);
    }
}

// ─── CARREGAR PAUSAS ─────────────────────────────────────────────────────────
async function carregarPausas(inst) {
    const s = getState(inst);
    try {
        const { data } = await db.from('ia_pausa').select('*').eq('instance_name', inst).eq('pausado', true);
        if (data) {
            data.forEach(p => {
                s.humanoAtivo[p.lead_id] = true;
                const cfg = s.config;
                if (cfg && cfg.pausaTempo > 0 && p.pausado_em) {
                    const pausadoHa = Date.now() - new Date(p.pausado_em).getTime();
                    const restante = (cfg.pausaTempo * 60 * 1000) - pausadoHa;
                    const lead = s.leads[p.lead_id];
                    const nome = lead ? getLeadName(lead) : p.lead_id;
                    if (restante > 0) {
                        s.humanoTimers[p.lead_id] = setTimeout(() => retomarIA(inst, p.lead_id, nome, 'timer automático (boot)'), restante);
                    } else {
                        salvarPausaDB(inst, p.lead_id, false, 'timer expirado offline');
                        delete s.humanoAtivo[p.lead_id];
                    }
                }
            });
            if (data.length > 0) log(inst, 'ok', `${data.length} pausa(s) restaurada(s)`);
        }
    } catch (e) {
        log(inst, 'warn', 'Falha ao carregar pausas: ' + e.message);
    }
}

// ─── AGENDA WORKER ───────────────────────────────────────────────────────────
async function buscarNumeroLead(inst, leadId) {
    const s = getState(inst);
    if (s.leads[leadId]) return s.leads[leadId].numero;
    // Fallback: busca no banco
    const { data } = await db.from('leads').select('numero').eq('id', leadId).single();
    return data?.numero || null;
}

async function enviarAgendamento(inst, ag) {
    const numero = ag.numero || (ag.lead_id ? await buscarNumeroLead(inst, ag.lead_id) : null);
    if (!numero) {
        log(inst, 'warn', `[Agenda] Sem número para agendamento ${ag.id} — ignorando`);
        // Marca como sent para não tentar novamente
        await db.from('agendamentos_crm').update({ sent: true, status: 'concluido' }).eq('id', ag.id);
        return;
    }

    try {
        if (ag.tipo === 'simples') {
            const texto = ag.texto || '';
            if (!texto.trim()) { log(inst, 'warn', `[Agenda] Texto vazio ${ag.id}`); return; }
            await enviarTexto(inst, numero, texto);
            // Salva no histórico de mensagens se tiver lead_id
            if (ag.lead_id) {
                await salvarMensagemDB(inst, ag.lead_id, texto, 'text', { sent_by_ia: false });
            }
            log(inst, 'ok', `[Agenda] ✅ Msg simples enviada para ${numero}`);

        } else if (ag.tipo === 'fluxo') {
            // Busca os blocos do fluxo no banco e executa cada um
            if (!ag.flow_id) { log(inst, 'warn', `[Agenda] flow_id ausente ${ag.id}`); return; }
            const { data: rule } = await db.from('bot_flows').select('*').eq('id', ag.flow_id).single();
            if (!rule) { log(inst, 'warn', `[Agenda] Fluxo ${ag.flow_id} não encontrado`); return; }

            const blocos = typeof rule.steps === 'string' ? JSON.parse(rule.steps) : (rule.steps || []);
            for (const bloco of blocos) {
                if (bloco.delay && bloco.delay > 0) await delay(bloco.delay * 1000);
                if (bloco.type === 'text' && bloco.content) {
                    await enviarTexto(inst, numero, bloco.content);
                    if (ag.lead_id) await salvarMensagemDB(inst, ag.lead_id, bloco.content, 'text', { sent_by_ia: false });
                } else if ((bloco.type === 'image' || bloco.type === 'video' || bloco.type === 'audio') && bloco.url) {
                    await fetch(`${EVO_URL}/message/sendMedia/${inst}`, {
                        method: 'POST',
                        headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ number: numero, mediatype: bloco.type, media: bloco.url, caption: bloco.caption || '' })
                    });
                }
            }
            log(inst, 'ok', `[Agenda] ✅ Fluxo "${rule.name || ag.flow_id}" executado para ${numero}`);
        }

        // Marca como enviado
        await db.from('agendamentos_crm')
            .update({ sent: true, status: 'concluido' })
            .eq('id', ag.id);

    } catch (e) {
        log(inst, 'erro', `[Agenda] Falha ao enviar ${ag.id}: ${e.message}`);
    }
}

async function checkLembretesServidor(inst) {
    try {
        const agora = new Date();
        const em55min = new Date(agora.getTime() + 55 * 60 * 1000).toISOString();
        const em65min = new Date(agora.getTime() + 65 * 60 * 1000).toISOString();

        const { data } = await db
            .from('agendamentos_crm')
            .select('*')
            .eq('instance_name', inst)
            .eq('sent', false)
            .eq('status', 'ativo')
            .eq('lembrete_enviado', false)
            .gte('data_hora', em55min)
            .lte('data_hora', em65min);

        if (!data || data.length === 0) return;

        for (const ag of data) {
            const numero = ag.numero || (ag.lead_id ? await buscarNumeroLead(inst, ag.lead_id) : null);
            if (!numero) continue;

            const agDt = new Date(ag.data_hora);
            const horaFmt = agDt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const msgLembrete = `Olá! Só um lembrete: você tem um agendamento hoje às ${horaFmt}. Te esperamos! 😊`;

            try {
                await enviarTexto(inst, numero, msgLembrete);
                if (ag.lead_id) await salvarMensagemDB(inst, ag.lead_id, msgLembrete, 'text', { sent_by_ia: false });
                await db.from('agendamentos_crm').update({ lembrete_enviado: true }).eq('id', ag.id);
                log(inst, 'ok', `[Agenda] Lembrete enviado para ${numero} (agendamento às ${horaFmt})`);
            } catch (e) {
                log(inst, 'warn', `[Agenda] Erro ao enviar lembrete ${ag.id}: ${e.message}`);
            }
        }
    } catch (e) {
        log(inst, 'warn', `[Agenda] Erro ao checar lembretes: ${e.message}`);
    }
}

async function checkAgendamentosServidor(inst) {
    try {
        const { data, error } = await db
            .from('agendamentos_crm')
            .select('*')
            .eq('instance_name', inst)
            .eq('sent', false)
            .eq('status', 'ativo');

        if (error) throw error;
        if (!data || data.length === 0) return;

        const agora = Date.now();
        const vencidos = data.filter(ag => {
            if (!ag.data_hora) return false;
            try { return new Date(ag.data_hora).getTime() <= agora; } catch(e) { return false; }
        });

        if (vencidos.length === 0) return;
        log(inst, 'info', `[Agenda] ${vencidos.length} agendamento(s) para disparar agora`);
        for (const ag of vencidos) {
            await enviarAgendamento(inst, ag);
        }
    } catch (e) {
        log(inst, 'warn', `[Agenda] Erro ao checar agendamentos: ${e.message}`);
    }
}

// ─── CHATBOT WORKER (palavra-chave) ──────────────────────────────────────────

// Estado do chatbot por instância
const chatbotState = {}; // { [inst]: { regras, botAtivo, respondidos } }

function getChatbotState(inst) {
    if (!chatbotState[inst]) {
        chatbotState[inst] = {
            regras: [],       // array de regras do Supabase
            botAtivo: true,
            respondidos: {},  // { "regraId_leadId": true }
        };
    }
    return chatbotState[inst];
}

async function carregarChatbot(inst) {
    const cs = getChatbotState(inst);
    try {
        // Configuração geral (bot ativo/inativo)
        const { data: cfg } = await db
            .from('auto_replies_config')
            .select('*')
            .eq('instance_name', inst)
            .single();
        if (cfg) cs.botAtivo = cfg.bot_ativo ?? true;

        // Regras
        const { data: regras } = await db
            .from('auto_replies')
            .select('*')
            .eq('instance_name', inst)
            .order('prioridade', { ascending: true });
        if (regras) {
            cs.regras = regras.map(r => ({
                ...r,
                blocos: typeof r.blocos === 'string' ? JSON.parse(r.blocos) : (r.blocos || [])
            }));
            log(inst, 'ok', `[Bot] ${cs.regras.length} regra(s) carregada(s) | ativo:${cs.botAtivo}`);
        }

        // Leads já respondidos ("apenas uma vez")
        const { data: respondidos } = await db
            .from('auto_replies_respondidos')
            .select('regra_id, lead_id')
            .eq('instance_name', inst);
        if (respondidos) {
            cs.respondidos = {};
            respondidos.forEach(r => { cs.respondidos[`${r.regra_id}_${r.lead_id}`] = true; });
        }
    } catch (e) {
        log(inst, 'warn', `[Bot] Erro ao carregar: ${e.message}`);
    }
}

function processSpintax(text, lead) {
    if (!text) return '';
    let nome = lead?.nome && lead.nome !== lead.numero ? lead.nome : (lead?.pushName || lead?.name || 'Cliente');
    let msg = text
        .replace(/{nome}/g, nome)
        .replace(/{primeiro_nome}/g, nome.split(' ')[0])
        .replace(/{numero}/g, lead?.numero || '');
    return msg.replace(/{([^{}]+)}/g, (match, options) => {
        const words = options.split('|').filter(w => w.trim());
        return words.length > 0 ? words[Math.floor(Math.random() * words.length)] : match;
    });
}

async function chatbotExecutarRegra(inst, regra, lead) {
    const cs = getChatbotState(inst);

    // Marcar "apenas uma vez" no Supabase
    if (regra.apenas_uma_vez) {
        const chave = `${regra.id}_${lead.id}`;
        cs.respondidos[chave] = true;
        db.from('auto_replies_respondidos').upsert({
            instance_name: inst, regra_id: String(regra.id), lead_id: lead.id
        }, { onConflict: 'instance_name,regra_id,lead_id' }).then();
    }

    // Incrementar contador de disparos
    db.from('auto_replies')
        .update({ disparos: (regra.disparos || 0) + 1 })
        .eq('id', regra.id).then();

    log(inst, 'info', `[Bot] Executando regra "${regra.gatilhos}" para ${getLeadName(lead)}`);

    for (const bloco of regra.blocos) {
        const delayMs = (parseInt(bloco.delay) || 1) * 1000;

        if (bloco.tipo === 'delay') {
            await delay(delayMs);

        } else if (bloco.tipo === 'texto') {
            await delay(delayMs);
            const texto = processSpintax(bloco.conteudo, lead);
            try {
                await enviarTexto(inst, lead.numero, texto);
                await salvarMensagemDB(inst, lead.id, texto, 'text', { sent_by_ia: true });
            } catch (e) {
                log(inst, 'erro', `[Bot] Erro ao enviar texto: ${e.message}`);
            }

        } else if (['audio', 'imagem', 'video', 'documento'].includes(bloco.tipo)) {
            await delay(delayMs);
            try {
                const mType = bloco.tipo === 'imagem' ? 'image' : bloco.tipo === 'documento' ? 'document' : bloco.tipo;
                let endpoint = 'sendMedia';
                let body = { number: lead.numero, mediatype: mType, media: bloco.conteudo, fileName: bloco.nomeArquivo || 'arquivo' };
                if (bloco.tipo === 'audio') {
                    endpoint = 'sendWhatsAppAudio';
                    body = { number: lead.numero, audio: bloco.conteudo };
                }
                await fetch(`${EVO_URL}/message/${endpoint}/${inst}`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                await salvarMensagemDB(inst, lead.id, bloco.conteudo, bloco.tipo, { sent_by_ia: true });
            } catch (e) {
                log(inst, 'erro', `[Bot] Erro ao enviar mídia: ${e.message}`);
            }
        }
    }

    log(inst, 'ok', `[Bot] ✅ Regra "${regra.gatilhos}" executada para ${getLeadName(lead)}`);
}

async function chatbotChecarMensagem(inst, msgContent, lead) {
    const cs = getChatbotState(inst);
    if (!cs.botAtivo) return;
    if (!msgContent || !lead) return;

    // Se IA está pausada para este lead, chatbot não interfere
    const s = getState(inst);
    if (s.humanoAtivo && s.humanoAtivo[lead.id]) return;

    const texto = msgContent.toLowerCase().trim();
    const regrasAtivas = cs.regras
        .filter(r => r.ativo)
        .sort((a, b) => (a.prioridade || 2) - (b.prioridade || 2));

    for (const regra of regrasAtivas) {
        if (regra.apenas_uma_vez) {
            const chave = `${regra.id}_${lead.id}`;
            if (cs.respondidos[chave]) continue;
        }

        const gatilhos = regra.gatilhos.split(',').map(g => g.trim().toLowerCase()).filter(Boolean);
        let match = false;
        for (const gatilho of gatilhos) {
            if (regra.modo_match === 'exato'  && texto === gatilho)          { match = true; break; }
            if (regra.modo_match === 'inicio' && texto.startsWith(gatilho)) { match = true; break; }
            if ((!regra.modo_match || regra.modo_match === 'contem') && texto.includes(gatilho)) { match = true; break; }
        }

        if (match) {
            await chatbotExecutarRegra(inst, regra, lead);
            break; // só uma regra por mensagem
        }
    }
}

// ─── PROTEÇÃO ANTI-BOT-LOOP ───────────────────────────────────────────────────

// Caractere invisível (U+200B + U+200C) usado como assinatura nas mensagens saindo da IA.
// Se uma resposta chegar com esses chars, foi gerada por um bot e deve ser ignorada.
const BOT_SIGNATURE = '\u200B\u200C';

/**
 * Retorna { bloqueado: true|false, motivo } se a mensagem deve ser ignorada por bot.
 * 3 camadas de detecção:
 *  1. Assinatura invisível — detecta loop de espelho (bot respondendo a si mesmo)
 *  2. Identificadores configurados — push_name ou conteúdo bate com lista do usuário
 *  3. Rate limit — muitas msgs do mesmo lead em pouco tempo indica loop externo
 */
function detectarBot(inst, msg, pushName) {
    const s   = getState(inst);
    const cfg = s.config;

    // Camada 1: Assinatura invisível da própria IA
    if (msg.content && msg.content.includes(BOT_SIGNATURE)) {
        log(inst, 'warn', `🤖 [AntiBot] Assinatura de bot na mensagem — loop detectado! IGNORANDO`);
        return { bloqueado: true, motivo: 'assinatura_bot' };
    }

    // Camada 2: Identificadores configurados pelo usuário
    const identifiers = (cfg?.botIdentifiers || '')
        .split(',')
        .map(b => b.trim().toLowerCase())
        .filter(Boolean);

    if (identifiers.length > 0) {
        const senderLower  = (pushName || '').toLowerCase();
        const contentLower = (msg.content || '').toLowerCase();
        const matched = identifiers.find(id =>
            (senderLower && senderLower.includes(id)) ||
            (contentLower && contentLower.startsWith(id))
        );
        if (matched) {
            log(inst, 'warn', `🤖 [AntiBot] Identificador "${matched}" detectado — IGNORANDO msg de bot`);
            return { bloqueado: true, motivo: `identificador:${matched}` };
        }
    }

    // Camada 3: Rate limit por lead (detecta loop de bot externo)
    const rateLimit     = cfg?.botRateLimit     ?? 6;
    const rateWindowSec = cfg?.botRateWindowSec ?? 60;
    const leadId        = msg.lead_id;
    const agora         = Date.now();
    const windowMs      = rateWindowSec * 1000;

    if (!s.msgRateTracker[leadId]) s.msgRateTracker[leadId] = [];
    s.msgRateTracker[leadId] = s.msgRateTracker[leadId].filter(t => agora - t < windowMs);
    s.msgRateTracker[leadId].push(agora);

    const qtd = s.msgRateTracker[leadId].length;
    if (qtd > rateLimit) {
        log(inst, 'warn', `🤖 [AntiBot] Rate limit: ${qtd} msgs em ${rateWindowSec}s para lead ${leadId} — possível bot-loop! IGNORANDO`);
        return { bloqueado: true, motivo: `rate_limit:${qtd}msgs/${rateWindowSec}s` };
    }

    return { bloqueado: false };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getLeadName(lead) {
    if (!lead) return 'Desconhecido';
    if (lead.nome && lead.nome !== lead.numero) return lead.nome;
    if (lead.name) return lead.name;
    if (lead.pushName) return lead.pushName;
    return lead.nome || lead.numero || 'Desconhecido';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay(minSec, maxSec) {
    const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
    return delay(ms);
}

// ─── PAUSA / RETOMADA ─────────────────────────────────────────────────────────
async function salvarPausaDB(inst, leadId, pausado, pausadoPor) {
    try {
        if (pausado) {
            await db.from('ia_pausa').upsert({
                instance_name: inst, lead_id: leadId,
                pausado: true, pausado_por: pausadoPor || 'humano',
                pausado_em: new Date().toISOString(), retomado_em: null
            }, { onConflict: 'instance_name,lead_id' });
        } else {
            await db.from('ia_pausa').upsert({
                instance_name: inst, lead_id: leadId,
                pausado: false, retomado_em: new Date().toISOString()
            }, { onConflict: 'instance_name,lead_id' });
        }
    } catch (e) {
        log(inst, 'warn', '[ia_pausa] Supabase erro: ' + e.message);
    }
}

function pausarIA(inst, leadId, leadName, origem) {
    const s = getState(inst);
    const cfg = s.config;
    if (!cfg || !cfg.pausaSeHumano) return;

    const palavraPausa   = (cfg.keyword || '').trim().toLowerCase();
    const palavraRetomar = (cfg.keywordRetomar || '').trim().toLowerCase();
    const msgTexto       = (origem?.texto || '').trim().toLowerCase();
    const fonte          = origem?.fonte || '?';

    // Se é palavra de retomar, retoma e sai
    if (palavraRetomar && msgTexto.includes(palavraRetomar)) {
        retomarIA(inst, leadId, leadName, `palavra-chave "${palavraRetomar}" [${fonte}]`);
        return;
    }

    // Quando o HUMANO envia mensagem (CRM ou WhatsApp), SEMPRE pausa — sem exigir keyword
    const isHumano = (fonte === 'CRM' || fonte === 'WhatsApp');
    if (!isHumano && palavraPausa) {
        // Pausa vinda de outra fonte (ex: cliente) → exige keyword match
        const bateu = msgTexto === palavraPausa || msgTexto.startsWith(palavraPausa + ' ') || msgTexto.includes(palavraPausa);
        if (!bateu) return;
    }

    const jaPausado = !!s.humanoAtivo[leadId];
    s.humanoAtivo[leadId] = true;

    if (s.humanoTimers[leadId]) clearTimeout(s.humanoTimers[leadId]);
    salvarPausaDB(inst, leadId, true, fonte);

    if (!jaPausado) log(inst, 'info', `🧑 IA pausada para ${leadName} [${fonte}]`);

    if (cfg.pausaTempo > 0) {
        s.humanoTimers[leadId] = setTimeout(() => {
            retomarIA(inst, leadId, leadName, 'timer automático');
        }, cfg.pausaTempo * 60 * 1000);
    }
}

function retomarIA(inst, leadId, leadName, motivo) {
    const s = getState(inst);
    if (!s.humanoAtivo[leadId]) return;
    delete s.humanoAtivo[leadId];
    if (s.humanoTimers[leadId]) { clearTimeout(s.humanoTimers[leadId]); delete s.humanoTimers[leadId]; }
    salvarPausaDB(inst, leadId, false, motivo);
    log(inst, 'ok', `🤖 IA retomou para ${leadName} [${motivo}]`);
}

// ─── BUFFER DE MENSAGENS ─────────────────────────────────────────────────────
async function bufferAdicionarMsg(inst, lead, msgObj) {
    const s = getState(inst);
    const leadId = lead.id;
    if (!s.bufferMsgs[leadId]) s.bufferMsgs[leadId] = [];

    s.bufferMsgs[leadId].push({
        content: msgObj.content || '',
        type: msgObj.type || 'text',
        id: msgObj.id,
        ts: msgObj.timestamp || new Date().toISOString()
    });

    const cfg = s.config;
    const bufferTempo = cfg?.bufferTempo ?? 8;
    const total = s.bufferMsgs[leadId].length;
    log(inst, 'info', `⏳ Buffer [${getLeadName(lead)}]: ${total} msg(s) — aguardando ${bufferTempo}s`);

    if (s.bufferTimers[leadId]) clearTimeout(s.bufferTimers[leadId]);
    s.bufferTimers[leadId] = setTimeout(() => bufferDisparar(inst, lead), bufferTempo * 1000);
}

async function bufferDisparar(inst, lead) {
    const s = getState(inst);
    const leadId = lead.id;
    const msgs = s.bufferMsgs[leadId] || [];
    if (msgs.length === 0) return;

    delete s.bufferMsgs[leadId];
    delete s.bufferTimers[leadId];

    let msgFinal;
    if (msgs.length === 1) {
        msgFinal = msgs[0];
        log(inst, 'info', `📨 Buffer [${getLeadName(lead)}]: 1 msg — disparando IA`);
    } else {
        const textos = msgs.filter(m => !m.type || m.type === 'text').map(m => m.content).filter(Boolean);
        const ultimaNaoTexto = [...msgs].reverse().find(m => m.type && m.type !== 'text');
        msgFinal = {
            content: textos.join('\n'),
            type: ultimaNaoTexto ? ultimaNaoTexto.type : 'text',
            id: msgs[msgs.length - 1].id,
            timestamp: msgs[msgs.length - 1].ts
        };
        log(inst, 'ok', `📦 Buffer [${getLeadName(lead)}]: ${msgs.length} msgs unificadas → IA dispara`);
    }

    await iaResponderCliente(inst, msgFinal.content, lead, msgFinal);
}

// ─── ENVIAR TEXTO VIA EVOLUTION API ──────────────────────────────────────────
async function enviarTexto(inst, numero, texto) {
    const res = await fetch(`${EVO_URL}/message/sendText/${inst}`, {
        method: 'POST',
        headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: numero, text: texto })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || 'HTTP ' + res.status);
    }
    return res.json();
}

async function enviarAudio(inst, numero, audioUrl) {
    const res = await fetch(`${EVO_URL}/message/sendWhatsAppAudio/${inst}`, {
        method: 'POST',
        headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: numero, audio: audioUrl })
    });
    if (!res.ok) throw new Error('Evo Audio HTTP ' + res.status);
    return res.json();
}

// ─── SALVAR MENSAGEM NO SUPABASE ─────────────────────────────────────────────
async function salvarMensagemDB(inst, leadId, content, type, extraFields = {}) {
    await db.from('messages').insert({
        lead_id: leadId, content, from_me: true,
        type, status: 'sent', instance_name: inst,
        sent_by_ia: true,
        ...extraFields
    });
}

// ─── GERAR E ENVIAR ÁUDIO TTS ────────────────────────────────────────────────
async function gerarEEnviarAudio(inst, lead, texto, apiKey) {
    const s = getState(inst);
    const cfg = s.config;
    // Limita a 300 caracteres por audio
    const textoTts = texto.substring(0, 300);
    const voz = cfg?.ttsVoz || 'nova';
    log(inst, 'info', `[TTS] Iniciando — voz:${voz} | chars:${textoTts.length} | modo:${cfg?.ttsMode}`);

    // 1. Gerar áudio na OpenAI
    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'tts-1', input: textoTts, voice: voz, response_format: 'mp3' })
    });
    log(inst, 'info', `[TTS] OpenAI status: ${ttsRes.status}`);
    if (!ttsRes.ok) {
        const errBody = await ttsRes.json().catch(() => ({}));
        throw new Error('[TTS] OpenAI erro: ' + (errBody?.error?.message || ttsRes.status));
    }

    // 2. Converter resposta para Buffer
    const arrayBuf = await ttsRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    log(inst, 'info', `[TTS] Audio gerado: ${buffer.length} bytes`);

    // 3. Salva no disco local
    const fileName = `${Date.now()}_${lead.id}.mp3`;
    const publicUrl = localSave('ia_tts', fileName, buffer);
    log(inst, 'ok', `[TTS] Salvo localmente → ${publicUrl}`);

    // 4. Enviar via Evolution API
    log(inst, 'info', `[TTS] Enviando audio para ${lead.numero}...`);
    await enviarAudio(inst, lead.numero, publicUrl);
    await salvarMensagemDB(inst, lead.id, publicUrl, 'audio');
    log(inst, 'ok', '[TTS] Audio enviado com sucesso!');
}

// ─── VERIFICAR E ENVIAR MÍDIAS INTELIGENTES ──────────────────────────────────
async function verificarEEnviarMidias(inst, lead, textoCliente) {
    const s = getState(inst);
    if (!textoCliente || !s.midias.length) return;
    const textoLower = textoCliente.toLowerCase();
    const enviadas = new Set();

    for (const midia of s.midias) {
        if (!midia.ativo) continue;
        const palavras = midia.palavras_chave.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
        const match = palavras.some(p => textoLower.includes(p));
        if (!match || enviadas.has(midia.id)) continue;
        enviadas.add(midia.id);

        try {
            if (midia.tipo === 'audio') {
                await enviarAudio(inst, lead.numero, midia.url);
            } else {
                const mimeMap = { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf' };
                const mime = mimeMap[midia.tipo] || 'application/octet-stream';
                await fetch(`${EVO_URL}/message/sendMedia/${inst}`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        number: lead.numero, mediatype: midia.tipo, mimetype: mime,
                        media: midia.url, caption: midia.descricao || '', fileName: midia.nome,
                        mediaMessage: { mediatype: midia.tipo, mimetype: mime, media: midia.url, caption: midia.descricao || '', fileName: midia.nome }
                    })
                });
            }
            await salvarMensagemDB(inst, lead.id, midia.url, midia.tipo);
            log(inst, 'ok', `📎 Mídia enviada: ${midia.nome}`);
        } catch (e) {
            log(inst, 'erro', `Falha ao enviar mídia ${midia.nome}: ${e.message}`);
        }
    }
}

// ─── IA RESPONDER CLIENTE ─────────────────────────────────────────────────────
async function iaResponderCliente(inst, mensagemClienteTexto, lead, msgObj) {
    const s = getState(inst);
    // Snapshot da config no início da função — evita race condition onde s.config
    // é sobrescrito por carregarConfig() enquanto awaits estão em andamento,
    // o que causava mistura de contexto/prompt entre leads concorrentes.
    const cfg = s.config ? { ...s.config } : null;

    if (!temFeature(inst, 'ia_atendimento')) { log(inst, 'info', `⛔ [ia_atendimento] Feature não ativa no plano — ${inst}`); return; }
    if (!cfg || !cfg.ativo)  { log(inst, 'erro', '⛔ IA desativada'); return; }
    if (!cfg.apiKey)         { log(inst, 'erro', '⛔ API Key não configurada'); return; }
    if (s.respondendo[lead.id]) { log(inst, 'info', '⏳ Já respondendo para ' + getLeadName(lead)); return; }
    if (cfg.pausaSeHumano && s.humanoAtivo[lead.id]) { log(inst, 'info', '🧑 IA pausada para ' + getLeadName(lead)); return; }
    if (!cfg.responderGrupos && lead.status === 'grupo') { log(inst, 'info', '👥 Ignorado — é grupo'); return; }

    // ── Resolver prompt ativo para este lead ──────────────────────────────────
    // Se o lead tiver um prompt_id específico, usa ele; caso contrário usa o global.
    let promptAtivo = cfg.prompt || '';
    if (lead.prompt_id) {
        try {
            const { data: pLead } = await db.from('ia_prompts')
                .select('prompt, conteudo')
                .eq('id', lead.prompt_id)
                .single();
            if (pLead) {
                promptAtivo = pLead.prompt || pLead.conteudo || '';
                log(inst, 'info', `🎯 Prompt específico do lead aplicado (${lead.prompt_id.substring(0,8)}...)`);
            }
        } catch(e) { log(inst, 'warn', '[Lead Prompt] Falha ao carregar prompt do lead: ' + e.message); }
    }
    if (!promptAtivo) { log(inst, 'erro', '⛔ Nenhum prompt ativo'); return; }

    s.respondendo[lead.id] = true;
    log(inst, 'info', `📨 Respondendo ${getLeadName(lead)}: ${(mensagemClienteTexto || '[mídia]').substring(0, 60)}`);

    try {
        // ── 1. Buscar histórico completo da conversa ──
        let histMsgs = [];
        try {
            const { data: msgData, error: msgErr } = await db
                .from('messages')
                .select('id, content, from_me, type, sent_by_ia, timestamp, created_at')
                .eq('lead_id', lead.id)
                .eq('instance_name', inst)
                .order('created_at', { ascending: true });

            if (msgErr) throw msgErr;

            if (msgData && msgData.length > 0) {
                const msgAtualId = msgObj?.id || null;
                let todasMsgs = msgData.filter(m => !(msgAtualId && m.id === msgAtualId));

                // Segurança: remove ultima msg do cliente se bater com a atual
                if (todasMsgs.length > 0) {
                    const last = todasMsgs[todasMsgs.length - 1];
                    if (!last.from_me && last.content?.trim() === mensagemClienteTexto?.trim()) {
                        todasMsgs = todasMsgs.slice(0, -1);
                    }
                }

                // Limita a 60 mensagens mais recentes para nao estourar o contexto da OpenAI
                histMsgs = todasMsgs.slice(-60);
                log(inst, 'info', `📖 Histórico: ${histMsgs.length} msgs carregadas para ${getLeadName(lead)}`);
            } else {
                log(inst, 'info', `📖 Historico vazio — primeira conversa com ${getLeadName(lead)}`);
            }
        } catch (e) {
            log(inst, 'warn', 'Erro ao buscar historico: ' + e.message);
        }

        // ── 2. Montar mensagem atual (suporte a mídia) ──
        const msgType = msgObj?.type || 'text';
        const msgContent = msgObj?.content || mensagemClienteTexto || '';
        let currentText = mensagemClienteTexto || '';

        if (msgType === 'image') {
            try {
                log(inst, 'info', '🖼️ Analisando imagem...');
                const visionResp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini', max_tokens: 1024,
                        messages: [{ role: 'user', content: [
                            { type: 'image_url', image_url: { url: msgContent } },
                            { type: 'text', text: 'Descreva detalhadamente o conteúdo desta imagem em português. Extraia todo texto visível. Seja objetivo.' }
                        ]}]
                    })
                });
                const vd = await visionResp.json();
                const desc = vd?.choices?.[0]?.message?.content || '';
                currentText = desc
                    ? `[Cliente enviou imagem${mensagemClienteTexto ? ' com legenda: "' + mensagemClienteTexto + '"' : ''}]\n[Análise: ${desc}]`
                    : `[Cliente enviou uma imagem${mensagemClienteTexto ? ': ' + mensagemClienteTexto : ''}]`;
                log(inst, 'ok', '🖼️ Imagem analisada');
            } catch (e) {
                currentText = `[Cliente enviou uma imagem${mensagemClienteTexto ? ': ' + mensagemClienteTexto : ''}]`;
            }
        } else if (msgType === 'audio') {
            try {
                log(inst, 'info', '🎤 Transcrevendo áudio (Whisper)...');
                const audioResp = await fetch(msgContent);
                if (audioResp.ok) {
                    const arrayBuf = await audioResp.arrayBuffer();
                    const audioBuffer = Buffer.from(arrayBuf);
                    const formData = new FormData();
                    formData.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
                    formData.append('model', 'whisper-1');
                    formData.append('language', 'pt');
                    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, ...formData.getHeaders() },
                        body: formData
                    });
                    const wd = await whisperResp.json();
                    currentText = wd?.text ? `[Áudio transcrito: "${wd.text}"]` : '[Cliente enviou um áudio]';
                    log(inst, 'ok', '🎤 Áudio transcrito: ' + (wd?.text || '').substring(0, 40));
                }
            } catch (e) {
                currentText = '[Cliente enviou um áudio]';
            }
        } else if (msgType === 'document') {
            try {
                log(inst, 'info', '📄 Lendo documento do cliente...');
                const docResp = await fetch(msgContent);
                if (docResp.ok) {
                    const arrayBuf = await docResp.arrayBuffer();
                    const buf = Buffer.from(arrayBuf);
                    let docText = '';
                    const urlLower = msgContent.toLowerCase();
                    if (urlLower.endsWith('.pdf') || urlLower.includes('.pdf?')) {
                        const pdfParse = require('pdf-parse');
                        const pdfData  = await pdfParse(buf);
                        docText = pdfData.text || '';
                    } else if (urlLower.endsWith('.docx') || urlLower.includes('.docx?')) {
                        const mammoth = require('mammoth');
                        const result  = await mammoth.extractRawText({ buffer: buf });
                        docText = result.value || '';
                    } else {
                        docText = buf.toString('utf-8');
                    }
                    docText = docText.trim();
                    if (docText) {
                        const caption = mensagemClienteTexto ? `\nLegenda: "${mensagemClienteTexto}"` : '';
                        currentText = `[Cliente enviou um documento${caption}]\n\n[Conteúdo do documento (use para responder a pergunta do cliente):\n${docText.substring(0, 4000)}]`;
                        log(inst, 'ok', `📄 Documento lido (${docText.length} chars)`);
                    } else {
                        currentText = `[Cliente enviou um documento${mensagemClienteTexto ? ': ' + mensagemClienteTexto : ''}]`;
                    }
                }
            } catch (e) {
                log(inst, 'warn', `[Doc] Erro ao ler documento: ${e.message}`);
                currentText = `[Cliente enviou um documento${mensagemClienteTexto ? ': ' + mensagemClienteTexto : ''}]`;
            }
        } else if (msgType !== 'text') {
            currentText = `[Cliente enviou ${msgType}]`;
        }

        // ── 3. Montar histórico OpenAI ──
        const openAIMsgs = [{ role: 'system', content: promptAtivo }];
        for (const m of histMsgs) {
            const role = m.from_me ? 'assistant' : 'user';
            const tipo = m.type || 'text';
            let content = m.content || '';
            if (tipo === 'audio' && content.includes('http')) content = '[Audio enviado]';
            else if (tipo === 'image' && content.includes('http')) content = '[Imagem enviada]';
            else if (tipo === 'video' && content.includes('http')) content = '[Video enviado]';
            else if (tipo === 'document' && content.includes('http')) content = '[Documento enviado]';
            if (!content.trim()) continue;
            openAIMsgs.push({ role, content });
        }

        // ── 3b. Pré-check de agenda (injeta contexto no prompt antes de chamar a IA) ──
        let agendaAcaoPendente = null;
        if (mensagemClienteTexto && temFeature(inst, 'agenda')) {
            try {
                const { agendaContexto, agendaAcaoPendente: acao } = await agendaPreCheck(inst, lead, mensagemClienteTexto, histMsgs, cfg.apiKey);
                agendaAcaoPendente = acao;
                if (agendaContexto) {
                    openAIMsgs.push({ role: 'system', content: agendaContexto });
                    log(inst, 'info', `[Agenda] Contexto injetado (${agendaContexto.length} chars)`);
                }
            } catch(e) { log(inst, 'warn', `[Agenda] Pré-check falhou: ${e.message}`); }
        }

        // ── 3c. Injetar documentos do lead como contexto ──
        try {
            const { data: docs } = await db.from('lead_documentos')
                .select('nome, descricao, versao, arquivo_url, arquivo_tipo, updated_at, created_at')
                .eq('lead_id', lead.id)
                .eq('instance_name', inst)
                .order('created_at', { ascending: false })
                .limit(10);
            if (docs && docs.length > 0) {
                const docCtxParts = [];
                for (const d of docs) {
                    const dataUpd = new Date(d.updated_at || d.created_at).toLocaleDateString('pt-BR');
                    let header = `📄 "${d.nome}" (versão ${d.versao}, atualizado em ${dataUpd})${d.descricao ? ' — ' + d.descricao : ''}`;
                    let conteudo = '';
                    try {
                        if (d.arquivo_url) {
                            // Busca o arquivo via HTTP local (evita problema de path de disco)
                            const localUrl = d.arquivo_url.replace(/^https?:\/\/[^/]+/, `http://localhost:${PORT}`);
                            log(inst, 'info', `[Docs] Buscando: ${localUrl}`);
                            const fileResp = await fetch(localUrl);
                            if (fileResp.ok) {
                                const arrayBuf = await fileResp.arrayBuffer();
                                const buf = Buffer.from(arrayBuf);
                                const urlLower = d.arquivo_url.toLowerCase();
                                const tipoLower = (d.arquivo_tipo || '').toLowerCase();
                                if (urlLower.includes('.pdf') || tipoLower.includes('pdf')) {
                                    const pdfParse = require('pdf-parse');
                                    const pdfData = await pdfParse(buf);
                                    conteudo = (pdfData.text || '').trim().substring(0, 3000);
                                    log(inst, 'ok', `[Docs] PDF lido: "${d.nome}" (${conteudo.length} chars)`);
                                } else if (urlLower.includes('.docx') || tipoLower.includes('docx') || tipoLower.includes('word')) {
                                    const mammoth = require('mammoth');
                                    const result = await mammoth.extractRawText({ buffer: buf });
                                    conteudo = (result.value || '').trim().substring(0, 3000);
                                    log(inst, 'ok', `[Docs] DOCX lido: "${d.nome}" (${conteudo.length} chars)`);
                                } else if (urlLower.includes('.txt') || urlLower.includes('.md') || urlLower.includes('.csv') || tipoLower.includes('text')) {
                                    conteudo = buf.toString('utf-8').trim().substring(0, 3000);
                                    log(inst, 'ok', `[Docs] TXT lido: "${d.nome}" (${conteudo.length} chars)`);
                                } else {
                                    log(inst, 'warn', `[Docs] Tipo não suportado: ${d.arquivo_tipo}`);
                                }
                            } else {
                                log(inst, 'warn', `[Docs] HTTP ${fileResp.status} ao buscar "${d.nome}"`);
                            }
                        }
                    } catch(eDoc) {
                        log(inst, 'erro', `[Docs] Erro ao ler "${d.nome}": ${eDoc.message}`);
                    }
                    docCtxParts.push(conteudo
                        ? `${header}\nConteúdo do arquivo:\n${conteudo}`
                        : `${header}${d.descricao ? '' : ' (arquivo sem leitura automática)'}`
                    );
                }
                const docCtx = docCtxParts.join('\n\n');
                openAIMsgs.push({ role: 'system', content: `IMPORTANTE — DOCUMENTOS DO CLIENTE NO SISTEMA:\n${docCtx}\n\nVocê TEM ACESSO a essas informações. Use o conteúdo acima para responder perguntas do cliente sobre seus documentos, processos, contratos ou atualizações. NUNCA diga que não tem acesso a documentos — você tem. Informe versão e data quando relevante.` });
                log(inst, 'info', `[Docs] Contexto injetado: ${docs.length} doc(s) para ${getLeadName(lead)}`);
            }
        } catch(e) { log(inst, 'warn', `[Docs] Erro ao buscar documentos: ${e.message}`); }

        openAIMsgs.push({ role: 'user', content: currentText });

        // ── 4. Delay humanizado ──
        await randomDelay(cfg.delayMin, cfg.delayMax);

        // ── 5. Chamar OpenAI ──
        const openAIResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
                model: cfg.modelo,
                temperature: cfg.temperatura ?? 0.7,
                max_tokens: cfg.maxTokens ?? 1024,
                messages: openAIMsgs
            })
        });
        const openAIData = await openAIResp.json();
        if (!openAIResp.ok) throw new Error(openAIData?.error?.message || 'OpenAI HTTP ' + openAIResp.status);

        const resposta = openAIData?.choices?.[0]?.message?.content || '';
        if (!resposta) throw new Error('OpenAI retornou resposta vazia');

        // Remove tags de sinalização antes de enviar ao cliente
        const respostaLimpa = resposta.replace(/##AGENDA_CONFIRMADA##|##AGENDA_CANCELADA##/g, '').trim();

        // ── 6. Enviar resposta ──
        const partes = dividirMensagem(respostaLimpa, cfg.msgMaxChars);
        const ttsMode = cfg.ttsMode || 'off';
        const clienteMandouAudio = (msgObj?.type === 'audio');
        const frequencia = cfg.ttsFrequencia ?? 50;
        const sorteioPassou = ttsMode !== 'frequencia' || (Math.random() * 100 < frequencia);

        // ⚠️ Bloqueia áudio se a feature audio_ia não estiver ativa na licença
        const audioIaLiberado = temFeature(inst, 'audio_ia');
        if (ttsMode !== 'off' && !audioIaLiberado) {
            log(inst, 'warn', `[TTS] ⛔ Bloqueado — feature audio_ia não habilitada para ${inst} (plano sem Áudio IA)`);
        }

        // Decide se envia áudio (só se feature liberada na licença)
        const deveEnviarAudio = audioIaLiberado && (
            ttsMode === 'audio_only' ||
            ttsMode === 'both' ||
            (ttsMode === 'frequencia' && sorteioPassou) ||
            (ttsMode === 'if_audio' && clienteMandouAudio)
        );
        // Se audio_only mas sem feature, força envio de texto mesmo assim
        const deveEnviarTexto = !audioIaLiberado
            ? true
            : (ttsMode !== 'audio_only' && !(ttsMode === 'frequencia' && sorteioPassou));

        log(inst, 'info', `[TTS] modo=${ttsMode} | audio_ia_liberado=${audioIaLiberado} | audio=${deveEnviarAudio} | texto=${deveEnviarTexto}`);

        for (let i = 0; i < partes.length; i++) {
            if (i > 0) await delay(cfg.msgDelayPartes * 1000);
            // Adiciona assinatura invisível para detectar loop caso outro bot responda
            const parte = partes[i] + BOT_SIGNATURE;

            if (deveEnviarAudio) {
                try {
                    await gerarEEnviarAudio(inst, lead, parte, cfg.apiKey);
                } catch (e) {
                    log(inst, 'erro', '[TTS] Falhou: ' + e.message);
                    // Fallback para texto se TTS falhar
                    await enviarTexto(inst, lead.numero, parte);
                    await salvarMensagemDB(inst, lead.id, parte, 'text');
                }
            }

            if (deveEnviarTexto) {
                await enviarTexto(inst, lead.numero, parte);
                await salvarMensagemDB(inst, lead.id, parte, 'text');
            }
        }

        // ── 7. Verificar mídias inteligentes ──
        await verificarEEnviarMidias(inst, lead, mensagemClienteTexto);

        // ── 8. Executar ação de agenda (se IA confirmou com a tag) ──
        if (agendaAcaoPendente) {
            agendaExecutar(inst, lead, agendaAcaoPendente, resposta).catch(e => {
                log(inst, 'warn', `[Agenda] Falha ao executar: ${e.message}`);
            });
        }

        log(inst, 'ok', `✅ ${getLeadName(lead)} respondido (${partes.length} parte(s))`);

        // ── 9. Detecção de intenção ──
        // (já executada em processarMensagem para todos os planos com ia_atendimento)

    } catch (e) {
        log(inst, 'erro', `Falha ao responder ${getLeadName(lead)}: ${e.message}`);
    } finally {
        delete s.respondendo[lead.id];
    }
}

// ─── DETECÇÃO DE INTENÇÃO — TAREFAS, NOTIFICAÇÕES E FUNIL ────────────────────
async function carregarColunasKanban(inst, dept = 'ADM Principal') {
    try {
        const { data } = await db
            .from('kanban_columns')
            .select('columns_json')
            .eq('instance_name', inst)
            .single();
        if (!data?.columns_json) return [];
        const parsed = JSON.parse(data.columns_json);
        const mapa = Array.isArray(parsed) ? { 'ADM Principal': parsed } : parsed;
        return mapa[dept] || mapa['ADM Principal'] || [];
    } catch (e) { return []; }
}

async function detectarIntencaoEAgir(inst, lead, mensagemTexto, apiKey) {
    const leadName = getLeadName(lead);
    log(inst, 'info', `[Intent] Iniciando análise — ${leadName}: "${mensagemTexto.substring(0, 60)}"`);

    // ── Carregar departamentos disponíveis para roteamento ────────────────
    let departamentos = [];
    try {
        const { data: depts } = await db.from('departments').select('*').eq('instance_name', inst);
        departamentos = (depts || []).map(d => ({ name: d.name || d.nome, descricao: d.descricao || '' }));
    } catch(e) {}
    const listaDepts = departamentos.length > 0
        ? departamentos.map(d => `- "${d.name}"${d.descricao ? ` (${d.descricao})` : ''}`).join('\n')
        : '- "ADM Principal"';

    // ── PASSO 1: Detectar intenção via OpenAI ────────────────────────────
    let intent = {};
    try {
        const intentRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                temperature: 0,
                max_tokens: 500,
                messages: [{
                    role: 'system',
                    content: `Analise a mensagem do cliente e retorne APENAS JSON válido sem markdown:
{
  "interesse_produto": { "detectado": boolean, "produto": "nome do produto/serviço ou null" },
  "suporte": { "detectado": boolean, "problema": "resumo curto ou null", "urgencia": "alta|media|baixa" },
  "possivel_venda": { "detectado": boolean, "motivo": "resumo ou null" },
  "tarefa": { "detectado": boolean, "titulo": "título curto ou null", "descricao": "detalhes ou null", "prioridade": "alta|media|baixa", "prazo": "YYYY-MM-DDTHH:MM ou null" },
  "roteamento_departamento": { "detectado": boolean, "departamento": "nome exato do departamento ou null", "motivo": "resumo curto ou null" }
}
Regras:
- interesse_produto: cliente pergunta preço, disponibilidade ou demonstra interesse em produto/serviço
- suporte: cliente relata problema técnico, reclamação ou pede ajuda urgente
- possivel_venda: expressões de intenção de compra (contratar, quero comprar, quero fechar, etc.)
- tarefa: cliente solicita explicitamente ação de follow-up da equipe
- roteamento_departamento: identifique o departamento mais adequado para atender o cliente. Use o nome EXATO da lista abaixo. Se a mensagem for sobre vendas, compra, contratação → departamento comercial/vendas. Se for suporte técnico → suporte. Se não souber, use null.

Departamentos disponíveis:
${listaDepts}`
                }, {
                    role: 'user',
                    content: `Mensagem do cliente (${leadName}): "${mensagemTexto}"`
                }]
            })
        });
        if (!intentRes.ok) throw new Error('OpenAI HTTP ' + intentRes.status);
        const intentData = await intentRes.json();
        const raw = intentData?.choices?.[0]?.message?.content || '{}';
        intent = JSON.parse(raw.replace(/```json|```/g, '').trim());
        log(inst, 'info', `[Intent] Resultado: interesse=${intent?.interesse_produto?.detectado} | suporte=${intent?.suporte?.detectado} | venda=${intent?.possivel_venda?.detectado} | tarefa=${intent?.tarefa?.detectado} | dept=${intent?.roteamento_departamento?.departamento || 'nenhum'}`);
    } catch (e) {
        log(inst, 'warn', `[Intent] Falha na detecção OpenAI: ${e.message} — abortando`);
        return;
    }

    // ── PASSO 2: TAG "possível venda" ────────────────────────────────────
    if (intent?.possivel_venda?.detectado) {
        try {
            const { data: leadAtual } = await db.from('leads').select('etiquetas').eq('id', lead.id).single();
            const etiquetasAtuais = (leadAtual?.etiquetas || '').split(',').map(t => t.trim()).filter(Boolean);
            if (!etiquetasAtuais.includes('possivel venda')) {
                const novas = [...etiquetasAtuais, 'possivel venda'].join(',');
                const { error } = await db.from('leads').update({ etiquetas: novas }).eq('id', lead.id);
                if (error) throw new Error(error.message);
                log(inst, 'ok', `[Intent] 🏷️ Tag "possivel venda" → ${leadName}`);
            }
        } catch (e) { log(inst, 'warn', `[Intent] Falha tag: ${e.message}`); }
    }

    // ── PASSO 3: NOTIFICAÇÃO — Interesse em produto ──────────────────────
    if (intent?.interesse_produto?.detectado) {
        const produto = intent.interesse_produto.produto || 'produto não identificado';
        try {
            const { error } = await db.from('dash_notifs').insert({
                instance_name: inst,
                title: `🛍️ Interesse detectado — ${leadName}`,
                body: `Interesse em: ${produto}. Contato: ${lead.numero}`,
                type: 'success', read: false, criado_por_ia: true, lead_id: lead.id
            });
            if (error) throw new Error(error.message);
            log(inst, 'ok', `[Intent] 🛍️ Notif interesse salva — ${leadName}: ${produto}`);
        } catch (e) { log(inst, 'warn', `[Intent] Falha notif interesse: ${e.message}`); }
    }

    // ── PASSO 4: NOTIFICAÇÃO — Suporte/Reclamação ────────────────────────
    if (intent?.suporte?.detectado) {
        const problema = intent.suporte.problema || 'problema não identificado';
        const urgencia = intent.suporte.urgencia || 'media';
        const tipo = urgencia === 'alta' ? 'error' : urgencia === 'media' ? 'warning' : 'info';
        try {
            const { error } = await db.from('dash_notifs').insert({
                instance_name: inst,
                title: `🆘 Suporte${urgencia === 'alta' ? ' URGENTE' : ''} — ${leadName}`,
                body: `${problema}. Urgência: ${urgencia}. Contato: ${lead.numero}`,
                type: tipo, read: false, criado_por_ia: true, lead_id: lead.id
            });
            if (error) throw new Error(error.message);
            log(inst, 'ok', `[Intent] 🆘 Notif suporte salva — ${leadName} (${urgencia}): ${problema}`);
        } catch (e) { log(inst, 'warn', `[Intent] Falha notif suporte: ${e.message}`); }
    }

    // ── PASSO 5: TAREFA ──────────────────────────────────────────────────
    if (intent?.tarefa?.detectado) {
        const titulo    = intent.tarefa.titulo     || `Follow-up — ${leadName}`;
        const descricao = intent.tarefa.descricao  || `Solicitado via chat.`;
        const prioridade= intent.tarefa.prioridade || 'media';
        const prazo     = intent.tarefa.prazo      || null;
        try {
            const { error } = await db.from('dash_tasks').insert({
                instance_name: inst,
                title:    titulo,
                "desc": `${descricao}\n\nCliente: ${leadName} (${lead.numero})`,
                priority: prioridade,
                due:      prazo,
                tag:      'geral',
                done:     false,
                criado_por_ia: true,
                lead_id:  lead.id
            });
            if (error) throw new Error(error.message);
            log(inst, 'ok', `[Intent] ✅ Tarefa salva — ${leadName}: "${titulo}" (${prioridade})`);
        } catch (e) { log(inst, 'warn', `[Intent] Falha tarefa: ${e.message}`); }
    }

    // ── PASSO 6: ROTEAMENTO AUTOMÁTICO DE DEPARTAMENTO ───────────────────
    // Move o lead para o departamento sugerido pela IA e emite alerta em tempo real
    if (intent?.roteamento_departamento?.detectado && intent.roteamento_departamento.departamento) {
        const deptDestino = intent.roteamento_departamento.departamento;
        const deptAtual = lead.departamento || 'ADM Principal';
        const motivo = intent.roteamento_departamento.motivo || '';

        // Só roteia se o departamento for diferente do atual
        if (deptDestino !== deptAtual) {
            // Verifica se o departamento existe
            const deptExiste = departamentos.some(d => d.name === deptDestino);
            if (deptExiste) {
                try {
                    // Atualiza o departamento do lead no banco
                    const { error } = await db.from('leads').update({ departamento: deptDestino }).eq('id', lead.id);
                    if (error) throw new Error(error.message);

                    // Atualiza o cache local
                    const s = getState(inst);
                    if (s.leads[lead.id]) s.leads[lead.id].departamento = deptDestino;

                    // Salva notificação no banco (visível no dashboard)
                    await db.from('dash_notifs').insert({
                        instance_name: inst,
                        title: `📋 Cliente direcionado → ${deptDestino}`,
                        body: `${leadName} foi encaminhado automaticamente para ${deptDestino}. ${motivo}. Contato: ${lead.numero}`,
                        type: 'info', read: false, criado_por_ia: true, lead_id: lead.id
                    }).catch(() => {});

                    // Emite alerta em tempo real via WebSocket para todos os conectados
                    wsEmit(inst, {
                        type: 'dept_route',
                        departamento: deptDestino,
                        lead_id: lead.id,
                        lead_nome: leadName,
                        lead_numero: lead.numero,
                        motivo: motivo,
                        de: deptAtual
                    });

                    // Entra na fila do novo departamento
                    enfileirarLead(inst, lead, deptDestino, motivo).catch(()=>{});

                    log(inst, 'ok', `[Intent] 📋 Roteamento: ${leadName} → "${deptDestino}" (de "${deptAtual}") — ${motivo}`);
                } catch (e) {
                    log(inst, 'warn', `[Intent] Falha roteamento dept: ${e.message}`);
                }
            } else {
                log(inst, 'info', `[Intent] Dept "${deptDestino}" não existe — roteamento ignorado`);
            }
        } else {
            log(inst, 'info', `[Intent] Lead já está no dept "${deptAtual}" — sem roteamento`);
        }
    }

    // ── PASSO 7: FUNIL/KANBAN ────────────────────────────────────────────
    // Roda por último e nunca impede os passos anteriores
    try {
        const deptParaKanban = lead.departamento || 'ADM Principal';
        const colunas = await carregarColunasKanban(inst, deptParaKanban);
        const colunasComIA = colunas.filter(c => c.ia_ativo && c.ia_descricao && c.id !== lead.status);

        if (colunasComIA.length === 0) {
            log(inst, 'info', `[Intent] Funil: nenhuma coluna com IA ativa — pulando`);
            return; // Só sai daqui, notifs/tarefas já foram salvas acima
        }

        const colAtual = colunas.find(c => c.id === lead.status);
        const listaEtapas = colunasComIA
            .map((c, i) => `${i+1}. ID: "${c.id}" | Nome: "${c.name}" | Critério: ${c.ia_descricao}`)
            .join('\n');

        const funilRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini', temperature: 0, max_tokens: 120,
                messages: [{
                    role: 'system',
                    content: `Classifique o lead para o kanban. Retorne APENAS JSON sem markdown:
{ "mover": boolean, "etapa_id": "id_exato_da_etapa ou null", "motivo": "resumo em até 10 palavras" }
- Use o ID EXATO da etapa conforme listado
- mover: true SOMENTE se mensagem corresponder CLARAMENTE ao critério
- Mensagens genéricas ou cumprimentos → mover: false`
                }, {
                    role: 'user',
                    content: `Mensagem do cliente (${leadName}): "${mensagemTexto}"\nEtapa atual: "${colAtual?.name || lead.status}"\n\nEtapas disponíveis:\n${listaEtapas}`
                }]
            })
        });
        if (!funilRes.ok) throw new Error('OpenAI funil HTTP ' + funilRes.status);
        const funilData = await funilRes.json();
        let funilIntent = {};
        try { funilIntent = JSON.parse((funilData?.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim()); } catch(e) {}

        log(inst, 'info', `[Intent] Funil result: mover=${funilIntent.mover} | etapa="${funilIntent.etapa_id}" | motivo="${funilIntent.motivo}"`);

        if (funilIntent.mover && funilIntent.etapa_id && funilIntent.etapa_id !== lead.status) {
            const colDestino = colunas.find(c => c.id === funilIntent.etapa_id);
            if (!colDestino) {
                log(inst, 'warn', `[Intent] Funil: etapa_id "${funilIntent.etapa_id}" não encontrada. IDs válidos: ${colunas.map(c=>c.id).join(', ')}`);
                return;
            }
            const { error: errLead } = await db.from('leads').update({ status: colDestino.id }).eq('id', lead.id);
            if (errLead) throw new Error(errLead.message);
            const s = getState(inst);
            if (s.leads[lead.id]) s.leads[lead.id].status = colDestino.id;
            const { error: errNotif } = await db.from('dash_notifs').insert({
                instance_name: inst,
                title: `🎯 Lead movido pela IA`,
                body: `${leadName} → ${colDestino.name}. ${funilIntent.motivo || ''}`,
                type: 'info', read: false, criado_por_ia: true, lead_id: lead.id
            });
            if (errNotif) log(inst, 'warn', `[Intent] Notif funil falhou: ${errNotif.message}`);
            log(inst, 'ok', `[Intent] 🎯 Kanban: ${leadName} → "${colDestino.name}" — ${funilIntent.motivo}`);
        }
    } catch (e) {
        log(inst, 'warn', `[Intent] Funil falhou: ${e.message}`);
    }
}


// ─── DIVIDIR MENSAGEM ─────────────────────────────────────────────────────────
function dividirMensagem(texto, maxChars) {
    if (!maxChars || maxChars === 0 || texto.length <= maxChars) return [texto];
    const partes = [];
    const paragrafos = texto.split(/\n\n+/);
    let atual = '';
    for (const p of paragrafos) {
        if ((atual + (atual ? '\n\n' : '') + p).length <= maxChars) {
            atual += (atual ? '\n\n' : '') + p;
        } else {
            if (atual) partes.push(atual.trim());
            atual = p.length > maxChars ? p.substring(0, maxChars) : p;
        }
    }
    if (atual.trim()) partes.push(atual.trim());
    return partes.filter(p => p.length > 0);
}

// ─── PROCESSAR MENSAGEM RECEBIDA ──────────────────────────────────────────────
async function processarMensagem(inst, payload) {
    const s = getState(inst);
    const msg = payload.new;

    if (msg.instance_name !== inst) return;
    if (msg.from_me) {
        // sent_by_ia: true  → IA respondeu → ignora (não pausa)
        // sent_by_ia: false → humano enviou pelo CRM → PAUSA
        // sent_by_ia: null/undefined → veio do WhatsApp (Android/iOS/Desktop) → PAUSA
        if (msg.sent_by_ia === true) return;

        const lead = s.leads[msg.lead_id];
        const nome = lead ? getLeadName(lead) : msg.lead_id;

        // ─── PROTEÇÃO REDUNDANTE: garante que nome não ficou contaminado ─────────
        // O listener de leads acima já reverte, mas essa camada adicional garante
        // que se o evento de leads chegou depois do evento de mensagem, o nome
        // ainda seja corrigido. Roda apenas para mensagens do WhatsApp (not CRM).
        if (msg.sent_by_ia === null || msg.sent_by_ia === undefined) {
            if (lead && s.operatorNames?.size > 0 && s.operatorNames.has((lead.nome || '').trim())) {
                const nomeSeguro = lead.numero;
                log(inst, 'warn', `[Perfil] 🛡️ (from_me) Nome do operador no lead ${lead.numero} — revertendo`);
                db.from('leads').update({ nome: nomeSeguro }).eq('id', lead.id)
                    .then(({ error }) => {
                        if (error) log(inst, 'warn', `[Perfil] Falha ao reverter nome (from_me): ${error.message}`);
                    });
                s.leads[lead.id] = { ...lead, nome: nomeSeguro };
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

        let fonte = 'WhatsApp';
        if (msg.sent_by_ia === false) fonte = 'CRM';

        log(inst, 'info', `🧑 Humano respondeu [${fonte}] para ${nome} — pausando IA`);

        // Cancela buffer pendente imediatamente — evita IA responder depois do humano
        const buf = s.bufferTimers[msg.lead_id];
        if (buf) {
            clearTimeout(buf);
            delete s.bufferTimers[msg.lead_id];
            delete s.bufferMsgs[msg.lead_id];
            log(inst, 'info', `🗑️ Buffer cancelado para ${nome}`);
        }

        pausarIA(inst, msg.lead_id, nome, { texto: msg.content, fonte });
        return;
    }

    // Mensagem do cliente
    const lead = s.leads[msg.lead_id];
    if (!lead) {
        // Tenta recarregar lead
        const { data } = await db.from('leads').select('*').eq('id', msg.lead_id).single();
        if (data) { s.leads[data.id] = data; }
        else { log(inst, 'warn', `Lead não encontrado: ${msg.lead_id}`); return; }
    }
    const leadAtual = s.leads[msg.lead_id];

    // ── Sincronizar nome via push_name que vem na mensagem ──────────────────
    // A tabela messages pode ter push_name salvo pelo n8n/webhook
    const pushName = msg.push_name || msg.pushName || msg.sender_name || null;
    const semNome = !leadAtual.nome || leadAtual.nome === leadAtual.numero
        || ['Lead Avulso', 'Lead Importado', 'Desconhecido'].includes(leadAtual.nome)
        || (s.operatorNames && s.operatorNames.size > 0 && s.operatorNames.has((leadAtual.nome || '').trim()));
    // ⚠️ SÓ atualiza nome se o lead NÃO tem nome real — evita sobrescrever nome existente
    // com push_name que pode ser o nome salvo no contato do operador (não o nome do cliente)
    if (pushName && pushName.trim().length > 1 && pushName !== leadAtual.numero && semNome
        && !(s.operatorNames && s.operatorNames.has(pushName.trim()))) {
        try {
            await db.from('leads').update({ nome: pushName }).eq('id', leadAtual.id);
            s.leads[leadAtual.id] = { ...leadAtual, nome: pushName };
            log(inst, 'ok', `[Perfil] Nome sincronizado: "${pushName}" para ${leadAtual.numero}`);
        } catch(e) { log(inst, 'warn', `[Perfil] Falha ao salvar nome: ${e.message}`); }
    }

    // ── Detecção de bot — bloqueia loop antes de qualquer processamento ──────
    const botCheck = detectarBot(inst, msg, pushName);
    if (botCheck.bloqueado) {
        log(inst, 'warn', `🤖 [AntiBot] Mensagem bloqueada (${botCheck.motivo}) — lead: ${getLeadName(leadAtual)}`);
        return;
    }

    const cfg = s.config;

    // ── Detecção de intenção — roda para QUALQUER mensagem se feature ia_atendimento ativa ──
    // Independe de cfg.ativo — notificações e tarefas funcionam mesmo com IA de resposta desligada
    if (msg.content && cfg?.apiKey && temFeature(inst, 'ia_atendimento')) {
        detectarIntencaoEAgir(inst, leadAtual, msg.content, cfg.apiKey).catch(e => {
            log(inst, 'warn', `[Intent] Falha silenciosa: ${e.message}`);
        });
    }

    if (!cfg || !cfg.ativo || !cfg.apiKey || !cfg.prompt) {
        const motivo = !cfg ? 'config nula' : !cfg.ativo ? 'IA desativada' : !cfg.apiKey ? 'API Key vazia' : 'Prompt vazio';
        log(inst, 'warn', `⛔ IA bloqueada [${motivo}] — ativo:${cfg?.ativo} | key:${!!cfg?.apiKey} | prompt:${!!cfg?.prompt}`);
        chatbotChecarMensagem(inst, msg.content, leadAtual).catch(e => {
            log(inst, 'warn', `[Bot] Erro: ${e.message}`);
        });
        return;
    }

    if (cfg.pausaSeHumano && s.humanoAtivo[msg.lead_id]) {
        const timer = s.humanoTimers[msg.lead_id];
        const restanteMin = timer ? '(retoma automaticamente)' : '(sem timer — retome manualmente)';
        log(inst, 'warn', `⏸️ IA pausada para ${getLeadName(leadAtual)} ${restanteMin} — envie a palavra-retomar para reativar`);
        return;
    }

    // Adicionar ao buffer (IA)
    setTimeout(() => bufferAdicionarMsg(inst, leadAtual, msg), 500);

    // Chatbot por palavra-chave — roda independente da IA
    chatbotChecarMensagem(inst, msg.content, leadAtual).catch(e => {
        log(inst, 'warn', `[Bot] Erro: ${e.message}`);
    });

    // Análise de sentimento — roda sempre que chega msg do cliente (assíncrono, sem bloquear)
    if (msg.content && !msg.from_me && cfg?.apiKey) {
        setTimeout(() => analisarSentimentoLead(inst, leadAtual.id, cfg.apiKey).catch(() => {}), 2000);
    }
}

// ─── AUTO-SETUP: cria configurações padrão se não existirem ──────────────────
async function autoSetupInstancia(inst) {
    // 1. Kanban — cria colunas padrão se não existir
    try {
        const { data: kanban } = await db.from('kanban_columns').select('columns_json').eq('instance_name', inst).single();
        if (!kanban || !kanban.columns_json) {
            const cols = [
                { id: 'triagem',  name: 'TRIAGEM',  cor: '#6366f1', ia_ativo: false, ia_descricao: '' },
                { id: 'negocio',  name: 'NEGÓCIO',  cor: '#f59e0b', ia_ativo: false, ia_descricao: '' },
                { id: 'proposta', name: 'PROPOSTA', cor: '#10b981', ia_ativo: false, ia_descricao: '' },
                { id: 'venda',    name: 'VENDA',    cor: '#22c55e', ia_ativo: false, ia_descricao: '' },
            ];
            const kanbanMap = { 'ADM Principal': cols };
            await db.from('kanban_columns').upsert({ instance_name: inst, columns_json: JSON.stringify(kanbanMap), updated_at: new Date().toISOString() }, { onConflict: 'instance_name' });
            log(inst, 'ok', `[Setup] Kanban padrão criado (4 colunas)`);
        }
    } catch(e) {
        try {
            const cols = [
                { id: 'triagem',  name: 'TRIAGEM',  cor: '#6366f1', ia_ativo: false, ia_descricao: '' },
                { id: 'negocio',  name: 'NEGÓCIO',  cor: '#f59e0b', ia_ativo: false, ia_descricao: '' },
                { id: 'proposta', name: 'PROPOSTA', cor: '#10b981', ia_ativo: false, ia_descricao: '' },
                { id: 'venda',    name: 'VENDA',    cor: '#22c55e', ia_ativo: false, ia_descricao: '' },
            ];
            const kanbanMap2 = { 'ADM Principal': cols };
            await db.from('kanban_columns').upsert({ instance_name: inst, columns_json: JSON.stringify(kanbanMap2), updated_at: new Date().toISOString() }, { onConflict: 'instance_name' });
            log(inst, 'ok', `[Setup] Kanban padrão criado`);
        } catch(e2) {}
    }

    // 2. Agenda config
    try {
        const { data: agCfg } = await db.from('agenda_config').select('id').eq('instance_name', inst).single();
        if (!agCfg) {
            await db.from('agenda_config').insert({
                instance_name: inst, ia_verificar: false,
                dias_semana: JSON.stringify({ '1': true, '2': true, '3': true, '4': true, '5': true }),
                horario_inicio: '08:00', horario_fim: '18:00', duracao_slot: 60,
                almoco_ativo: false, almoco_inicio: '12:00', almoco_fim: '13:00', max_por_dia: 8,
            });
            log(inst, 'ok', `[Setup] Agenda config criada`);
        }
    } catch(e) {
        await db.from('agenda_config').insert({
            instance_name: inst, ia_verificar: false,
            dias_semana: JSON.stringify({ '1': true, '2': true, '3': true, '4': true, '5': true }),
            horario_inicio: '08:00', horario_fim: '18:00', duracao_slot: 60,
            almoco_ativo: false, almoco_inicio: '12:00', almoco_fim: '13:00', max_por_dia: 8,
        }).catch(() => {});
    }

    // 3. Automação config
    try {
        const { data: arCfg } = await db.from('auto_replies_config').select('id').eq('instance_name', inst).single();
        if (!arCfg) {
            await db.from('auto_replies_config').insert({ instance_name: inst, bot_ativo: true });
            log(inst, 'ok', `[Setup] Automação config criada`);
        }
    } catch(e) {
        await db.from('auto_replies_config').insert({ instance_name: inst, bot_ativo: true }).catch(() => {});
    }

    // 4. Departamento padrão
    try {
        const { data: depts } = await db.from('departments').select('id').eq('instance_name', inst);
        if (!depts || depts.length === 0) {
            await db.from('departments').insert({ instance_name: inst, name: 'ADM Principal', access_key: 'admin123', cor: '#6366f1', descricao: 'Departamento principal' });
            log(inst, 'ok', `[Setup] Departamento padrão criado`);
        }
    } catch(e) {}
}

// Retorna o ID da primeira coluna do kanban (para novos leads)
async function getPrimeiraColuna(inst) {
    try {
        const { data } = await db.from('kanban_columns').select('columns_json').eq('instance_name', inst).single();
        if (data && data.columns_json) {
            const parsed = JSON.parse(data.columns_json);
            const cols = Array.isArray(parsed)
                ? parsed
                : (parsed['ADM Principal'] || Object.values(parsed)[0] || []);
            if (Array.isArray(cols) && cols.length > 0) return cols[0].id;
        }
    } catch(e) {}
    return 'triagem';
}

// ─── INICIALIZAR INSTÂNCIA ────────────────────────────────────────────────────
async function inicializarInstancia(inst) {
    log(inst, 'info', `🚀 Inicializando instância...`);
    await autoSetupInstancia(inst); // garante configs padrão primeiro
    await carregarConfig(inst);
    await carregarFeatures(inst);
    await carregarLeads(inst);
    await carregarMidias(inst);
    await carregarPausas(inst);
    await carregarChatbot(inst);
    await carregarNomeOperador(inst); // carrega push name do operador para proteger nomes de lead

    // Recarrega leads e mídias periodicamente (fallback além do realtime)
    setInterval(() => carregarLeads(inst), 5 * 60 * 1000);
    setInterval(() => carregarConfig(inst), 2 * 60 * 1000); // recarrega IA config a cada 2min
    setInterval(() => carregarMidias(inst), 10 * 60 * 1000);
    setInterval(() => carregarFeatures(inst), 5 * 60 * 1000);
    setInterval(() => carregarNomeOperador(inst), 30 * 60 * 1000);

    // Checar agendamentos a cada 30s (envia mesmo com CRM fechado)
    setInterval(() => {
        checkAgendamentosServidor(inst);
        checkLembretesServidor(inst);
    }, 30 * 1000);

    // Follow-up / reengajamento a cada 2min
    setInterval(() => checkFollowUps(inst), 2 * 60 * 1000);

    // Sincronizar chats do WhatsApp a cada 10min (traz conversas que não estão no CRM)
    setInterval(() => sincronizarChatsWhatsApp(inst), 10 * 60 * 1000);

    // Checar imediatamente ao iniciar (pega agendamentos que passaram enquanto estava offline)
    setTimeout(() => checkAgendamentosServidor(inst), 3000);
    // Sincroniza chats do WhatsApp 10s após boot
    setTimeout(() => sincronizarChatsWhatsApp(inst), 10 * 1000);

    log(inst, 'ok', `✅ Instância ${inst} pronta! (IA + Agenda Worker ativos 24/7)`);
}

// ─── SINCRONIZAR CHATS DO WHATSAPP (traz todas as conversas para o CRM) ──────

async function sincronizarChatsWhatsApp(inst) {
    const s = getState(inst);
    try {
        // 1. Busca todos os chats da Evolution API
        const res = await fetch(`${EVO_URL}/chat/findChats/${inst}`, {
            method: 'POST',
            headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!res.ok) {
            log(inst, 'warn', `[SyncChats] Evolution API erro HTTP ${res.status}`);
            return;
        }
        const chats = await res.json();
        if (!Array.isArray(chats) || chats.length === 0) return;

        // 2. Filtra apenas chats individuais (ignora grupos e broadcasts)
        const chatsIndividuais = chats.filter(c => {
            const jid = c.id || c.remoteJid || '';
            return jid.includes('@s.whatsapp.net') && !jid.includes('@g.us') && !jid.includes('@broadcast');
        });
        if (chatsIndividuais.length === 0) return;

        // 3. Extrai números
        const numeros = chatsIndividuais.map(c => {
            const jid = c.id || c.remoteJid || '';
            return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
        }).filter(n => n && n.length >= 8);

        // 4. Busca leads existentes no CRM de uma vez
        const { data: leadsExistentes } = await db.from('leads')
            .select('numero')
            .eq('instance_name', inst);
        const numerosExistentes = new Set((leadsExistentes || []).map(l => l.numero));

        // 5. Filtra apenas os novos
        const novos = numeros.filter(n => !numerosExistentes.has(n));
        if (novos.length === 0) return;

        log(inst, 'info', `[SyncChats] ${novos.length} conversas novas encontradas no WhatsApp`);

        // 6. Busca contatos da Evolution para pegar nomes
        let contatosMap = {};
        try {
            const resContatos = await fetch(`${EVO_URL}/chat/findContacts/${inst}`, {
                method: 'POST',
                headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (resContatos.ok) {
                const contatos = await resContatos.json();
                if (Array.isArray(contatos)) {
                    for (const c of contatos) {
                        const jid = c.id || c.remoteJid || '';
                        const num = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
                        if (num) contatosMap[num] = c.pushName || c.verifiedBizName || c.name || '';
                    }
                }
            }
        } catch (e) {
            log(inst, 'warn', `[SyncChats] Erro ao buscar contatos: ${e.message}`);
        }

        // 7. Cria leads em lote (sem coluna kanban — status null)
        let criados = 0;
        for (const numero of novos) {
            try {
                const nome = contatosMap[numero] || numero;
                // Busca último chat para pegar timestamp
                const chatInfo = chatsIndividuais.find(c => {
                    const jid = c.id || c.remoteJid || '';
                    return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '') === numero;
                });

                await db.from('leads').insert({
                    instance_name: inst,
                    numero,
                    nome,
                    status: null,           // sem coluna kanban — fica só nas conversas gerais
                    departamento: 'ADM Principal',
                    unread: 0,
                    last_msg: '',
                    last_interaction: chatInfo?.updatedAt || chatInfo?.conversationTimestamp
                        ? new Date((chatInfo.conversationTimestamp || 0) * 1000).toISOString()
                        : new Date().toISOString(),
                    followup_count: 0,
                    followup_paused: false,
                });
                criados++;
            } catch (e) {
                // Ignora duplicatas silenciosamente (constraint unique)
                if (!e.message?.includes('duplicate') && !e.message?.includes('unique')) {
                    log(inst, 'warn', `[SyncChats] Erro ao criar lead ${numero}: ${e.message}`);
                }
            }
        }

        if (criados > 0) {
            log(inst, 'ok', `[SyncChats] ✅ ${criados} leads importados do WhatsApp (sem funil)`);
            // Recarrega cache de leads
            await carregarLeads(inst);
        }
    } catch (e) {
        log(inst, 'warn', `[SyncChats] Erro geral: ${e.message}`);
    }
}

// ─── FOLLOW-UP / REENGAJAMENTO AUTOMÁTICO ────────────────────────────────────

const FOLLOWUP_RECUSA_KEYWORDS = [
    'não quero', 'nao quero', 'sem interesse', 'não preciso', 'nao preciso',
    'para de mandar', 'pare de mandar', 'não mande mais', 'nao mande mais',
    'não me mande', 'nao me mande', 'sair', 'parar', 'cancelar',
    'não obrigado', 'nao obrigado', 'não obrigada', 'nao obrigada',
    'me remove', 'me tire', 'me tira', 'chega', 'basta',
    'não quero receber', 'nao quero receber', 'desinscrever',
    'não tenho interesse', 'nao tenho interesse', 'deixa pra lá',
    'deixa quieto', 'esquece', 'não vale', 'nao vale'
];

function followupTempoParaMs(valor, unidade) {
    const map = {
        'minutos':  60 * 1000,
        'horas':    60 * 60 * 1000,
        'dias':     24 * 60 * 60 * 1000,
        'semanas':  7 * 24 * 60 * 60 * 1000,
        'mes':      30 * 24 * 60 * 60 * 1000,
    };
    return (valor || 0) * (map[unidade] || map['minutos']);
}

function followupTempoTexto(valor, unidade) {
    const labels = {
        'minutos': ['minuto', 'minutos'],
        'horas': ['hora', 'horas'],
        'dias': ['dia', 'dias'],
        'semanas': ['semana', 'semanas'],
        'mes': ['mês', 'meses'],
    };
    const l = labels[unidade] || ['minuto', 'minutos'];
    return `${valor} ${valor === 1 ? l[0] : l[1]}`;
}

function followupDentroHorario(cfg) {
    const agora = new Date();
    const horaLocal = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();
    const inicio = cfg.followupHorarioInicio ?? 8;
    const fim = cfg.followupHorarioFim ?? 20;
    return horaLocal >= inicio && horaLocal < fim;
}

function followupDetectarRecusa(texto) {
    if (!texto) return false;
    const lower = texto.toLowerCase().trim();
    return FOLLOWUP_RECUSA_KEYWORDS.some(kw => lower.includes(kw));
}

async function checkFollowUps(inst) {
    const s = getState(inst);
    const cfg = s.config;
    if (!cfg || !cfg.followupAtivo || !cfg.apiKey) return;
    if (!followupDentroHorario(cfg)) return;

    const maxTentativas = cfg.followupMaxTentativas || 3;
    const colunasIgnorar = (cfg.followupIgnorarColunas || '')
        .split(',').map(c => c.trim().toLowerCase()).filter(Boolean);

    try {
        const { data: leads, error } = await db.from('leads')
            .select('id, numero, nome, status, last_interaction, followup_count, followup_last_at, followup_paused, followup_lead_ativo, last_msg, departamento')
            .eq('instance_name', inst)
            .eq('followup_lead_ativo', true)
            .lt('followup_count', maxTentativas)
            .not('last_interaction', 'is', null)
            .order('last_interaction', { ascending: true })
            .limit(50);

        if (error) { log(inst, 'warn', `[FollowUp] Erro ao buscar leads: ${error.message}`); return; }
        if (!leads || leads.length === 0) return;

        for (const lead of leads) {
            try {
                if (s.humanoAtivo[lead.id]) continue;

                if (colunasIgnorar.length > 0 && lead.status) {
                    const colunas = await carregarColunasKanban(inst, lead.departamento || 'ADM Principal');
                    const colAtual = colunas.find(c => c.id === lead.status);
                    if (colAtual && colunasIgnorar.includes(colAtual.name.toLowerCase())) continue;
                }

                const { data: ultimaMsg } = await db.from('messages')
                    .select('from_me, content, created_at')
                    .eq('lead_id', lead.id)
                    .eq('instance_name', inst)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (!ultimaMsg || !ultimaMsg.from_me) continue;

                const tentativa = (lead.followup_count || 0) + 1;
                let tempoMs;
                if (tentativa === 1) tempoMs = followupTempoParaMs(cfg.followupTempo1, cfg.followupUnidade1);
                else if (tentativa === 2) tempoMs = followupTempoParaMs(cfg.followupTempo2, cfg.followupUnidade2);
                else tempoMs = followupTempoParaMs(cfg.followupTempo3, cfg.followupUnidade3);

                if (tempoMs <= 0) continue;

                const baseTime = lead.followup_last_at || lead.last_interaction;
                const desde = new Date(baseTime).getTime();
                if ((Date.now() - desde) < tempoMs) continue;

                const { data: historico } = await db.from('messages')
                    .select('content, from_me')
                    .eq('lead_id', lead.id)
                    .eq('instance_name', inst)
                    .order('created_at', { ascending: false })
                    .limit(5);

                const contexto = (historico || []).reverse().map(m =>
                    `${m.from_me ? 'Você' : 'Cliente'}: ${(m.content || '').substring(0, 150)}`
                ).join('\n');

                const tempoTexto = followupTempoTexto(
                    tentativa === 1 ? cfg.followupTempo1 : tentativa === 2 ? cfg.followupTempo2 : cfg.followupTempo3,
                    tentativa === 1 ? cfg.followupUnidade1 : tentativa === 2 ? cfg.followupUnidade2 : cfg.followupUnidade3
                );

                // Pega o prompt principal da IA para manter tom/personalidade do negócio
                const promptBase = (cfg.prompt || '').substring(0, 500);

                const promptFollowup = `${promptBase ? 'CONTEXTO DO NEGÓCIO (use o tom e personalidade abaixo):\n' + promptBase + '\n\n' : ''}TAREFA: Você precisa reengajar um cliente via WhatsApp.
O cliente "${getLeadName(lead)}" não respondeu há ${tempoTexto}.
Esta é a tentativa ${tentativa} de ${maxTentativas} de reengajamento.

Últimas mensagens da conversa:
${contexto}

REGRAS:
1. Se o cliente demonstrou DESINTERESSE, RECUSOU, pediu para PARAR, ou ENCERROU a conversa nas mensagens acima, retorne EXATAMENTE: {"skip":true,"motivo":"razão curta"}
2. Se é apropriado tentar reengajar, retorne EXATAMENTE: {"skip":false,"mensagem":"sua mensagem aqui"}
3. A mensagem deve ser CURTA (máx 2 linhas), natural, amigável e NÃO invasiva
4. ${tentativa === 1 ? 'Primeira tentativa: seja sutil, como se estivesse retomando naturalmente a conversa' : ''}${tentativa === 2 ? 'Segunda tentativa: seja mais direto, pergunte se ainda tem interesse, reforce benefícios' : ''}${tentativa >= 3 ? 'Terceira tentativa: insista com senso de urgência, ofereça algo especial ou destaque uma oportunidade que está perdendo' : ''}
5. NUNCA use linguagem robótica ou templates. Seja humano e contextualizado.
6. Mantenha o mesmo tom, linguagem e personalidade do CONTEXTO DO NEGÓCIO acima.
7. Retorne APENAS o JSON, sem markdown, sem texto extra.`;

                const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: cfg.modelo || 'gpt-4o-mini',
                        max_tokens: 200,
                        temperature: 0.7,
                        messages: [{ role: 'user', content: promptFollowup }]
                    })
                });

                if (!aiRes.ok) { log(inst, 'warn', `[FollowUp] OpenAI erro HTTP ${aiRes.status}`); continue; }

                const aiData = await aiRes.json();
                const aiText = (aiData.choices?.[0]?.message?.content || '').trim();

                let parsed;
                try { parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim()); }
                catch (e) { log(inst, 'warn', `[FollowUp] JSON inválido da IA para ${getLeadName(lead)}: ${aiText.substring(0, 100)}`); continue; }

                if (parsed.skip) {
                    log(inst, 'info', `[FollowUp] ⏭️ Skip ${getLeadName(lead)} — ${parsed.motivo || 'sem interesse'}`);
                    await db.from('leads').update({ followup_lead_ativo: false }).eq('id', lead.id);
                    continue;
                }

                const msgTexto = parsed.mensagem || parsed.msg || '';
                if (!msgTexto) continue;

                const delay = ((cfg.delayMin || 1) + Math.random() * ((cfg.delayMax || 3) - (cfg.delayMin || 1))) * 1000;
                await new Promise(r => setTimeout(r, delay));

                await enviarTexto(inst, lead.numero, msgTexto);
                await salvarMensagemDB(inst, lead.id, msgTexto, 'text', { sent_by_ia: true });

                await db.from('leads').update({
                    followup_count: (lead.followup_count || 0) + 1,
                    followup_last_at: new Date().toISOString(),
                    last_msg: msgTexto,
                    last_interaction: new Date().toISOString(),
                }).eq('id', lead.id);

                log(inst, 'ok', `[FollowUp] 🔄 Tentativa ${tentativa}/${maxTentativas} enviada para ${getLeadName(lead)}`);
            } catch (e) {
                log(inst, 'warn', `[FollowUp] Erro no lead ${lead.id}: ${e.message}`);
            }
        }
    } catch (e) {
        log(inst, 'warn', `[FollowUp] Erro geral: ${e.message}`);
    }
}

// ─── REALTIME: SQLite dbEvents (substitui PostgreSQL LISTEN/NOTIFY) ──────────
// db.js emite 'change' após cada INSERT/UPDATE/DELETE.
// Aqui centralizamos: IA, WebSocket, cache de leads e recargas automáticas.
// Chamado UMA VEZ ao iniciar — ouve eventos de TODAS as instâncias.

const { dbEvents } = require('./db.js');
let _dbListenerAtivo = false;

function setupGlobalDbListener() {
    if (_dbListenerAtivo) return;
    _dbListenerAtivo = true;

    dbEvents.on('change', async (payload) => {
        const { table, action, data, old: oldData } = payload;
        const eventType = action === 'INSERT' ? 'INSERT' : action === 'UPDATE' ? 'UPDATE' : action === 'UPSERT' ? 'UPDATE' : 'DELETE';
        const normalized = { eventType, new: data, old: oldData };

        // Descobre a instância pelo dado recebido
        const inst = data?.instance_name || oldData?.instance_name;
        if (!inst) return;

        const s = getState(inst);

        // ── messages: INSERT dispara IA + notifica browser ─────────────────
        if (table === 'messages' && eventType === 'INSERT') {
            processarMensagem(inst, normalized);
            wsEmit(inst, { type: 'messages', event: 'INSERT', data, old: null });
        }
        if (table === 'messages' && eventType === 'UPDATE') {
            wsEmit(inst, { type: 'messages', event: 'UPDATE', data, old: oldData });
        }

        // ── leads: sincroniza cache local + notifica browser ───────────────
        if (table === 'leads') {
            if (eventType === 'INSERT' || eventType === 'UPDATE') {
                const novo = data;
                if (eventType === 'UPDATE' && novo.nome && s.operatorNames?.size > 0 && s.operatorNames.has(novo.nome.trim())) {
                    const leadEmCache = s.leads[novo.id];
                    const nomeEmCache = leadEmCache?.nome || '';
                    const nomeEhValido = nomeEmCache && nomeEmCache !== novo.numero && nomeEmCache.trim().length > 1 && !s.operatorNames.has(nomeEmCache.trim());
                    const nomeSeguro = nomeEhValido ? nomeEmCache : novo.numero;
                    log(inst, 'warn', `[Perfil] 🛡️ Nome operador detectado — revertendo para "${nomeSeguro}"`);
                    db.from('leads').update({ nome: nomeSeguro }).eq('id', novo.id).then(()=>{},()=>{});
                    s.leads[novo.id] = { ...novo, nome: nomeSeguro };
                    wsEmit(inst, { type: 'leads', event: 'UPDATE', data: { ...novo, nome: nomeSeguro } });
                    return;
                }
                s.leads[novo.id] = novo;
                wsEmit(inst, { type: 'leads', event: eventType, data: novo, old: oldData });
            } else if (eventType === 'DELETE') {
                delete s.leads[oldData?.id];
                wsEmit(inst, { type: 'leads', event: 'DELETE', data: oldData });
            }
        }

        // ── ia_config: recarrega automaticamente ──────────────────────────
        if (table === 'ia_config') {
            log(inst, 'info', '🔄 Config IA atualizada — recarregando...');
            await carregarConfig(inst);
            await carregarMidias(inst);
        }

        // ── admin_config: global_api_key alterada → recarrega todas as instâncias ──
        if (table === 'admin_config' && data?.key === 'global_api_key') {
            log('sistema', 'info', '🔑 API Key global atualizada — recarregando config de todas as instâncias...');
            for (const instAtiva of Object.keys(state)) {
                try { await carregarConfig(instAtiva); } catch(e) {}
            }
        }

        // ── licenses: recarrega features ──────────────────────────────────
        if (table === 'licenses') {
            log(inst, 'info', '🔄 Licença alterada — recarregando features...');
            await carregarFeatures(inst);
        }

        // ── auto_replies / config: recarrega chatbot ──────────────────────
        if (table === 'auto_replies' || table === 'auto_replies_config') {
            log(inst, 'info', '[Bot] Regras atualizadas — recarregando...');
            await carregarChatbot(inst);
        }

        // ── ia_pausa: sincroniza estado de pausa em tempo real ────────────
        // Garante que retomar/pausar pelo frontend reflete imediatamente na memória do servidor
        if (table === 'ia_pausa') {
            const leadId = data?.lead_id;
            if (leadId) {
                const pausado = data?.pausado;
                const lead = s.leads[leadId];
                const nome = lead ? getLeadName(lead) : leadId;
                if (pausado === false || pausado === 0) {
                    retomarIA(inst, leadId, nome, 'reativado pelo usuário');
                } else if ((pausado === true || pausado === 1) && !s.humanoAtivo[leadId]) {
                    s.humanoAtivo[leadId] = true;
                    log(inst, 'info', `🧑 IA pausada (banco) para ${nome}`);
                }
            }
        }

        // ── agendamentos: verifica imediatamente ──────────────────────────
        if (table === 'agendamentos_crm') {
            checkAgendamentosServidor(inst);
        }

        // ── chat_interno: notifica browser em tempo real ──────────────────
        if (table === 'chat_interno' && eventType === 'INSERT') {
            wsEmit(inst, { type: 'chat_interno', event: 'INSERT', data });
        }
    });

    console.log('🔔 [DB] Listener SQLite ativo (eventos em tempo real)');
}

// ─── WEBSOCKET SERVER (substitui Supabase Realtime no browser) ───────────────
// O app.js se conecta via ws:// e recebe eventos em tempo real.
// Cada mensagem do servidor tem: { type: 'leads'|'messages', event: 'INSERT'|'UPDATE'|'DELETE', data: {...} }

const WebSocket = require('ws');
const wsClients = {}; // { inst: Set<ws> }

function wsEmit(inst, payload) {
    const clients = wsClients[inst];
    if (!clients || clients.size === 0) return;
    const msg = JSON.stringify(payload);
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

// ─── FILA DE ATENDIMENTO ─────────────────────────────────────────────────────
// Módulo externo (fila_manager.js) cuida da lógica de fila por departamento.
const filaMgr = require('./fila_manager');
filaMgr.init({ wsClients, fetch, EVO_URL, EVO_KEY });
log('sistema', 'ok', 'Fila de atendimento inicializada');

// Helper: chama ao direcionar um lead a um departamento.
// - Cria entrada na fila (se ainda não existe)
// - Avisa o cliente via WhatsApp com a posição
// - Broadcast WS já é feito dentro do fila_manager
const _enfileirandoSet = new Set();
async function enfileirarLead(inst, lead, departamento, motivo) {
    if (!inst || !lead?.id || !departamento) return null;
    // Guard contra race condition (chamadas concorrentes p/ mesmo lead)
    const chave = `${inst}:${lead.id}`;
    if (_enfileirandoSet.has(chave)) return null;
    _enfileirandoSet.add(chave);
    try {
        const r = await filaMgr.entrarNaFila(inst, lead, departamento, motivo || '');
        if (!r || r.jaEstava) return r;

        // Mensagem automática ao cliente
        const nomeCliente = (lead.nome || lead.push_name || '').split(' ')[0] || '';
        const saudacao = nomeCliente ? `Olá, ${nomeCliente}! ` : 'Olá! ';
        const texto = r.posicao === 1
            ? `${saudacao}Você é o próximo a ser atendido 🙌 Aguarde só um instante, já vamos responder.`
            : `${saudacao}Recebemos seu contato 👍 Você está na *posição ${r.posicao}* da fila do setor *${departamento}*. Assim que um atendente ficar livre, responderemos.`;

        if (lead.numero) {
            try {
                await fetch(`${EVO_URL}/message/sendText/${inst}`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number: lead.numero, text: texto })
                });
                await db.from('messages').insert({
                    instance_name: inst, lead_id: lead.id,
                    content: texto, type: 'text',
                    from_me: true, status: 'sent', sent_by_ia: true,
                    timestamp: new Date().toISOString(),
                    created_at: new Date().toISOString(),
                }).catch(() => {});
            } catch(e) { log(inst, 'warn', `[Fila] Falha msg fila p/ ${lead.numero}: ${e.message}`); }
        }

        log(inst, 'ok', `[Fila] ${lead.nome || lead.numero} → "${departamento}" (posição ${r.posicao})`);
        return r;
    } catch(e) {
        log(inst, 'warn', `[Fila] Falha ao enfileirar lead: ${e.message}`);
        return null;
    } finally {
        _enfileirandoSet.delete(chave);
    }
}

// ─── CARREGAR TODAS AS INSTÂNCIAS ATIVAS ─────────────────────────────────────
async function carregarInstancias() {
    try {
        const { data } = await db
            .from('licenses')
            .select('instance_name')
            .eq('status', 'active');

        if (!data || data.length === 0) {
            log('sistema', 'warn', 'Nenhuma instância ativa encontrada no banco');
            // Usa variável de ambiente como fallback
            const instEnv = process.env.INSTANCE_NAME;
            if (instEnv) await inicializarInstancia(instEnv);
            return;
        }

        log('sistema', 'ok', `${data.length} instância(s) ativa(s) encontrada(s)`);
        for (const { instance_name } of data) {
            await inicializarInstancia(instance_name);
        }
    } catch (e) {
        log('sistema', 'erro', 'Falha ao carregar instâncias: ' + e.message);
        // Tenta com variável de ambiente
        const instEnv = process.env.INSTANCE_NAME;
        if (instEnv) await inicializarInstancia(instEnv);
    }
}

// ─── SERVIDOR HTTP (serve CRM + health check) ────────────────────────────────
const http = require('http');
const fs2 = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.json': 'application/json',
    '.svg':  'image/svg+xml',
    '.webp': 'image/webp',
    '.mp3':  'audio/mpeg',
    '.ogg':  'audio/ogg',
    '.mp4':  'video/mp4',
    '.zip':  'application/zip',
    '.pdf':  'application/pdf',
};

const server = http.createServer(async (req, res) => {
    // ── CORS headers ────────────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── SERVIR ARQUIVOS DE MÍDIA (/uploads/*) ────────────────────────────────
    // Qualquer arquivo salvo pelo localSave() fica acessível aqui publicamente.
    if (req.url.startsWith('/uploads/')) {
        const subPath = req.url.split('?')[0].replace('/uploads/', '');
        const filePath = pathMod.join(UPLOADS_DIR, subPath);
        const ext = pathMod.extname(filePath).toLowerCase();
        const ct = MIME[ext] || 'application/octet-stream';
        fs2.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=31536000',
                'Content-Length': data.length,
            });
            res.end(data);
        });
        return;
    }

    // ── ENDPOINT: Upload de mídia vindo do browser (app.js) ──────────────────
    // Recebe multipart/form-data com os campos: path, file
    // Salva no disco e retorna a URL pública.
    if (req.url === '/local-upload' && req.method === 'POST') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks);
                const ct = req.headers['content-type'] || '';
                const boundary = ct.split('boundary=')[1];
                if (!boundary) throw new Error('Boundary não encontrado');

                const parts = parseMultipart(raw, boundary);
                const pathField = parts.find(p => p.name === 'path');
                const fileField = parts.find(p => p.name === 'file');
                if (!pathField || !fileField) throw new Error('Campos path e file obrigatórios');

                const objPath  = pathField.data.toString().trim(); // ex: "chat_media/inst_55119/foto.jpg"
                const segments = objPath.split('/');
                const fileName = segments.pop();
                const subDir   = segments.join('/') || 'misc';
                const fileCT   = fileField.contentType || 'application/octet-stream';

                void fileCT; // content-type guardado para logs futuros
                const url = localSave(subDir, fileName, fileField.data);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url }));
            } catch(e) {
                console.error('[local-upload] Erro:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Documentos do Lead (/api/lead-docs/*) ─────────────────────────────

    // Listar documentos de um lead
    if (req.url.startsWith('/api/lead-docs/list') && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, lead_id } = JSON.parse(body);
                const { data, error } = await db.from('lead_documentos')
                    .select('*')
                    .eq('instance_name', inst)
                    .eq('lead_id', lead_id)
                    .order('created_at', { ascending: false });
                if (error) throw error;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, docs: data || [] }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Criar/upload documento
    if (req.url === '/api/lead-docs/create' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, lead_id, nome, descricao, arquivo_url, arquivo_tipo, arquivo_tamanho, notificar } = JSON.parse(body);
                const { data, error } = await db.from('lead_documentos').insert({
                    instance_name: inst, lead_id, nome,
                    descricao: descricao || '',
                    arquivo_url, arquivo_tipo: arquivo_tipo || '',
                    arquivo_tamanho: arquivo_tamanho || 0,
                    notificar: notificar ?? true,
                    versao: 1,
                }).select('*').single();
                if (error) throw error;

                // Notificar cliente via WhatsApp
                if (notificar !== false) {
                    try {
                        const s = getState(inst);
                        const lead = s.leads[lead_id] || (await db.from('leads').select('*').eq('id', lead_id).single()).data;
                        if (lead?.numero) {
                            const msg = `📄 *Novo documento disponível*\n\n📋 *${nome}*${descricao ? '\n📝 ' + descricao : ''}\n\nSeu documento foi adicionado ao sistema. Para mais informações, entre em contato conosco.`;
                            await enviarTexto(inst, lead.numero, msg);
                            await salvarMensagemDB(inst, lead_id, msg, 'text', { sent_by_ia: true });
                            log(inst, 'ok', `[Docs] 📄 Notificação enviada para ${getLeadName(lead)} — doc: ${nome}`);
                        }
                    } catch (e) {
                        log(inst, 'warn', `[Docs] Erro ao notificar: ${e.message}`);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, doc: data }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Atualizar documento (nova versão)
    if (req.url === '/api/lead-docs/update' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, doc_id, nome, descricao, arquivo_url, arquivo_tipo, arquivo_tamanho, notificar } = JSON.parse(body);

                // Busca doc atual para incrementar versão
                const { data: docAtual } = await db.from('lead_documentos').select('*').eq('id', doc_id).single();
                if (!docAtual) throw new Error('Documento não encontrado');

                const updateData = { updated_at: new Date().toISOString() };
                if (nome !== undefined) updateData.nome = nome;
                if (descricao !== undefined) updateData.descricao = descricao;
                if (arquivo_url) {
                    updateData.arquivo_url = arquivo_url;
                    updateData.arquivo_tipo = arquivo_tipo || docAtual.arquivo_tipo;
                    updateData.arquivo_tamanho = arquivo_tamanho || 0;
                    updateData.versao = (docAtual.versao || 1) + 1;
                }

                const { data, error } = await db.from('lead_documentos')
                    .update(updateData).eq('id', doc_id).select('*').single();
                if (error) throw error;

                // Notificar cliente da atualização
                if (notificar !== false) {
                    try {
                        const s = getState(inst);
                        const lead = s.leads[docAtual.lead_id] || (await db.from('leads').select('*').eq('id', docAtual.lead_id).single()).data;
                        if (lead?.numero) {
                            const nomeDoc = nome || docAtual.nome;
                            const msg = `📄 *Documento atualizado*\n\n📋 *${nomeDoc}* (versão ${data.versao})\n${descricao || docAtual.descricao ? '📝 ' + (descricao || docAtual.descricao) : ''}\n\nSeu documento foi atualizado. Para mais informações, entre em contato conosco.`;
                            await enviarTexto(inst, lead.numero, msg);
                            await salvarMensagemDB(inst, docAtual.lead_id, msg, 'text', { sent_by_ia: true });
                            log(inst, 'ok', `[Docs] 📄 Atualização notificada para ${getLeadName(lead)} — doc: ${nomeDoc} v${data.versao}`);
                        }
                    } catch (e) {
                        log(inst, 'warn', `[Docs] Erro ao notificar atualização: ${e.message}`);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, doc: data }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Deletar documento
    if (req.url === '/api/lead-docs/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { doc_id } = JSON.parse(body);
                const { error } = await db.from('lead_documentos').delete().eq('id', doc_id);
                if (error) throw error;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Health check
    if (req.url === '/health') {
        const instancias = Object.keys(state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: Math.floor(process.uptime()) + 's',
            instancias: instancias.length,
            detalhes: instancias.map(inst => ({
                instancia: inst,
                iaAtiva: state[inst]?.config?.ativo ?? false,
                leads: Object.keys(state[inst]?.leads || {}).length,
                humanosPausados: Object.keys(state[inst]?.humanoAtivo || {}).length,
            }))
        }));
        return;
    }

    // ── API REST: banco de dados — substitui Supabase REST no browser ──────────
    // POST /api/db  { table, op, select, filters, data, order, limit, single, upsertConflict }
    if (req.url === '/api/db' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { table, op = 'select', select = '*', filters = [], data: rowData,
                        order, limit, single, upsertConflict } = JSON.parse(body);

                if (!table) throw new Error('table obrigatório');

                let q = db.from(table);

                if (op === 'select') {
                    q = q.select(select);
                    for (const f of filters) {
                        if (f.op === 'eq')  q = q.eq(f.col, f.val);
                        if (f.op === 'neq') q = q.neq(f.col, f.val);
                        if (f.op === 'gte') q = q.gte(f.col, f.val);
                        if (f.op === 'lte') q = q.lte(f.col, f.val);
                        if (f.op === 'in')  q = q.in(f.col, f.val);
                    }
                    if (order) q = q.order(order.col, { ascending: order.ascending ?? true });
                    if (limit) q = q.limit(limit);
                    if (single) q = q.single();
                } else if (op === 'insert') {
                    q = q.insert(rowData);
                    if (select) q = q.select(select);
                    if (single) q = q.single();
                } else if (op === 'update') {
                    q = q.update(rowData);
                    for (const f of filters) {
                        if (f.op === 'eq') q = q.eq(f.col, f.val);
                    }
                    if (select) q = q.select(select);
                    if (single) q = q.single();
                } else if (op === 'upsert') {
                    q = q.upsert(rowData, { onConflict: upsertConflict });
                    if (select) q = q.select(select);
                    if (single) q = q.single();
                } else if (op === 'delete') {
                    q = q.delete();
                    for (const f of filters) {
                        if (f.op === 'eq') q = q.eq(f.col, f.val);
                    }
                } else {
                    throw new Error('op inválido');
                }

                const result = await q;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: null, error: { message: e.message } }));
            }
        });
        return;
    }

    // ── API: Resumo de conversa — salva na observação do lead ────────────────
    // POST /api/ia/resumo  { inst, lead_id }
    if (req.url === '/api/ia/resumo' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id } = JSON.parse(body || '{}');
                const targetInst = instBody || process.env.INSTANCE_NAME || '';
                if (!lead_id) throw new Error('lead_id obrigatório');

                const apiKey = await getApiKey(targetInst);
                if (!apiKey) throw new Error('API Key não configurada para esta instância');

                // Busca histórico de mensagens do lead
                const { data: msgs } = await db.from('messages')
                    .select('content, from_me, type')
                    .eq('lead_id', lead_id)
                    .eq('instance_name', targetInst)
                    .order('created_at', { ascending: true });

                const hist = (msgs || [])
                    .filter(m => m.type === 'text' && m.content && !m.content.startsWith('http'))
                    .slice(-40)
                    .map(m => (m.from_me ? 'Atendente' : 'Cliente') + ': ' + m.content)
                    .join('\n');

                if (!hist.trim()) throw new Error('Sem mensagens de texto para resumir');

                const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        max_tokens: 350,
                        messages: [
                            { role: 'system', content: 'Faça um resumo objetivo em até 3 linhas desta conversa de atendimento. Inclua: interesse do cliente, próximos passos e tom geral. Responda em português.' },
                            { role: 'user', content: hist }
                        ]
                    })
                });
                const d = await resp.json();
                const resumo = d?.choices?.[0]?.message?.content?.trim() || '';
                if (!resumo) throw new Error('Resposta vazia da IA');

                // Salva na observação do lead
                await db.from('leads').update({ observacao: resumo }).eq('id', lead_id);
                log(targetInst, 'ok', `[IA/Resumo] Resumo salvo para lead ${lead_id}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, resumo }));
            } catch(e) {
                log('ia', 'erro', `[IA/Resumo] ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── API: Sugestão de resposta ─────────────────────────────────────────────
    // POST /api/ia/sugestao  { inst, lead_id }
    if (req.url === '/api/ia/sugestao' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id } = JSON.parse(body || '{}');
                const targetInst = instBody || process.env.INSTANCE_NAME || '';
                if (!lead_id) throw new Error('lead_id obrigatório');

                const apiKey = await getApiKey(targetInst);
                if (!apiKey) throw new Error('API Key não configurada');

                const { data: msgs } = await db.from('messages')
                    .select('content, from_me, type')
                    .eq('lead_id', lead_id)
                    .eq('instance_name', targetInst)
                    .order('created_at', { ascending: true });

                const hist = (msgs || [])
                    .filter(m => m.type === 'text' && m.content && !m.content.startsWith('http'))
                    .slice(-20)
                    .map(m => (m.from_me ? 'Atendente' : 'Cliente') + ': ' + m.content)
                    .join('\n');

                const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        max_tokens: 250,
                        messages: [
                            { role: 'system', content: 'Você é um assistente de vendas. Com base na conversa, sugira UMA resposta curta e profissional para o atendente enviar ao cliente. Responda apenas com o texto da mensagem, sem aspas, sem explicações.' },
                            { role: 'user', content: hist || 'Primeira interação com o cliente.' }
                        ]
                    })
                });
                const d = await resp.json();
                const sugestao = d?.choices?.[0]?.message?.content?.trim() || '';
                if (!sugestao) throw new Error('Resposta vazia da IA');

                log(targetInst, 'ok', `[IA/Sugestão] Sugestão gerada para lead ${lead_id}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, sugestao }));
            } catch(e) {
                log('ia', 'erro', `[IA/Sugestão] ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── API: Sentimento de um lead ────────────────────────────────────────────
    // POST /api/ia/sentimento  { inst, lead_id }
    if (req.url === '/api/ia/sentimento' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id } = JSON.parse(body || '{}');
                const targetInst = instBody || process.env.INSTANCE_NAME || '';
                if (!lead_id) throw new Error('lead_id obrigatório');

                const apiKey = await getApiKey(targetInst);
                if (!apiKey) throw new Error('API Key não configurada');

                const sentimento = await analisarSentimentoLead(targetInst, lead_id, apiKey);
                if (!sentimento) throw new Error('Sem mensagens suficientes para análise');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, sentimento }));
            } catch(e) {
                log('ia', 'erro', `[IA/Sentimento] ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/ia/lead-prompt  { inst, lead_id, prompt_id }  — define/limpa prompt por conversa
    if (req.url === '/api/ia/lead-prompt' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id, prompt_id } = JSON.parse(body || '{}');
                const targetInst = instBody || process.env.INSTANCE_NAME || '';
                if (!lead_id) throw new Error('lead_id obrigatório');

                // Atualiza no banco — prompt_id null = usa o global
                const { error } = await db.from('leads')
                    .update({ prompt_id: prompt_id || null })
                    .eq('id', lead_id)
                    .eq('instance_name', targetInst);
                if (error) throw error;

                // Reflete na memória do servidor
                const s = getState(targetInst);
                if (s.leads[lead_id]) s.leads[lead_id].prompt_id = prompt_id || null;

                log(targetInst, 'ok', `[Lead Prompt] ${prompt_id ? 'Prompt ' + prompt_id.substring(0,8) + '... definido' : 'Prompt removido'} para lead ${lead_id.substring(0,8)}...`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                log('ia', 'erro', `[IA/LeadPrompt] ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── API: Recarregar config da IA (chamado pelo browser após salvar) ──────────
    if (req.url === '/api/reload-config' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody } = JSON.parse(body || '{}');
                const targetInst = instBody || process.env.INSTANCE_NAME || '';
                if (targetInst) {
                    // Recarrega instância específica
                    await carregarConfig(targetInst);
                } else {
                    // inst vazio → recarrega TODAS as instâncias ativas (ex: API Key global alterada)
                    for (const instAtiva of Object.keys(state)) {
                        try { await carregarConfig(instAtiva); } catch(e) {}
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, inst: targetInst || 'all' }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Configuração pública do servidor (expõe EVO_URL/KEY para o frontend) ──
    // ── FILA DE ATENDIMENTO ──────────────────────────────────────────────────────
    // POST /api/fila/iniciar  { inst, lead_id, agente_nome? }
    // Tira o lead da fila (aguardando → em_atendimento). Idempotente.
    if (req.url === '/api/fila/iniciar' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, lead_id, agente_nome } = JSON.parse(body || '{}');
                if (!inst || !lead_id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'inst e lead_id obrigatórios' }));
                    return;
                }
                // Busca entrada aguardando deste lead
                const { data: rows } = await db.from('fila_atendimento')
                    .select('id').eq('instance_name', inst).eq('lead_id', lead_id).eq('status', 'aguardando');
                if (!rows || rows.length === 0) {
                    // Nada na fila — registra início do atendimento direto na tabela atendimentos
                    if (agente_nome) {
                        try {
                            const { data: exist } = await db.from('atendimentos')
                                .select('id').eq('lead_id', lead_id).eq('status', 'ativo').limit(1);
                            if (!exist || exist.length === 0) {
                                const { data: lead } = await db.from('leads')
                                    .select('departamento, nome, numero, atendimento_inicio').eq('id', lead_id).single();
                                if (lead) {
                                    const crypto = require('crypto');
                                    await db.from('atendimentos').insert({
                                        id: crypto.randomUUID(),
                                        instance_name: inst,
                                        lead_id,
                                        departamento: lead.departamento || 'ADM Principal',
                                        agente_nome: agente_nome,
                                        numero: lead.numero,
                                        nome: lead.nome,
                                        inicio: lead.atendimento_inicio || new Date().toISOString(),
                                        status: 'ativo',
                                    });
                                }
                            }
                        } catch(e2) { /* tabela pode não existir */ }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, semFila: true }));
                    return;
                }
                const r = await filaMgr.iniciarAtendimento(inst, rows[0].id, null, agente_nome || '');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(r));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/fila/entrar  { inst, lead_id, departamento, motivo? }
    if (req.url === '/api/fila/entrar' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, lead_id, departamento, motivo } = JSON.parse(body || '{}');
                if (!inst || !lead_id || !departamento) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'inst, lead_id, departamento obrigatórios' }));
                    return;
                }
                const { data: lead } = await db.from('leads').select('*').eq('id', lead_id).single();
                if (!lead) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Lead não encontrado' }));
                    return;
                }
                // Limpa qualquer entrada antiga na fila (em_atendimento, encerrado, ou outro dept)
                try {
                    await db.from('fila_atendimento').delete()
                        .eq('instance_name', inst).eq('lead_id', lead_id);
                } catch(e) { /* ok */ }
                // Encerra atendimento ativo na tabela atendimentos (preserva histórico)
                try {
                    const agora = new Date().toISOString();
                    const { data: atAtivo } = await db.from('atendimentos')
                        .select('id, inicio').eq('lead_id', lead_id).eq('status', 'ativo').limit(1);
                    if (atAtivo && atAtivo.length > 0) {
                        const tma = Math.round((Date.now() - new Date(atAtivo[0].inicio).getTime()) / 1000);
                        await db.from('atendimentos').update({
                            fim: agora, tma_segundos: tma, status: 'encerrado',
                        }).eq('id', atAtivo[0].id);
                    } else if (lead.atendimento_inicio && lead.atendente_nome) {
                        // Não tinha registro — cria um encerrado para preservar histórico
                        const crypto = require('crypto');
                        const tma = Math.round((Date.now() - new Date(lead.atendimento_inicio).getTime()) / 1000);
                        await db.from('atendimentos').insert({
                            id: crypto.randomUUID(), instance_name: inst, lead_id,
                            departamento: lead.departamento || 'ADM Principal',
                            agente_nome: lead.atendente_nome, numero: lead.numero, nome: lead.nome,
                            inicio: lead.atendimento_inicio, fim: agora, tma_segundos: tma, status: 'encerrado',
                        });
                    }
                } catch(e) { /* tabela pode não existir */ }
                // Limpa atendimento ativo deste lead
                try {
                    await db.from('leads').update({ atendimento_inicio: null, atendimento_fim: null, tma_segundos: null, atendente_nome: null })
                        .eq('id', lead_id);
                } catch(e) { /* ok */ }
                // Enfileira no novo departamento
                await enfileirarLead(inst, lead, departamento, motivo || 'Transferência manual');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/fila/listar?inst=...&departamento=...  — lista quem está aguardando
    if (req.url.startsWith('/api/fila/listar') && req.method === 'GET') {
        try {
            const urlP = new URL(req.url, 'http://localhost');
            const inst = urlP.searchParams.get('inst') || '';
            const dept = urlP.searchParams.get('departamento') || '';
            if (!inst) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'inst obrigatório' })); return; }
            let q = db.from('fila_atendimento')
                .select('*').eq('instance_name', inst).eq('status', 'aguardando');
            if (dept) q = q.eq('departamento', dept);
            const { data } = await q;
            const lista = (data || []).slice().sort((a,b) => {
                const ta = new Date(a.entrada_em || a.created_at).getTime();
                const tb = new Date(b.entrada_em || b.created_at).getTime();
                return ta - tb;
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, fila: lista }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // ── CHAT INTERNO ─────────────────────────────────────────────────────────────
    // GET  /api/chat-interno?inst=...&lead_id=...  — lista mensagens
    if (req.url.startsWith('/api/chat-interno') && req.method === 'GET') {
        try {
            const urlP  = new URL(req.url, 'http://localhost');
            const inst  = urlP.searchParams.get('inst') || '';
            const leadId = urlP.searchParams.get('lead_id') || '';
            if (!inst || !leadId) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'inst e lead_id obrigatórios' })); return; }
            const { data: msgs } = await db.from('chat_interno')
                .select('*').eq('instance_name', inst).eq('lead_id', leadId)
                .order('created_at', { ascending: true });
            // Marca como lido para o solicitante (lido = 1)
            db.from('chat_interno').update({ lido: 1 }).eq('lead_id', leadId).eq('instance_name', inst).then(()=>{},()=>{});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msgs: msgs || [] }));
        } catch(e) {
            res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // POST /api/chat-interno  { inst, lead_id, from_dept, content }  — envia mensagem
    if (req.url === '/api/chat-interno' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, lead_id, from_dept, content } = JSON.parse(body || '{}');
                if (!inst || !lead_id || !from_dept || !content?.trim()) {
                    res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'campos obrigatórios ausentes' })); return;
                }
                const { data: msg } = await db.from('chat_interno').insert({
                    instance_name: inst, lead_id,
                    from_dept, content: content.trim(), lido: 0,
                    created_at: new Date().toISOString(),
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, msg }));
            } catch(e) {
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── CHAT INTERNO ─────────────────────────────────────────────────────────────
    // POST /api/chat-interno/enviar  { inst, lead_id, from_dept, content }
    if (req.url === '/api/chat-interno/enviar' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instB, lead_id, from_dept, content: msgContent } = JSON.parse(body || '{}');
                if (!instB || !lead_id || !from_dept || !msgContent?.trim()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Campos obrigatórios ausentes' }));
                    return;
                }
                const { query } = require('./db.js');
                const id = require('crypto').randomUUID();
                const now = new Date().toISOString();
                await query(
                    `INSERT INTO chat_interno (id, instance_name, lead_id, from_dept, content, lido, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
                    [id, instB, lead_id, from_dept, msgContent.trim(), now]
                );
                const msg = { id, instance_name: instB, lead_id, from_dept, content: msgContent.trim(), lido: 0, created_at: now };
                // Emite via WebSocket para todos os clientes da instância
                wsEmit(instB, { type: 'chat_interno', event: 'INSERT', data: msg });
                log(instB, 'info', `[ChatInterno] ${from_dept} → lead ${lead_id}: ${msgContent.substring(0,40)}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, msg }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/chat-interno/listar?inst=...&lead_id=...
    if (req.url.startsWith('/api/chat-interno/listar') && req.method === 'GET') {
        try {
            const urlP = new URL(req.url, 'http://localhost');
            const instB   = urlP.searchParams.get('inst') || '';
            const lead_id = urlP.searchParams.get('lead_id') || '';
            if (!instB || !lead_id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, msgs: [] }));
                return;
            }
            const { query } = require('./db.js');
            const result = await query(
                `SELECT * FROM chat_interno WHERE instance_name = ? AND lead_id = ? ORDER BY created_at ASC LIMIT 200`,
                [instB, lead_id]
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msgs: result.rows || [] }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msgs: [], error: e.message }));
        }
        return;
    }

    // POST /api/registrar-inicio-atendimento  { inst, lead_id, agente_nome }
    // Garante que todo início de atendimento tenha registro na tabela atendimentos.
    // Chamado pelo frontend quando atendente é atribuído (sem passar pela fila).
    if (req.url === '/api/registrar-inicio-atendimento' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id, agente_nome } = JSON.parse(body || '{}');
                if (!instBody || !lead_id || !agente_nome) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'inst, lead_id, agente_nome obrigatórios' }));
                    return;
                }
                // Verifica se já existe atendimento ativo para este lead
                let jaExiste = false;
                try {
                    const { data: exist } = await db.from('atendimentos')
                        .select('id').eq('lead_id', lead_id).eq('status', 'ativo').limit(1);
                    jaExiste = exist && exist.length > 0;
                } catch(e) {}
                if (jaExiste) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ja_existe: true }));
                    return;
                }
                // Busca dados do lead
                const { data: lead } = await db.from('leads')
                    .select('departamento, nome, numero, atendimento_inicio')
                    .eq('id', lead_id).single();
                if (!lead) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Lead não encontrado' }));
                    return;
                }
                const agora = new Date().toISOString();
                const inicio = lead.atendimento_inicio || agora;
                const crypto = require('crypto');
                await db.from('atendimentos').insert({
                    id: crypto.randomUUID(),
                    instance_name: instBody,
                    lead_id,
                    departamento: lead.departamento || 'ADM Principal',
                    agente_nome,
                    numero: lead.numero,
                    nome: lead.nome,
                    inicio,
                    status: 'ativo',
                });
                log(instBody, 'ok', `[Atend] Início registrado — lead ${lead_id} | agente=${agente_nome}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/encerrar-atendimento  { inst, lead_id }
    // Grava atendimento_fim e calcula tma_segundos. Idempotente (não sobrescreve se já encerrado).
    if (req.url === '/api/encerrar-atendimento' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id } = JSON.parse(body || '{}');
                if (!instBody || !lead_id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'inst e lead_id obrigatórios' }));
                    return;
                }
                // Busca lead para calcular TMA
                const { data: lead } = await db.from('leads').select('atendimento_inicio, atendimento_fim, atendente_nome, departamento, nome, numero, instance_name').eq('id', lead_id).single();
                if (!lead) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Lead não encontrado' }));
                    return;
                }
                // Idempotente: não sobrescreve se já encerrado
                if (lead.atendimento_fim) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ja_encerrado: true }));
                    return;
                }
                const agora = new Date().toISOString();
                const tmaSegs = lead.atendimento_inicio
                    ? Math.round((Date.now() - new Date(lead.atendimento_inicio).getTime()) / 1000)
                    : null;
                await db.from('leads').update({
                    atendimento_fim: agora,
                    tma_segundos:   tmaSegs,
                    updated_at:     agora,
                }).eq('id', lead_id);

                // Gravar/atualizar na tabela atendimentos para histórico confiável
                let atendimentoId = null;
                const agenteDoAtend = lead.atendente_nome || '';
                const deptDoAtend = lead.departamento || 'ADM Principal';
                try {
                    // Tenta atualizar atendimento ativo existente (criado pela fila)
                    const { data: atExist } = await db.from('atendimentos')
                        .select('id').eq('lead_id', lead_id).eq('status', 'ativo').limit(1);
                    if (atExist && atExist.length > 0) {
                        atendimentoId = atExist[0].id;
                        await db.from('atendimentos').update({
                            fim: agora, tma_segundos: tmaSegs, status: 'encerrado',
                        }).eq('id', atendimentoId);
                    } else if (agenteDoAtend) {
                        // Não veio pela fila — insere registro novo para manter histórico
                        const crypto = require('crypto');
                        atendimentoId = crypto.randomUUID();
                        await db.from('atendimentos').insert({
                            id: atendimentoId,
                            instance_name: instBody,
                            lead_id: lead_id,
                            departamento: deptDoAtend,
                            agente_nome: agenteDoAtend,
                            numero: lead.numero,
                            nome: lead.nome,
                            inicio: lead.atendimento_inicio,
                            fim: agora,
                            tma_segundos: tmaSegs,
                            status: 'encerrado',
                        });
                    }
                } catch(e2) { /* tabela pode não existir, segue */ }

                // ── Pesquisa de satisfação automática ──
                // Só dispara se NÃO é ADM Principal e tem número do cliente
                if (agenteDoAtend && agenteDoAtend !== 'ADM Principal' && deptDoAtend !== 'ADM Principal' && lead.numero) {
                    try {
                        // Salva dados do último atendimento no lead para referência ao receber resposta
                        await db.from('leads').update({
                            aguardando_avaliacao: 1,
                            ultimo_atendimento_id: atendimentoId,
                            ultimo_agente: agenteDoAtend,
                            ultimo_departamento: deptDoAtend,
                        }).eq('id', lead_id);

                        // Busca prompt de pesquisa de satisfação configurado
                        let msgPesquisa = `Olá! Seu atendimento foi encerrado.\n\nPoderia avaliar nosso atendimento com uma nota de *1 a 5*?\n\n⭐ 1 — Péssimo\n⭐⭐ 2 — Ruim\n⭐⭐⭐ 3 — Regular\n⭐⭐⭐⭐ 4 — Bom\n⭐⭐⭐⭐⭐ 5 — Excelente\n\nSua opinião é muito importante para nós!`;
                        try {
                            const { data: promptPesq } = await db.from('ia_prompts')
                                .select('conteudo, prompt')
                                .eq('instance_name', instBody)
                                .eq('nome', 'Pesquisa de Satisfação')
                                .limit(1);
                            if (promptPesq && promptPesq.length > 0 && (promptPesq[0].conteudo || promptPesq[0].prompt)) {
                                msgPesquisa = promptPesq[0].conteudo || promptPesq[0].prompt;
                            }
                        } catch(e3) {}

                        // Envia via WhatsApp
                        await fetch(`${EVO_URL}/message/sendText/${instBody}`, {
                            method: 'POST',
                            headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ number: lead.numero, text: msgPesquisa })
                        });
                        // Salva no histórico de mensagens
                        await db.from('messages').insert({
                            instance_name: instBody, lead_id: lead_id,
                            content: msgPesquisa, type: 'text',
                            from_me: true, status: 'sent', sent_by_ia: true,
                            timestamp: agora, created_at: agora,
                        }).catch(() => {});
                        log(instBody, 'ok', `[Satisfação] Pesquisa enviada → ${lead.numero}`);
                    } catch(e3) {
                        log(instBody, 'warn', `[Satisfação] Falha ao enviar pesquisa: ${e3.message}`);
                    }
                }

                log(instBody, 'ok', `[TMA] Atendimento encerrado — lead ${lead_id} | tma=${tmaSegs}s`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, tma_segundos: tmaSegs }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/reiniciar-atendimento  { inst, lead_id }
    // Reabre um atendimento encerrado: limpa atendimento_fim/tma, seta novo atendimento_inicio.
    // NÃO coloca na fila (inicia direto).
    if (req.url === '/api/reiniciar-atendimento' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst: instBody, lead_id } = JSON.parse(body || '{}');
                if (!instBody || !lead_id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'inst e lead_id obrigatórios' }));
                    return;
                }
                const { data: lead } = await db.from('leads').select('atendimento_fim, atendente_nome, departamento, nome, numero').eq('id', lead_id).single();
                if (!lead) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Lead não encontrado' }));
                    return;
                }
                // Só reinicia se estiver encerrado
                if (!lead.atendimento_fim) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ja_ativo: true }));
                    return;
                }
                const agora = new Date().toISOString();
                await db.from('leads').update({
                    atendimento_inicio: agora,
                    atendimento_fim:    null,
                    tma_segundos:       null,
                    updated_at:         agora,
                }).eq('id', lead_id);

                // Cria novo registro na tabela atendimentos
                try {
                    const crypto = require('crypto');
                    await db.from('atendimentos').insert({
                        id: crypto.randomUUID(),
                        instance_name: instBody,
                        lead_id,
                        departamento: lead.departamento || 'ADM Principal',
                        agente_nome: lead.atendente_nome || 'ADM Principal',
                        numero: lead.numero,
                        nome: lead.nome,
                        inicio: agora,
                        status: 'ativo',
                    });
                } catch(e2) { /* tabela pode não existir */ }

                log(instBody, 'ok', `[Atend] Atendimento reiniciado — lead ${lead_id}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, atendimento_inicio: agora }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/stats/dashboard?inst=...  — dashboard consolidado em tempo real
    //   Retorna: KPIs de hoje, situação por depto (atendendo + fila + status),
    //   ranking de atendentes (últimos 7d) e atendimentos por hora (hoje)
    if (req.url.startsWith('/api/stats/dashboard') && req.method === 'GET') {
        try {
            const urlParsed = new URL(req.url, 'http://localhost');
            const inst = urlParsed.searchParams.get('inst') || process.env.INSTANCE_NAME || '';
            if (!inst) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'inst obrigatório' })); return; }

            const hoje = new Date(); hoje.setHours(0,0,0,0);
            const hojeIso = hoje.toISOString();
            const agora = Date.now();

            // Leads da instância (básico)
            const { data: leads } = await db.from('leads')
                .select('id, departamento, atendente_nome, atendimento_inicio, atendimento_fim, tma_segundos, updated_at')
                .eq('instance_name', inst);
            const leadsArr = leads || [];

            // Fila atual (aguardando)
            let filaArr = [];
            try {
                const { data: fila } = await db.from('fila_atendimento')
                    .select('id, lead_id, departamento, entrada_em, created_at')
                    .eq('instance_name', inst)
                    .eq('status', 'aguardando');
                filaArr = fila || [];
            } catch(e) { /* tabela pode não existir ainda */ }

            // Atendimentos encerrados hoje (via fila_atendimento) — fallback para leads.atendimento_fim
            let encerradosHoje = [];
            try {
                const { data: at } = await db.from('atendimentos')
                    .select('id, departamento, agente_nome, tma_segundos, tme_segundos, inicio, fim, status')
                    .eq('instance_name', inst)
                    .gte('inicio', hojeIso);
                encerradosHoje = at || [];
            } catch(e) { /* sem tabela atendimentos */ }

            // ── KPIs globais (exclui ADM Principal — TMA/TME é só dos atendentes) ──
            const _naoAdm = l => (l.departamento || 'ADM Principal') !== 'ADM Principal';
            const ativos       = leadsArr.filter(l => l.atendimento_inicio && !l.atendimento_fim && _naoAdm(l));
            const aguardando   = filaArr.length;
            const encerradosH  = leadsArr.filter(l => l.atendimento_fim && new Date(l.atendimento_fim) >= hoje && _naoAdm(l));
            const tmasHoje     = encerradosH.map(l => l.tma_segundos).filter(Boolean);
            const tmaMedioHoje = tmasHoje.length ? Math.round(tmasHoje.reduce((a,b)=>a+b,0)/tmasHoje.length) : 0;
            // TME: média histórica de espera dos atendimentos de hoje (da tabela atendimentos)
            const tmesHoje = (encerradosHoje || []).map(a => a.tme_segundos).filter(Boolean);
            const tmeHistorico = tmesHoje.length ? Math.round(tmesHoje.reduce((a,b)=>a+b,0)/tmesHoje.length) : 0;
            // Se tem gente aguardando agora, mostra espera atual; senão mostra histórico do dia
            const tmesAguard = filaArr.map(f => Math.round((agora - new Date(f.entrada_em || f.created_at).getTime())/1000));
            const tmeAtualMedio = tmesAguard.length ? Math.round(tmesAguard.reduce((a,b)=>a+b,0)/tmesAguard.length) : tmeHistorico;
            // SLA: % de atendimentos encerrados hoje cujo TMA está abaixo de 1200s (20min)
            const dentroSla = tmasHoje.filter(t => t <= 1200).length;
            const sla = tmasHoje.length ? Math.round(dentroSla/tmasHoje.length*100) : 100;

            // ── Por departamento ─────────────────────────────────────────────
            const porDept = {};
            const ensure = (d) => { if (!porDept[d]) porDept[d] = { dept: d, atendendo: 0, aguardando: 0, tempoEsperaMax: 0, encerradosHoje: 0, tmaHoje: [] }; return porDept[d]; };
            for (const l of ativos) ensure(l.departamento || 'ADM Principal').atendendo++;
            for (const f of filaArr) {
                const g = ensure(f.departamento);
                g.aguardando++;
                const espera = Math.round((agora - new Date(f.entrada_em || f.created_at).getTime())/1000);
                if (espera > g.tempoEsperaMax) g.tempoEsperaMax = espera;
            }
            for (const l of encerradosH) {
                const g = ensure(l.departamento || 'ADM Principal');
                g.encerradosHoje++;
                if (l.tma_segundos) g.tmaHoje.push(l.tma_segundos);
            }
            const deptList = Object.values(porDept).map(g => {
                const tmaMed = g.tmaHoje.length ? Math.round(g.tmaHoje.reduce((a,b)=>a+b,0)/g.tmaHoje.length) : 0;
                // status: livre (0 ativos), normal (<5 aguard), saturado (>=5 aguard OU espera>1200)
                let status = 'livre';
                if (g.atendendo > 0 || g.aguardando > 0) status = 'normal';
                if (g.aguardando >= 5 || g.tempoEsperaMax > 1200) status = 'saturado';
                return { ...g, tmaMed, status };
            }).sort((a,b) => (b.atendendo + b.aguardando) - (a.atendendo + a.aguardando));

            // ── Ranking de atendentes (últimos 7 dias via atendimentos + fallback leads) ──────
            let ranking = [];
            try {
                const desde7 = new Date(Date.now() - 7*86400000).toISOString();
                const { data: at7 } = await db.from('atendimentos')
                    .select('agente_nome, tma_segundos, status')
                    .eq('instance_name', inst)
                    .gte('inicio', desde7);
                const mapa = {};
                for (const a of (at7 || [])) {
                    if (!a.agente_nome || a.agente_nome === 'ADM Principal') continue;
                    if (!mapa[a.agente_nome]) mapa[a.agente_nome] = { nome: a.agente_nome, total: 0, encerrados: 0, tmas: [] };
                    mapa[a.agente_nome].total++;
                    if (a.status === 'encerrado') mapa[a.agente_nome].encerrados++;
                    if (a.tma_segundos) mapa[a.agente_nome].tmas.push(a.tma_segundos);
                }
                // Fallback: se tabela atendimentos está vazia, usar leads com atendente_nome
                if (Object.keys(mapa).length === 0) {
                    const desde7d = new Date(Date.now() - 7*86400000);
                    for (const l of leadsArr) {
                        if (!l.atendente_nome || l.atendente_nome === 'ADM Principal') continue;
                        if (!mapa[l.atendente_nome]) mapa[l.atendente_nome] = { nome: l.atendente_nome, total: 0, encerrados: 0, tmas: [] };
                        if (l.atendimento_inicio) mapa[l.atendente_nome].total++;
                        if (l.atendimento_fim && new Date(l.atendimento_fim) >= desde7d) {
                            mapa[l.atendente_nome].encerrados++;
                            if (l.tma_segundos) mapa[l.atendente_nome].tmas.push(l.tma_segundos);
                        }
                    }
                }
                // Busca avaliações dos últimos 7 dias para o ranking
                let avalRanking = {};
                try {
                    const { data: avals7d } = await db.from('avaliacoes')
                        .select('agente_nome, nota').eq('instance_name', inst).gte('created_at', desde7);
                    for (const a of (avals7d || [])) {
                        if (!a.agente_nome) continue;
                        if (!avalRanking[a.agente_nome]) avalRanking[a.agente_nome] = [];
                        avalRanking[a.agente_nome].push(a.nota);
                    }
                } catch(e) {}

                ranking = Object.values(mapa).map(r => {
                    const notasAg = avalRanking[r.nome] || [];
                    return {
                        nome: r.nome, total: r.total, encerrados: r.encerrados,
                        tmaMed: r.tmas.length ? Math.round(r.tmas.reduce((a,b)=>a+b,0)/r.tmas.length) : 0,
                        satisfacao: notasAg.length ? Math.round(notasAg.reduce((a,b)=>a+b,0)/notasAg.length*10)/10 : null,
                        totalAvaliacoes: notasAg.length,
                    };
                }).sort((a,b) => b.total - a.total).slice(0, 10);
            } catch(e) { /* sem tabela atendimentos */ }

            // ── Atendimentos iniciados por hora (hoje) ───────────────────────
            const porHora = Array(24).fill(0);
            for (const l of leadsArr) {
                if (!l.atendimento_inicio || !_naoAdm(l)) continue;
                const d = new Date(l.atendimento_inicio);
                if (d < hoje) continue;
                porHora[d.getHours()]++;
            }

            // ── Satisfação (últimos 30 dias) ─────────────────────────────────
            let satisfacaoMedia = null;
            let satisfacaoTotal = 0;
            try {
                const desde30 = new Date(Date.now() - 30*86400000).toISOString();
                const { data: avals } = await db.from('avaliacoes')
                    .select('nota').eq('instance_name', inst).gte('created_at', desde30);
                const notasArr = (avals || []).map(a => a.nota).filter(Boolean);
                if (notasArr.length > 0) {
                    satisfacaoMedia = Math.round(notasArr.reduce((a,b)=>a+b,0)/notasArr.length*10)/10;
                    satisfacaoTotal = notasArr.length;
                }
            } catch(e) {}

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                kpis: {
                    ativos: ativos.length,
                    aguardando,
                    encerradosHoje: encerradosH.length,
                    tmaMedioHoje,
                    tmeAtualMedio,
                    sla,
                    satisfacaoMedia,
                    satisfacaoTotal,
                },
                departamentos: deptList,
                ranking,
                porHora,
                geradoEm: new Date().toISOString(),
            }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // GET /api/stats/staff-dashboard?inst=...&dept=...  — dashboard por supervisor/atendente
    if (req.url.startsWith('/api/stats/staff-dashboard') && req.method === 'GET') {
        try {
            const urlP = new URL(req.url, 'http://localhost');
            const inst = urlP.searchParams.get('inst') || '';
            const deptFilter = urlP.searchParams.get('dept') || '';
            if (!inst) { res.writeHead(400); res.end(JSON.stringify({ error: 'inst obrigatório' })); return; }

            const agora = Date.now();
            const hoje = new Date(); hoje.setHours(0,0,0,0);
            const hojeIso = hoje.toISOString();
            const desde7 = new Date(Date.now() - 7*86400000).toISOString();

            // Departamentos com supervisor
            const { data: allDepts } = await db.from('departments').select('*').eq('instance_name', inst);
            const depts = (allDepts || []).filter(d => d.name !== 'ADM Principal' && (!deptFilter || d.name === deptFilter));

            // Atendentes
            const { data: allAtend } = await db.from('dept_atendentes').select('*').eq('instance_name', inst).eq('ativo', 1);

            // Leads e fila
            const { data: leads } = await db.from('leads')
                .select('id, nome, numero, departamento, atendente_nome, atendimento_inicio, atendimento_fim, tma_segundos, last_interaction, last_msg, foto_url, unread')
                .eq('instance_name', inst);
            const leadsArr = leads || [];

            let filaArr = [];
            try {
                const { data: fila } = await db.from('fila_atendimento')
                    .select('id, lead_id, departamento, numero, nome, entrada_em, created_at, posicao')
                    .eq('instance_name', inst).eq('status', 'aguardando');
                filaArr = fila || [];
            } catch(e) {}

            // Atendimentos (últimos 7 dias)
            let atendimentos7d = [];
            try {
                const { data: at } = await db.from('atendimentos')
                    .select('departamento, agente_nome, tma_segundos, tme_segundos, status, inicio, fim, lead_id, numero, nome')
                    .eq('instance_name', inst).gte('inicio', desde7);
                atendimentos7d = at || [];
            } catch(e) {}

            // Atendimentos encerrados HOJE (da tabela atendimentos — fonte confiável)
            const atendimentosHoje = atendimentos7d.filter(a => a.fim && new Date(a.fim) >= hoje);

            // Avaliações de satisfação (últimos 7 dias)
            let avaliacoes7d = {};
            try {
                const { data: avals } = await db.from('avaliacoes')
                    .select('agente_nome, departamento, nota')
                    .eq('instance_name', inst).gte('created_at', desde7);
                for (const a of (avals || [])) {
                    if (!a.agente_nome) continue;
                    if (!avaliacoes7d[a.agente_nome]) avaliacoes7d[a.agente_nome] = [];
                    avaliacoes7d[a.agente_nome].push(a.nota);
                }
            } catch(e) {}

            const result = depts.map(dept => {
                const deptName = dept.name;
                const deptAtendentes = (allAtend || []).filter(a => a.dept_id === dept.id);
                const deptLeads = leadsArr.filter(l => (l.departamento || 'ADM Principal') === deptName);
                const deptFila = filaArr.filter(f => f.departamento === deptName);
                const deptAtend7d = atendimentos7d.filter(a => a.departamento === deptName);

                // Fila com TME ao vivo
                const filaComTme = deptFila.map(f => ({
                    id: f.id, lead_id: f.lead_id, nome: f.nome, numero: f.numero, posicao: f.posicao,
                    tme_segundos: Math.round((agora - new Date(f.entrada_em || f.created_at).getTime()) / 1000),
                    entrada_em: f.entrada_em || f.created_at
                })).sort((a,b) => a.posicao - b.posicao);

                // Stats por atendente
                const deptAtendHoje = atendimentosHoje.filter(a => a.departamento === deptName);
                const atendentesStats = deptAtendentes.map(at => {
                    const meusLeads = deptLeads.filter(l => l.atendente_nome === at.nome);
                    const ativos = meusLeads.filter(l => l.atendimento_inicio && !l.atendimento_fim);

                    // Encerrados hoje: tabela atendimentos primeiro, fallback para leads
                    const meusAtendHoje = deptAtendHoje.filter(a => a.agente_nome === at.nome);
                    const meusLeadsEncHoje = meusLeads.filter(l => l.atendimento_fim && new Date(l.atendimento_fim) >= hoje);
                    const encHojeList = meusAtendHoje.length > 0 ? meusAtendHoje : meusLeadsEncHoje;
                    const encHojeCount = Math.max(meusAtendHoje.length, meusLeadsEncHoje.length);
                    const tmasHojeAtend = meusAtendHoje.map(a => a.tma_segundos).filter(Boolean);
                    const tmasHojeLeads = meusLeadsEncHoje.map(l => l.tma_segundos).filter(Boolean);
                    const tmasHoje = tmasHojeAtend.length > 0 ? tmasHojeAtend : tmasHojeLeads;

                    const meusAtend = deptAtend7d.filter(a => a.agente_nome === at.nome);
                    const tmas7d = meusAtend.map(a => a.tma_segundos).filter(Boolean);
                    const tmes7d = meusAtend.map(a => a.tme_segundos).filter(Boolean);
                    // Leads ativos agora (com detalhes para drill-down)
                    const leadsAtivos = ativos.map(l => ({
                        id: l.id, nome: l.nome, numero: l.numero, foto_url: l.foto_url,
                        last_msg: l.last_msg, unread: l.unread,
                        inicio: l.atendimento_inicio,
                        duracao_seg: Math.round((agora - new Date(l.atendimento_inicio).getTime()) / 1000),
                        last_interaction: l.last_interaction
                    }));
                    // Leads encerrados hoje (tabela atendimentos ou fallback leads)
                    const leadsEncerradosHoje = meusAtendHoje.length > 0
                        ? meusAtendHoje.slice(0, 20).map(a => ({ id: a.lead_id, nome: a.nome, numero: a.numero, tma: a.tma_segundos, fim: a.fim }))
                        : meusLeadsEncHoje.slice(0, 20).map(l => ({ id: l.id, nome: l.nome, numero: l.numero, tma: l.tma_segundos, fim: l.atendimento_fim }));
                    const notasAt = avaliacoes7d[at.nome] || [];
                    return {
                        id: at.id, nome: at.nome,
                        ativos: ativos.length,
                        encerradosHoje: encHojeCount,
                        tmaHoje: tmasHoje.length ? Math.round(tmasHoje.reduce((a,b)=>a+b,0)/tmasHoje.length) : 0,
                        total7d: meusAtend.length,
                        encerrados7d: meusAtend.filter(a => a.status === 'encerrado').length,
                        tma7d: tmas7d.length ? Math.round(tmas7d.reduce((a,b)=>a+b,0)/tmas7d.length) : 0,
                        tme7d: tmes7d.length ? Math.round(tmes7d.reduce((a,b)=>a+b,0)/tmes7d.length) : 0,
                        satisfacao: notasAt.length ? Math.round(notasAt.reduce((a,b)=>a+b,0)/notasAt.length*10)/10 : null,
                        totalAvaliacoes: notasAt.length,
                        leadsAtivos,
                        leadsEncerradosHoje,
                    };
                });

                // Totais do departamento (também usar tabela atendimentos para encerrados)
                const totalAtivos = deptLeads.filter(l => l.atendimento_inicio && !l.atendimento_fim).length;
                const deptEncerradosHojeAtend = deptAtendHoje.length;
                const totalEncerradosHoje = deptEncerradosHojeAtend || deptLeads.filter(l => l.atendimento_fim && new Date(l.atendimento_fim) >= hoje).length;
                const allTmasHoje = deptAtendHoje.map(a => a.tma_segundos).filter(Boolean);
                const tmaMedHoje = allTmasHoje.length ? Math.round(allTmasHoje.reduce((a,b)=>a+b,0)/allTmasHoje.length) : 0;
                const tmeAtual = deptFila.length ? Math.round(deptFila.map(f => (agora - new Date(f.entrada_em || f.created_at).getTime())/1000).reduce((a,b)=>a+b,0)/deptFila.length) : 0;

                return {
                    dept_id: dept.id, dept_nome: deptName,
                    supervisor_nome: dept.supervisor_nome || null,
                    kpis: { ativos: totalAtivos, aguardando: deptFila.length, encerradosHoje: totalEncerradosHoje, tmaMedHoje, tmeAtual },
                    fila: filaComTme,
                    atendentes: atendentesStats,
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, departamentos: result, geradoEm: new Date().toISOString() }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // GET /api/stats/ativos?inst=...  — atendimentos em andamento agora
    if (req.url.startsWith('/api/stats/ativos') && req.method === 'GET') {
        try {
            const urlParsed = new URL(req.url, 'http://localhost');
            const inst = urlParsed.searchParams.get('inst') || process.env.INSTANCE_NAME || '';

            const { data: leads } = await db.from('leads')
                .select('id, nome, numero, push_name, departamento, atendimento_inicio, foto_url')
                .eq('instance_name', inst);

            const ativos = (leads || []).filter(l => l.atendimento_inicio && !l.atendimento_fim);

            // Agrupa por departamento
            const porDept = {};
            for (const l of ativos) {
                const dept = l.departamento || 'ADM Principal';
                if (!porDept[dept]) porDept[dept] = [];
                porDept[dept].push({
                    id: l.id,
                    nome: l.push_name || l.nome || l.numero || 'Lead',
                    numero: l.numero,
                    departamento: dept,
                    inicio: l.atendimento_inicio,
                    foto_url: l.foto_url || null,
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ativos, porDept, total: ativos.length }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // GET /api/stats/satisfacao?inst=...&periodo=7  — notas de satisfação
    if (req.url.startsWith('/api/stats/satisfacao') && req.method === 'GET') {
        try {
            const urlP = new URL(req.url, 'http://localhost');
            const inst = urlP.searchParams.get('inst') || '';
            const dias = parseInt(urlP.searchParams.get('periodo') || '30');
            if (!inst) { res.writeHead(400); res.end(JSON.stringify({ error: 'inst obrigatório' })); return; }
            const desde = new Date(Date.now() - dias * 86400000).toISOString();
            const { data: avaliacoes } = await db.from('avaliacoes')
                .select('nota, agente_nome, departamento, created_at')
                .eq('instance_name', inst).gte('created_at', desde);
            const arr = avaliacoes || [];
            // Média geral
            const notas = arr.map(a => a.nota).filter(Boolean);
            const mediaGeral = notas.length ? Math.round(notas.reduce((a,b)=>a+b,0)/notas.length*10)/10 : null;
            const totalAvaliacoes = notas.length;
            // Por departamento
            const porDept = {};
            for (const a of arr) {
                const d = a.departamento || 'Sem dept';
                if (!porDept[d]) porDept[d] = { dept: d, notas: [], total: 0 };
                porDept[d].notas.push(a.nota); porDept[d].total++;
            }
            const departamentos = Object.values(porDept).map(d => ({
                dept: d.dept, media: Math.round(d.notas.reduce((a,b)=>a+b,0)/d.notas.length*10)/10, total: d.total,
            }));
            // Por atendente
            const porAgente = {};
            for (const a of arr) {
                const ag = a.agente_nome || 'Desconhecido';
                if (!porAgente[ag]) porAgente[ag] = { nome: ag, notas: [], total: 0 };
                porAgente[ag].notas.push(a.nota); porAgente[ag].total++;
            }
            const atendentes = Object.values(porAgente).map(ag => ({
                nome: ag.nome, media: Math.round(ag.notas.reduce((a,b)=>a+b,0)/ag.notas.length*10)/10, total: ag.total,
            })).sort((a,b) => b.media - a.media);
            // Distribuição (1-5)
            const distribuicao = [0,0,0,0,0];
            for (const n of notas) distribuicao[n-1]++;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, mediaGeral, totalAvaliacoes, departamentos, atendentes, distribuicao }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // GET /api/stats/tma-tme?inst=...&periodo=7  — TMA e TME por departamento
    if (req.url.startsWith('/api/stats/tma-tme') && req.method === 'GET') {
        try {
            const urlParsed = new URL(req.url, 'http://localhost');
            const inst      = urlParsed.searchParams.get('inst') || process.env.INSTANCE_NAME || '';
            const dias      = parseInt(urlParsed.searchParams.get('periodo') || '30');
            const desde     = new Date(Date.now() - dias * 86400000).toISOString();

            // Busca mensagens recentes com dados do lead
            const { data: msgs } = await db.from('messages')
                .select('lead_id, from_me, sent_by_ia, created_at')
                .eq('instance_name', inst)
                .gte('created_at', desde)
                .order('created_at', { ascending: true });

            const { data: leads } = await db.from('leads')
                .select('id, departamento, atendente_nome, tma_segundos, atendimento_inicio, atendimento_fim')
                .eq('instance_name', inst);

            if (!msgs || !leads) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,stats:[]})); return; }

            const leadDept = {};
            const leadTma  = {};
            const leadAtend = {};
            for (const l of leads) {
                leadDept[l.id] = l.departamento || 'ADM Principal';
                if (l.tma_segundos) leadTma[l.id] = l.tma_segundos;
                if (l.atendente_nome) leadAtend[l.id] = l.atendente_nome;
            }

            // Agrupa mensagens por lead
            const porLead = {};
            for (const m of msgs) {
                if (!porLead[m.lead_id]) porLead[m.lead_id] = { cliente: [], humano: [], todas: [] };
                const ts = new Date(m.created_at).getTime();
                porLead[m.lead_id].todas.push(ts);
                if (!m.from_me) porLead[m.lead_id].cliente.push(ts);
                if (m.from_me && !m.sent_by_ia) porLead[m.lead_id].humano.push(ts);
            }

            // Calcula TMA e TME por departamento E por atendente
            const porDept = {};
            const porAtendente = {};
            for (const [leadId, data] of Object.entries(porLead)) {
                const dept = leadDept[leadId] || 'ADM Principal';
                const atend = leadAtend[leadId] || null;
                if (!porDept[dept]) porDept[dept] = { tme: [], tma: [], total: 0 };
                porDept[dept].total++;

                // TME: primeira msg cliente → primeira resposta humana
                let tmeVal = null;
                if (data.cliente.length > 0 && data.humano.length > 0) {
                    const primeiraCliente = Math.min(...data.cliente);
                    const primeiraHumana  = data.humano.filter(t => t > primeiraCliente)[0];
                    if (primeiraHumana) { tmeVal = Math.round((primeiraHumana - primeiraCliente) / 1000); porDept[dept].tme.push(tmeVal); }
                }
                // TMA: usa tma_segundos real se disponível, senão estima por mensagens
                let tmaVal = null;
                if (leadTma[leadId]) {
                    tmaVal = leadTma[leadId]; porDept[dept].tma.push(tmaVal);
                } else if (data.todas.length > 1) {
                    tmaVal = Math.round((Math.max(...data.todas) - Math.min(...data.todas)) / 1000); porDept[dept].tma.push(tmaVal);
                }

                // Por atendente
                if (atend) {
                    const key = dept + '||' + atend;
                    if (!porAtendente[key]) porAtendente[key] = { dept, nome: atend, tme: [], tma: [], total: 0 };
                    porAtendente[key].total++;
                    if (tmeVal) porAtendente[key].tme.push(tmeVal);
                    if (tmaVal) porAtendente[key].tma.push(tmaVal);
                }
            }

            const fmtTempo = (s) => {
                if (!s) return '—';
                if (s < 60) return s + 's';
                if (s < 3600) return Math.floor(s/60) + 'min';
                return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'min';
            };

            // Conta fila de espera atual por departamento
            const filaAgora = {};
            try {
                const { data: filaAtiva } = await db.from('fila_atendimento').select('departamento').eq('instance_name', inst).eq('status', 'aguardando');
                for (const f of (filaAtiva || [])) {
                    const d = f.departamento || 'ADM Principal';
                    filaAgora[d] = (filaAgora[d] || 0) + 1;
                }
            } catch(e) {}

            const stats = Object.entries(porDept).map(([dept, d]) => {
                // Atendentes deste departamento
                const deptAtendentes = Object.values(porAtendente)
                    .filter(a => a.dept === dept)
                    .map(a => ({
                        nome: a.nome,
                        total: a.total,
                        tme_seg: a.tme.length ? Math.round(a.tme.reduce((x,y)=>x+y,0)/a.tme.length) : null,
                        tma_seg: a.tma.length ? Math.round(a.tma.reduce((x,y)=>x+y,0)/a.tma.length) : null,
                        tme_fmt: fmtTempo(a.tme.length ? Math.round(a.tme.reduce((x,y)=>x+y,0)/a.tme.length) : null),
                        tma_fmt: fmtTempo(a.tma.length ? Math.round(a.tma.reduce((x,y)=>x+y,0)/a.tma.length) : null),
                    }))
                    .sort((a,b) => b.total - a.total);
                return {
                    dept,
                    total: d.total,
                    tme_seg: d.tme.length ? Math.round(d.tme.reduce((a,b)=>a+b,0)/d.tme.length) : null,
                    tma_seg: d.tma.length ? Math.round(d.tma.reduce((a,b)=>a+b,0)/d.tma.length) : null,
                    tme_fmt: fmtTempo(d.tme.length ? Math.round(d.tme.reduce((a,b)=>a+b,0)/d.tme.length) : null),
                    tma_fmt: fmtTempo(d.tma.length ? Math.round(d.tma.reduce((a,b)=>a+b,0)/d.tma.length) : null),
                    tme_amostras: d.tme.length,
                    tma_amostras: d.tma.length,
                    fila_agora: filaAgora[dept] || 0,
                    atendentes: deptAtendentes,
                };
            }).sort((a,b) => b.total - a.total);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, stats, periodo: dias }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    if (req.url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            evo_url:       EVO_URL,
            evo_key:       EVO_KEY,
            server_url:    SERVER_PUBLIC_URL,
            instance_name: process.env.INSTANCE_NAME || '',
        }));
        return;
    }

    // ── API: Proxy genérico para Evolution API (evita CORS no browser) ────────
    // POST /api/evo-proxy  { path, method, body }
    // Exemplos de path: '/instance/fetchInstances', '/instance/connect/nome', etc.
    if (req.url === '/api/evo-proxy' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { path: evoPath, method: evoMethod = 'GET', body: evoBody } = JSON.parse(body);
                if (!evoPath) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'path obrigatório' })); return; }
                const evoRes = await fetch(`${EVO_URL}${evoPath}`, {
                    method: evoMethod,
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    ...(evoBody ? { body: JSON.stringify(evoBody) } : {})
                });
                const raw = await evoRes.text();
                let data; try { data = JSON.parse(raw); } catch(e) { data = raw; }
                res.writeHead(evoRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Criar licença manualmente (sem INSTANCE_NAME no .env) ──────────
    // POST /api/admin/criar-licenca
    // Body: { instance_name, license_key, plano, admin_secret }
    // admin_secret padrão: "evocrm-admin-2024" (ou env ADMIN_SECRET)
    if (req.url === '/api/admin/criar-licenca' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const ADMIN_SECRET = process.env.ADMIN_SECRET || 'evocrm-admin-2024';
                const { instance_name, license_key, plano, admin_secret } = JSON.parse(body);
                if (admin_secret !== ADMIN_SECRET) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Acesso negado' }));
                    return;
                }
                const inst  = (instance_name || '').trim().toLowerCase();
                const key   = (license_key   || 'evocrm2024').trim();
                const plan  = (plano         || 'platinum').trim();
                if (!inst) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'instance_name obrigatório' }));
                    return;
                }
                // Cria ou atualiza licença
                await db.from('licenses').upsert({
                    instance_name: inst,
                    license_key:   key,
                    plano:         plan,
                    status:        'active',
                    features: JSON.stringify({ bot: true, disparo: true, agenda: true, setores: true, ia_atendimento: true, audio_ia: true })
                }, { onConflict: 'instance_name' });
                // Garante ia_config
                const { data: iaEx } = await db.from('ia_config').select('id').eq('instance_name', inst).single();
                if (!iaEx) {
                    try { await db.from('ia_config').insert({ instance_name: inst, ativo: false, modelo: 'gpt-4o-mini', prompt: '' }); } catch(e) {}
                }
                // Inicializa instância no worker se ainda não estiver ativa
                if (!state[inst]) await inicializarInstancia(inst);
                log('sistema', 'ok', `✅ Licença criada/atualizada via API: ${inst} (${plan})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, instance_name: inst, plano: plan, license_key: key }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Auth/Login via licença ──────────────────────────────────────────
    if (req.url === '/api/auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { instance_name, license_key } = JSON.parse(body);
                const { data, error } = await db.from('licenses').select('*')
                    .eq('instance_name', instance_name.trim().toLowerCase())
                    .eq('license_key', license_key.trim())
                    .single();
                if (error || !data) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Instância ou licença inválida' }));
                    return;
                }
                if (data.status !== 'active') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Licença bloqueada' }));
                    return;
                }
                if (data.expires_at && new Date(data.expires_at) < new Date()) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Licença expirada' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data, error: null }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }


    // ── API: Login de Supervisor/Atendente (ID + senha) ────────────────────
    if (req.url === '/api/auth/staff-login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { login_id, senha } = JSON.parse(body);
                if (!login_id || !senha) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'ID e senha obrigatórios' }));
                    return;
                }
                const idTrim = login_id.trim().toUpperCase();
                const senhaTrim = senha.trim();

                // 1. Busca supervisor pelo supervisor_id
                const { data: allDepts } = await db.from('departments').select('*');
                for (const dept of (allDepts || [])) {
                    if (dept.supervisor_id && dept.supervisor_key &&
                        dept.supervisor_id.toUpperCase() === idTrim &&
                        dept.supervisor_key === senhaTrim) {
                        const { data: lic } = await db.from('licenses').select('*')
                            .eq('instance_name', dept.instance_name).single();
                        if (!lic || lic.status !== 'active') continue;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ role: 'supervisor', nome: dept.supervisor_nome, login_id: dept.supervisor_id, departamento: dept.name, instance_name: dept.instance_name, license: lic }));
                        return;
                    }
                }

                // 2. Busca atendente pelo id
                const { data: allAtend } = await db.from('dept_atendentes').select('*').eq('ativo', 1);
                for (const at of (allAtend || [])) {
                    if (at.id.toUpperCase() === idTrim && at.senha === senhaTrim) {
                        const { data: dept } = await db.from('departments').select('*').eq('id', at.dept_id).single();
                        if (!dept) continue;
                        const { data: lic } = await db.from('licenses').select('*').eq('instance_name', dept.instance_name).single();
                        if (!lic || lic.status !== 'active') continue;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ role: 'atendente', nome: at.nome, login_id: at.id, departamento: dept.name, instance_name: dept.instance_name, license: lic }));
                        return;
                    }
                }

                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ID ou senha inválidos' }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Listar todos os logins de staff (para o admin ver) ──────────────
    if (req.url.startsWith('/api/staff-logins') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const inst = url.searchParams.get('inst');
        if (!inst) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'inst obrigatório' }));
            return;
        }
        try {
            const { data: depts } = await db.from('departments').select('*').eq('instance_name', inst);
            const { data: atendentes } = await db.from('dept_atendentes').select('*').eq('instance_name', inst);
            const result = (depts || []).filter(d => d.name !== 'ADM Principal').map(d => ({
                dept_id: d.id,
                dept_nome: d.name,
                supervisor_id: d.supervisor_id || null,
                supervisor_nome: d.supervisor_nome || null,
                supervisor_key: d.supervisor_key || null,
                atendentes: (atendentes || []).filter(a => a.dept_id === d.id).map(a => ({
                    id: a.id, nome: a.nome, senha: a.senha, ativo: a.ativo
                }))
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }


    // ── API: Proxy de envio (evita CORS do browser → Evolution API) ─────────
    // ── API: Verificar números no WhatsApp (proxy CORS) ──────────────────────
    if (req.url === '/api/check-whatsapp' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { inst, numbers } = JSON.parse(body);
                if (!inst || !Array.isArray(numbers)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'inst e numbers são obrigatórios' }));
                    return;
                }
                const evoRes = await fetch(`${EVO_URL}/chat/whatsappNumbers/${inst}`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ numbers })
                });
                const rawText = await evoRes.text();
                log('sistema', 'info', `[check-whatsapp] status=${evoRes.status} body=${rawText.slice(0,500)}`);
                let data;
                try { data = JSON.parse(rawText); } catch(e) { data = []; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/api/send' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { inst, endpoint, payload } = JSON.parse(body);
                if (!inst || !endpoint) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'inst e endpoint são obrigatórios' }));
                    return;
                }
                // Valida endpoint permitido (whitelist de segurança)
                const allowed = ['sendText','sendMedia','sendWhatsAppAudio','sendPtv','sendPresence','chat/updatePresence'];
                if (!allowed.includes(endpoint)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Endpoint não permitido' }));
                    return;
                }
                const baseUrl = endpoint.startsWith('chat/') ? EVO_URL : `${EVO_URL}/message`;
                const evoRes = await fetch(`${baseUrl}/${endpoint}/${inst}`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const evoData = await evoRes.json().catch(() => ({}));
                res.writeHead(evoRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(evoData));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/api/pix' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                // Token buscado APENAS do servidor (Supabase ou env) — nunca do cliente
                const token = await getMpToken();
                if (!token) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'MP Access Token não configurado. Adicione em admin_config → mp_access_token' })); return;
                }

                const payload = JSON.parse(body);
                // Remove qualquer token que o cliente tente enviar (ignorado)
                const { mp_access_token: _ignored, ...orderBody } = payload;

                log('sistema', 'info', `[MercadoPago] Criando pagamento PIX | valor: ${orderBody.transaction_amount}`);

                const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type':  'application/json',
                        'X-Idempotency-Key': orderBody.external_reference || ('EVO-' + Date.now()),
                    },
                    body: JSON.stringify(orderBody)
                });

                const mpData = await mpRes.json();
                log('sistema', mpRes.ok ? 'ok' : 'erro', `[MercadoPago] Status: ${mpRes.status} | id: ${mpData.id || 'N/A'} | status_mp: ${mpData.status || mpData.message || ''}`);
                res.writeHead(mpRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(mpData));
            } catch (e) {
                log('sistema', 'erro', `[MercadoPago] Exceção: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── Webhook Mercado Pago: confirma pagamento e atualiza Supabase ─────────
    if (req.url.startsWith('/api/mp-webhook') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const evento = JSON.parse(body);
                log('sistema', 'info', `[MercadoPago] Webhook recebido: action=${evento.action} | id=${evento.data?.id}`);

                // MP envia: { action: "payment.updated", data: { id: "123456" } }
                if (evento.action === 'payment.updated' || evento.action === 'payment.created') {
                    const paymentId = evento.data?.id;
                    if (!paymentId) { res.writeHead(200); res.end('{}'); return; }

                    // Busca detalhes do pagamento na API do MP
                    const token = await getMpToken();
                    if (!token) { log('sistema', 'erro', '[MercadoPago] Token não configurado no webhook'); res.writeHead(200); res.end('{}'); return; }
                    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const mpData = await mpRes.json();

                    // mpData.status: "approved", "pending", "rejected", "cancelled"
                    // mpData.external_reference → nosso reference_id salvo no Supabase
                    const refId  = mpData.external_reference;
                    const status = mpData.status;

                    if (refId && status === 'approved') {
                        await db
                            .from('pagamentos')
                            .update({ status: 'approved', mp_payment_id: String(paymentId) })
                            .eq('reference_id', refId);
                        log('sistema', 'ok', `[MercadoPago] ✅ Pagamento aprovado: ${paymentId} | ref: ${refId}`);
                    } else if (refId && (status === 'rejected' || status === 'cancelled')) {
                        await db
                            .from('pagamentos')
                            .update({ status: status, mp_payment_id: String(paymentId) })
                            .eq('reference_id', refId);
                        log('sistema', 'warn', `[MercadoPago] Pagamento ${status}: ${paymentId}`);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: true }));
            } catch (e) {
                log('sistema', 'erro', `[MercadoPago] Webhook erro: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Public Key MP (seguro — não expõe o access token) ───────────────
    if (req.url === '/api/mp-public-key' && req.method === 'GET') {
        const pk = await getMpPublicKey();
        res.writeHead(pk ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pk ? { public_key: pk } : { error: 'mp_public_key não configurada' }));
        return;
    }


    // ── API: Criar instância Evolution + salvar no Supabase após pagamento ───
    if (req.url === '/api/criar-instancia' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { instancia, pedido_id } = JSON.parse(body);
                if (!instancia || !pedido_id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'instancia e pedido_id são obrigatórios' })); return;
                }

                // 1. Verifica se pagamento está aprovado no Supabase
                const { data: pag } = await db.from('pagamentos').select('*').eq('id', pedido_id).single();
                if (!pag || pag.status !== 'approved') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Pagamento não confirmado' })); return;
                }

                // 2. Cria instância na Evolution API
                const evoRes = await fetch(`${EVO_URL}/instance/create`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        instanceName:       instancia,
                        qrcode:             true,
                        integration:        'WHATSAPP-BAILEYS',
                        rejectCall:         false,
                        groupsIgnore:       false,
                        alwaysOnline:       false,
                        readMessages:       false,
                        readStatus:         false,
                        syncFullHistory:    false,
                    })
                });
                const evoData = await evoRes.json();
                log('sistema', evoRes.ok ? 'ok' : 'warn', `[CriarInstancia] ${instancia} → ${JSON.stringify(evoData).substring(0,200)}`);

                // 3. Salva/upsert ia_config no Supabase para a instância
                await db.from('ia_config').upsert({
                    instance_name: instancia,
                    ativo:         false,
                    modelo:        'gpt-4o-mini',
                    prompt:        '',
                    delay_min:     1,
                    delay_max:     3,
                }, { onConflict: 'instance_name' });

                // 4. Atualiza pagamento com instancia_criada = true
                await db.from('pagamentos').update({ instancia_criada: true }).eq('id', pedido_id);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, instancia, evo: evoData }));
            } catch(e) {
                log('sistema', 'erro', `[CriarInstancia] ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Renovar licença existente após pagamento de renovação ──────────
    if (req.url === '/api/renovar-licenca' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { pedido_id, instancia } = JSON.parse(body);
                if (!pedido_id || !instancia) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'pedido_id e instancia são obrigatórios' })); return;
                }

                // 1. Verifica se pagamento está aprovado
                const { data: pag } = await db.from('pagamentos').select('*').eq('id', pedido_id).single();
                if (!pag || pag.status !== 'approved') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Pagamento não confirmado' })); return;
                }

                // 2. Calcula nova data de expiração
                const DIAS_MENSAL = 30;
                const DIAS_ANUAL  = 365;
                const dias    = pag.billing === 'anual' ? DIAS_ANUAL : DIAS_MENSAL;
                const expires = new Date();
                expires.setDate(expires.getDate() + dias);

                // 3. Atualiza licença no Supabase (estende prazo, mantém instância)
                const { error } = await db.from('licenses')
                    .update({
                        status:     'active',
                        plano:      pag.plano,
                        expires_at: expires.toISOString(),
                        is_trial:   false,
                    })
                    .eq('instance_name', instancia);

                if (error) throw new Error(error.message);

                // 4. Atualiza expires_at no pagamento
                await db.from('pagamentos')
                    .update({ expires_at: expires.toISOString() })
                    .eq('id', pedido_id);

                log('sistema', 'ok', `[RenovarLicenca] ✅ Licença renovada: ${instancia} | plano: ${pag.plano} | até: ${expires.toISOString()}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, instancia, plano: pag.plano, expires_at: expires.toISOString() }));
            } catch(e) {
                log('sistema', 'erro', `[RenovarLicenca] ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── PAINEL DE STORAGE (/storage) ─────────────────────────────────────────
    if (req.url === '/storage' || req.url === '/storage.html') {
        const panelPath = pathMod.join(__dirname, 'storage.html');
        fs2.readFile(panelPath, (err, data) => {
            if (err) { res.writeHead(404); res.end('storage.html não encontrado'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }

    // ── API: Listar arquivos do storage (/api/storage/list) ──────────────────
    if (req.url === '/api/storage/list' && req.method === 'GET') {
        try {
            const result = [];
            function scanDir(dir, base) {
                if (!fsSync.existsSync(dir)) return;
                for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
                    const full = pathMod.join(dir, entry.name);
                    const rel  = base ? `${base}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        scanDir(full, rel);
                    } else {
                        const stat = fsSync.statSync(full);
                        result.push({
                            path: rel,
                            url: `${SERVER_PUBLIC_URL}/uploads/${rel}`,
                            size: stat.size,
                            modified: stat.mtime.toISOString(),
                            ext: pathMod.extname(entry.name).toLowerCase(),
                        });
                    }
                }
            }
            scanDir(UPLOADS_DIR, '');
            result.sort((a, b) => new Date(b.modified) - new Date(a.modified));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files: result, total: result.length }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── API: Deletar arquivo do storage (/api/storage/delete) ────────────────
    if (req.url === '/api/storage/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { path: filePath } = JSON.parse(body);
                if (!filePath) throw new Error('path obrigatório');
                // Segurança: impede path traversal
                const safe = filePath.replace(/\.\./g, '').replace(/^\/+/, '');
                const full = pathMod.join(UPLOADS_DIR, safe);
                if (!full.startsWith(UPLOADS_DIR)) throw new Error('Path inválido');
                if (!fsSync.existsSync(full)) throw new Error('Arquivo não encontrado');
                const stat = fsSync.statSync(full);
                fsSync.unlinkSync(full);
                console.log(`🗑️ [Storage] Deletado: ${full}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, freed: stat.size }));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── PROXY: Foto de perfil WhatsApp com cache local ──────────────────────
    // Salva automaticamente em /uploads/avatares/ e retorna URL local (24h TTL).
    if (req.url.startsWith('/api/profile-pic/')) {
        const rawPath   = req.url.split('?')[0];
        const number    = rawPath.split('/api/profile-pic/')[1] || '';
        const urlParams = new URLSearchParams((req.url.split('?')[1]) || '');
        const inst      = urlParams.get('inst') || '';
        const noCache   = urlParams.get('nocache') === '1';

        if (!number || !inst) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url: null, error: 'missing params' }));
            return;
        }

        try {
            // Verifica cache local primeiro (exceto se nocache=1)
            const safeName  = number.replace(/[^0-9]/g, '');
            const localFile = pathMod.join(UPLOADS_DIR, 'avatares', `${safeName}.jpg`);
            if (!noCache && fsSync.existsSync(localFile)) {
                const ageHours = (Date.now() - fsSync.statSync(localFile).mtime.getTime()) / 3600000;
                if (ageHours < 24) {
                    const cachedUrl = `${SERVER_PUBLIC_URL}/uploads/avatares/${safeName}.jpg`;
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
                    res.end(JSON.stringify({ url: cachedUrl, cached: true }));
                    return;
                }
            }

            // Busca + faz cache local
            const picUrl = await fetchAndCacheAvatar(inst, number);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
            res.end(JSON.stringify({ url: picUrl || null, cached: false }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url: null }));
        }
        return;
    }

    // ── API: QR Code da instância (busca + salva localmente) ─────────────────
    // GET /api/qrcode/:inst
    // Busca o QR code da Evolution API, salva em /uploads/qrcodes/ e retorna URL local.
    if (req.url.startsWith('/api/qrcode/') && req.method === 'GET') {
        const inst = req.url.split('/api/qrcode/')[1]?.split('?')[0] || '';
        if (!inst) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'inst obrigatório' })); return; }

        try {
            // 1. Tenta /instance/connect (retorna QR)
            let qrData = {};
            try {
                const qrRes = await fetch(`${EVO_URL}/instance/connect/${inst}`, { headers: { 'apikey': EVO_KEY } });
                const text = await qrRes.text();
                try { qrData = JSON.parse(text); } catch(e) {
                    log('sistema', 'erro', `[QR] Resposta não-JSON da Evolution para ${inst}: ${text.substring(0, 200)}`);
                    qrData = {};
                }
            } catch(fetchErr) {
                log('sistema', 'erro', `[QR] Falha ao conectar na Evolution: ${fetchErr.message}`);
            }

            const base64Raw = qrData?.qrcode?.base64 || qrData?.base64 || null;
            const remoteUrl = qrData?.qrcode?.url    || qrData?.url    || null;

            let localUrl = null;
            const fileName = `qr_${inst}_${Date.now()}.png`;

            if (base64Raw) {
                try {
                    const b64 = base64Raw.replace(/^data:image\/\w+;base64,/, '');
                    localUrl = localSave('qrcodes', fileName, Buffer.from(b64, 'base64'));
                } catch(saveErr) {
                    log('sistema', 'erro', `[QR] Falha ao salvar base64: ${saveErr.message}`);
                }
            } else if (remoteUrl) {
                try {
                    const imgRes = await fetch(remoteUrl);
                    if (imgRes.ok) localUrl = localSave('qrcodes', fileName, Buffer.from(await imgRes.arrayBuffer()));
                } catch(imgErr) {
                    log('sistema', 'erro', `[QR] Falha ao baixar imagem remota: ${imgErr.message}`);
                }
            }

            // Remove QR codes antigos da instância (mantém só o último)
            try {
                const dir = pathMod.join(UPLOADS_DIR, 'qrcodes');
                if (fsSync.existsSync(dir)) {
                    fsSync.readdirSync(dir)
                        .filter(f => f.startsWith(`qr_${inst}_`) && f !== fileName)
                        .forEach(f => { try { fsSync.unlinkSync(pathMod.join(dir, f)); } catch(e) {} });
                }
            } catch(e) {}

            // 2. Se sem QR, verifica estado da conexão
            const state = qrData?.instance?.state || qrData?.state || qrData?.instance?.status || qrData?.status || null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: !!localUrl || !!base64Raw,
                url: localUrl,
                base64: base64Raw || null,
                state: state,
                raw: (!localUrl && !base64Raw) ? qrData : undefined
            }));
        } catch(e) {
            log('sistema', 'erro', `[QR] Erro inesperado para ${inst}: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── API: Exportar dados (CSV ou JSON) ─────────────────────────────────────
    // POST /api/export  { inst, tipo: 'leads'|'agendamentos'|'mensagens', formato: 'csv'|'json' }
    // Salva arquivo em /uploads/exports/ e retorna URL para download.
    if (req.url === '/api/export' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, tipo = 'leads', formato = 'csv' } = JSON.parse(body);
                if (!inst) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'inst obrigatório' })); return; }

                let data = [], campos = [];

                if (tipo === 'leads') {
                    const r = await db.from('leads').select('*').eq('instance_name', inst);
                    data   = r.data || [];
                    campos = ['id','nome','numero','status','etiquetas','created_at'];
                } else if (tipo === 'agendamentos') {
                    const r = await db.from('agendamentos_crm').select('*').eq('instance_name', inst);
                    data   = r.data || [];
                    campos = ['id','lead_id','numero','tipo','texto','data_hora','status','sent','created_at'];
                } else if (tipo === 'mensagens') {
                    const r = await db.from('messages').select('*').eq('instance_name', inst).order('created_at', { ascending: false }).limit(5000);
                    data   = r.data || [];
                    campos = ['id','lead_id','content','type','from_me','sent_by_ia','created_at'];
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'tipo inválido. Use: leads, agendamentos, mensagens' })); return;
                }

                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                let fileBuffer, fileName;

                if (formato === 'json') {
                    fileBuffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
                    fileName   = `${tipo}_${inst}_${timestamp}.json`;
                } else {
                    // BOM UTF-8 (\uFEFF) para Excel reconhecer acentos
                    fileBuffer = Buffer.from('\uFEFF' + gerarCSV(data, campos), 'utf8');
                    fileName   = `${tipo}_${inst}_${timestamp}.csv`;
                }

                const url = localSave('exports', fileName, fileBuffer);
                log('sistema', 'ok', `[Export] ${tipo} exportado: ${data.length} registros → ${fileName}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url, total: data.length, arquivo: fileName }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Stickers — enviar sticker salvo localmente ───────────────────────
    // POST /api/sticker/send  { inst, number, url }  (url pode ser local ou externa)
    // O arquivo .webp deve ser enviado via /local-upload com path "stickers/nome.webp"
    if (req.url === '/api/sticker/send' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, number, url: stickerUrl } = JSON.parse(body);
                if (!inst || !number || !stickerUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'inst, number e url são obrigatórios' })); return;
                }
                const evoRes = await fetch(`${EVO_URL}/message/sendMedia/${inst}`, {
                    method: 'POST',
                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number, mediatype: 'image', mimetype: 'image/webp', media: stickerUrl, isSticker: true })
                });
                const evoData = await evoRes.json().catch(() => ({}));
                log('sistema', evoRes.ok ? 'ok' : 'warn', `[Sticker] Enviado para ${number}: ${evoRes.status}`);
                res.writeHead(evoRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(evoData));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // GET /api/sticker/list — lista stickers disponíveis
    if (req.url === '/api/sticker/list' && req.method === 'GET') {
        try {
            const dir = pathMod.join(UPLOADS_DIR, 'stickers');
            ensureDir('stickers');
            const files = fsSync.existsSync(dir)
                ? fsSync.readdirSync(dir).filter(f => f.endsWith('.webp') || f.endsWith('.png') || f.endsWith('.gif'))
                    .map(f => ({
                        name: f,
                        url: `${SERVER_PUBLIC_URL}/uploads/stickers/${f}`,
                        size: fsSync.statSync(pathMod.join(dir, f)).size,
                    }))
                : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, stickers: files, total: files.length }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── API: Templates de mídia para campanhas ────────────────────────────────
    // Templates são enviados via /local-upload com path "templates/nome.jpg"
    // GET /api/templates/list  — lista templates disponíveis por tipo
    if (req.url === '/api/templates/list' && req.method === 'GET') {
        try {
            ensureDir('templates');
            const dir = pathMod.join(UPLOADS_DIR, 'templates');
            const result = [];
            if (fsSync.existsSync(dir)) {
                for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory()) continue;
                    const ext  = pathMod.extname(entry.name).toLowerCase();
                    const stat = fsSync.statSync(pathMod.join(dir, entry.name));
                    const tipo = ['.jpg','.jpeg','.png','.webp','.gif'].includes(ext) ? 'image'
                               : ['.mp4','.mov','.avi'].includes(ext)                 ? 'video'
                               : ['.mp3','.ogg','.aac'].includes(ext)                ? 'audio'
                               : ['.pdf','.doc','.docx','.xlsx'].includes(ext)       ? 'document'
                               : 'other';
                    result.push({
                        name:     entry.name,
                        url:      `${SERVER_PUBLIC_URL}/uploads/templates/${entry.name}`,
                        tipo,
                        size:     stat.size,
                        modified: stat.mtime.toISOString(),
                    });
                }
            }
            result.sort((a, b) => new Date(b.modified) - new Date(a.modified));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, templates: result, total: result.length }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // DELETE /api/templates/delete  { name }  — remove template pelo nome
    if (req.url === '/api/templates/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { name } = JSON.parse(body);
                if (!name) throw new Error('name obrigatório');
                const safe = name.replace(/[/\\..]/g, '').trim();
                const full = pathMod.join(UPLOADS_DIR, 'templates', safe);
                if (!full.startsWith(pathMod.join(UPLOADS_DIR, 'templates'))) throw new Error('Path inválido');
                if (!fsSync.existsSync(full)) throw new Error('Template não encontrado');
                fsSync.unlinkSync(full);
                log('sistema', 'ok', `[Templates] Removido: ${safe}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── API: Backup manual e listagem de backups ──────────────────────────────
    // POST /api/backup/trigger  — força backup imediato
    if (req.url === '/api/backup/trigger' && req.method === 'POST') {
        try {
            const resultado = await executarBackup();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...resultado }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // GET /api/backup/list  — lista backups disponíveis
    if (req.url === '/api/backup/list' && req.method === 'GET') {
        try {
            ensureDir('backups');
            const dir   = pathMod.join(UPLOADS_DIR, 'backups');
            const files = fsSync.existsSync(dir)
                ? fsSync.readdirSync(dir)
                    .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
                    .map(f => {
                        const stat = fsSync.statSync(pathMod.join(dir, f));
                        return { name: f, url: `${SERVER_PUBLIC_URL}/uploads/backups/${f}`, size: stat.size, modified: stat.mtime.toISOString() };
                    })
                    .sort((a, b) => new Date(b.modified) - new Date(a.modified))
                : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, backups: files, total: files.length }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── WEBHOOK: Evolution API → insere mensagens no SQLite ──────────────────
    // Configure na Evolution API:
    //   URL: https://SEU_DOMINIO/webhook/NOME_DA_INSTANCIA
    //   Eventos: MESSAGES_UPSERT, MESSAGES_UPDATE, CONNECTION_UPDATE
    if (req.url.startsWith('/webhook/') && req.method === 'POST') {
        const inst = req.url.split('/webhook/')[1]?.split('?')[0].split('/')[0] || '';
        if (!inst) { res.writeHead(400); res.end('{}'); return; }

        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            // Responde imediatamente — Evolution não fica esperando
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

            try {
                const evt = JSON.parse(body);
                const event = evt.event || evt.type || '';
                log(inst, 'info', `[Webhook] ${event}`);

                // ── MESSAGES_UPSERT ──────────────────────────────────────────
                if (event === 'MESSAGES_UPSERT' || event === 'messages.upsert') {
                    const rawMsgs = evt.data?.messages || (Array.isArray(evt.data) ? evt.data : [evt.data]);
                    for (const m of rawMsgs) {
                        if (!m || !m.key) continue;
                        const fromMe    = m.key.fromMe ?? false;
                        const remoteJid = m.key.remoteJid || '';
                        const isGroup   = remoteJid.includes('@g.us');
                        const s         = getState(inst);
                        if (isGroup && !s.config?.responderGrupos) continue;

                        const numero   = remoteJid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '').replace(/@c\.us$/, '');
                        const pushName = m.pushName || m.verifiedBizName || null;
                        const msgKeys  = m.message ? Object.keys(m.message) : [];
                        const rawType  = msgKeys[0] || 'text';
                        const type     = rawType.includes('image') ? 'image' : rawType.includes('video') ? 'video' :
                                         rawType.includes('audio') || rawType.includes('ptt') ? 'audio' :
                                         rawType.includes('document') ? 'document' : 'text';

                        let content = m.message?.conversation ||
                            m.message?.extendedTextMessage?.text ||
                            m.message?.imageMessage?.caption ||
                            m.message?.videoMessage?.caption ||
                            m.message?.documentMessage?.caption ||
                            m.message?.buttonsResponseMessage?.selectedDisplayText ||
                            m.message?.listResponseMessage?.title || '';

                        // Download de mídia — salva localmente
                        if (type !== 'text' && EVO_URL) {
                            try {
                                const mRes = await fetch(`${EVO_URL}/chat/getBase64FromMediaMessage/${inst}`, {
                                    method: 'POST',
                                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ message: { key: m.key, message: m.message }, convertToMp4: false })
                                });
                                if (mRes.ok) {
                                    const mData = await mRes.json().catch(() => ({}));
                                    if (mData.base64) {
                                        let ext = type === 'audio' ? 'ogg' : type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : 'bin';
                                        if (type === 'document') {
                                            const docMime = m.message?.documentMessage?.mimetype || '';
                                            const docFN   = m.message?.documentMessage?.fileName || '';
                                            if (docFN.includes('.')) ext = docFN.split('.').pop().toLowerCase();
                                            else if (docMime.includes('pdf')) ext = 'pdf';
                                            else if (docMime.includes('word') || docMime.includes('docx')) ext = 'docx';
                                            else if (docMime.includes('excel') || docMime.includes('xlsx')) ext = 'xlsx';
                                            else if (docMime.includes('text/plain')) ext = 'txt';
                                            else ext = 'bin';
                                        }
                                        const fname = `${m.key.id || Date.now()}.${ext}`;
                                        const buf = Buffer.from(mData.base64, 'base64');
                                        content = localSave(`chat_media/${inst}`, fname, buf);
                                    }
                                }
                            } catch(e) { log(inst, 'warn', `[Webhook] Mídia: ${e.message}`); }
                        }

                        // Busca ou cria lead
                        let lead = null;
                        try {
                            const { data: found } = await db.from('leads').select('*').eq('numero', numero).eq('instance_name', inst).single();
                            lead = found;
                        } catch(e) {}

                        if (!lead) {
                            const { data: novo } = await db.from('leads').insert({
                                instance_name: inst, numero,
                                nome: pushName || numero,
                                status: (await getPrimeiraColuna(inst)), departamento: 'ADM Principal',
                                unread: fromMe ? 0 : 1,
                                last_msg: content || `[${type}]`,
                                last_interaction: new Date().toISOString(),
                            });
                            lead = Array.isArray(novo) ? novo[0] : novo;
                        }
                        if (!lead) continue;

                        // Atualiza unread e last_msg no lead recebido
                        if (!fromMe) {
                            const updateData = {
                                last_msg: content || `[${type}]`,
                                last_interaction: new Date().toISOString(),
                                unread: (lead.unread || 0) + 1,
                                push_name: pushName || lead.push_name,
                                followup_count: 0,
                                followup_last_at: null,
                            };
                            // Marca início do atendimento na primeira mensagem do cliente
                            if (!lead.atendimento_inicio) {
                                updateData.atendimento_inicio = new Date().toISOString();
                                lead.atendimento_inicio = updateData.atendimento_inicio;
                            }
                            // Cliente respondeu → desativa followup (gestor reativa manualmente se precisar)
                            updateData.followup_lead_ativo = false;
                            db.from('leads').update(updateData).eq('id', lead.id).then(()=>{},()=>{});

                            // ── Intercepta resposta de pesquisa de satisfação ──
                            if (lead.aguardando_avaliacao && content && type === 'text') {
                                try {
                                    // Extrai nota de 1 a 5 da resposta
                                    const texto = content.trim();
                                    let nota = null;
                                    // Tentativa direta: número puro
                                    const numMatch = texto.match(/^[1-5]$/);
                                    if (numMatch) {
                                        nota = parseInt(numMatch[0]);
                                    } else {
                                        // Busca qualquer número de 1-5 no texto
                                        const nums = texto.match(/\b([1-5])\b/);
                                        if (nums) nota = parseInt(nums[1]);
                                    }
                                    // Fallback: emojis de estrela
                                    if (!nota) {
                                        const estrelas = (texto.match(/⭐/g) || []).length;
                                        if (estrelas >= 1 && estrelas <= 5) nota = estrelas;
                                    }

                                    if (nota) {
                                        const crypto = require('crypto');
                                        await db.from('avaliacoes').insert({
                                            id: crypto.randomUUID(),
                                            instance_name: inst,
                                            lead_id: lead.id,
                                            atendimento_id: lead.ultimo_atendimento_id || null,
                                            departamento: lead.ultimo_departamento || lead.departamento || '',
                                            agente_nome: lead.ultimo_agente || lead.atendente_nome || '',
                                            numero: lead.numero,
                                            nome: lead.nome || pushName || '',
                                            nota,
                                            comentario: texto,
                                            created_at: new Date().toISOString(),
                                        });
                                        // Limpa flag
                                        await db.from('leads').update({
                                            aguardando_avaliacao: 0,
                                            ultimo_atendimento_id: null,
                                            ultimo_agente: null,
                                            ultimo_departamento: null,
                                        }).eq('id', lead.id);
                                        lead.aguardando_avaliacao = 0;

                                        // Agradece
                                        const agradecimento = nota >= 4
                                            ? `Obrigado pela avaliação! 😊 Ficamos felizes com sua nota *${nota}/5*. Até a próxima!`
                                            : `Obrigado pela avaliação! Sua nota *${nota}/5* foi registrada. Vamos trabalhar para melhorar nosso atendimento.`;
                                        try {
                                            await fetch(`${EVO_URL}/message/sendText/${inst}`, {
                                                method: 'POST',
                                                headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ number: lead.numero, text: agradecimento })
                                            });
                                            await db.from('messages').insert({
                                                instance_name: inst, lead_id: lead.id,
                                                content: agradecimento, type: 'text',
                                                from_me: true, status: 'sent', sent_by_ia: true,
                                                timestamp: new Date().toISOString(), created_at: new Date().toISOString(),
                                            }).catch(() => {});
                                        } catch(e4) {}

                                        log(inst, 'ok', `[Satisfação] Nota ${nota}/5 de ${lead.nome || lead.numero} → agente: ${lead.ultimo_agente}`);
                                        continue; // Não processa mais essa mensagem (não aciona IA)
                                    }
                                    // Se não conseguiu extrair nota, ignora e deixa passar para IA normalmente
                                } catch(e4) { log(inst, 'warn', `[Satisfação] Erro ao processar: ${e4.message}`); }
                            }
                        }

                        // Evita duplicatas
                        const msgId = m.key.id || null;
                        if (msgId) {
                            try {
                                const { data: ex } = await db.from('messages').select('id').eq('id', msgId).single();
                                if (ex) continue;
                            } catch(e) {}
                        }

                        // Se fromMe, verifica se é eco de mensagem enviada pela IA/sistema (sent_by_ia: true)
                        // Evita pausar IA por eco do WhatsApp de mensagens automáticas
                        let sentByIaFinal = fromMe ? false : null;
                        if (fromMe && content) {
                            try {
                                const cincoMinAtras = new Date(Date.now() - 5 * 60 * 1000).toISOString();
                                const { data: iaMsg } = await db.from('messages')
                                    .select('id')
                                    .eq('instance_name', inst)
                                    .eq('lead_id', lead.id)
                                    .eq('from_me', true)
                                    .eq('sent_by_ia', true)
                                    .eq('content', content || `[${type}]`)
                                    .gte('created_at', cincoMinAtras)
                                    .limit(1);
                                if (iaMsg && iaMsg.length > 0) { continue; } // eco de msg da IA — ignora
                            } catch(e) {}
                        }

                        // Insere — dbEvents emite 'change' automaticamente via db.js
                        await db.from('messages').insert({
                            ...(msgId ? { id: msgId } : {}),
                            instance_name: inst, lead_id: lead.id,
                            content: content || `[${type}]`, type,
                            from_me: fromMe, status: fromMe ? 'sent' : 'received',
                            sent_by_ia: sentByIaFinal,
                            push_name: pushName,
                            timestamp: new Date().toISOString(),
                            created_at: new Date().toISOString(),
                        });
                        log(inst, fromMe ? 'info' : 'ok', `[Webhook] ${fromMe ? '→' : '←'} ${numero}: ${(content||`[${type}]`).substring(0,60)}`);

                        // ── ROTEAMENTO POR PALAVRAS-CHAVE ──────────────────────────
                        // Verifica se a mensagem do CLIENTE contém palavras-chave de algum departamento
                        if (!fromMe && content && type === 'text') {
                            try {
                                const { data: allDepts } = await db.from('departments').select('*').eq('instance_name', inst);
                                if (allDepts && allDepts.length > 0) {
                                    const msgLower = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                                    const deptAtual = lead.departamento || 'ADM Principal';
                                    let matched = null;

                                    for (const dept of allDepts) {
                                        if (!dept.palavras_chave || !dept.palavras_chave.trim()) continue;
                                        if ((dept.name || dept.nome) === deptAtual) continue; // já está nesse dept
                                        const keywords = dept.palavras_chave.split(',').map(k => k.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')).filter(k => k.length > 0);
                                        for (const kw of keywords) {
                                            if (msgLower.includes(kw)) { matched = dept; break; }
                                        }
                                        if (matched) break;
                                    }

                                    if (matched) {
                                        const deptNome = matched.name || matched.nome;
                                        log(inst, 'ok', `[Roteamento] 🔄 Palavra-chave detectada → "${deptNome}" (lead: ${numero})`);

                                        // 1. Atualiza departamento do lead
                                        await db.from('leads').update({ departamento: deptNome }).eq('id', lead.id);
                                        lead.departamento = deptNome;

                                        // 2. Envia mensagem ao cliente avisando do redirecionamento
                                        const msgRota = matched.msg_roteamento || '';
                                        if (msgRota.trim()) {
                                            try {
                                                await fetch(`${EVO_URL}/message/sendText/${inst}`, {
                                                    method: 'POST',
                                                    headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ number: numero, text: msgRota })
                                                });
                                                // Salva a mensagem no histórico
                                                await db.from('messages').insert({
                                                    instance_name: inst, lead_id: lead.id,
                                                    content: msgRota, type: 'text',
                                                    from_me: true, status: 'sent', sent_by_ia: true,
                                                    timestamp: new Date().toISOString(),
                                                    created_at: new Date().toISOString(),
                                                });
                                                log(inst, 'ok', `[Roteamento] 💬 Mensagem de redirecionamento enviada para ${numero}`);
                                            } catch(e) { log(inst, 'warn', `[Roteamento] Falha ao enviar msg: ${e.message}`); }
                                        }

                                        // 3. Notificação no dashboard
                                        await db.from('dash_notifs').insert({
                                            instance_name: inst,
                                            title: `🔄 Cliente direcionado → ${deptNome}`,
                                            body: `${pushName || numero} mencionou palavras-chave de ${deptNome}. Contato: ${numero}`,
                                            type: 'info', read: false, criado_por_ia: true, lead_id: lead.id
                                        }).catch(() => {});

                                        // 4. Alerta em tempo real via WebSocket
                                        wsEmit(inst, {
                                            type: 'dept_route',
                                            departamento: deptNome,
                                            lead_id: lead.id,
                                            lead_nome: pushName || numero,
                                            lead_numero: numero,
                                            motivo: `Palavra-chave detectada na mensagem`,
                                            de: deptAtual
                                        });

                                        // 5. Entra na fila do novo departamento
                                        enfileirarLead(inst, lead, deptNome, 'Palavra-chave detectada').catch(()=>{});
                                    }
                                }
                            } catch(e) { log(inst, 'warn', `[Roteamento] Erro: ${e.message}`); }
                        }
                    }
                }

                // ── MESSAGES_UPDATE: status entrega/leitura ──────────────────
                if (event === 'MESSAGES_UPDATE' || event === 'messages.update') {
                    const updates = evt.data?.updates || (Array.isArray(evt.data) ? evt.data : []);
                    for (const u of updates) {
                        const msgId = u.key?.id;
                        if (!msgId) continue;
                        const map = { READ: 'read', DELIVERY_ACK: 'delivered', SERVER_ACK: 'sent' };
                        const st  = map[u.update?.status];
                        if (st) db.from('messages').update({ status: st }).eq('id', msgId).then(()=>{},()=>{});
                    }
                }

                // ── CONNECTION_UPDATE: estado da conexão ────────────────────
                if (event === 'CONNECTION_UPDATE' || event === 'connection.update') {
                    const status = evt.data?.state || evt.data?.status || '';
                    log(inst, status === 'open' ? 'ok' : 'warn', `[Webhook] Conexão: ${status}`);
                    wsEmit(inst, { type: 'connection', event: status, data: evt.data });
                }

            } catch(e) {
                log(inst, 'erro', `[Webhook] ${e.message}`);
            }
        });
        return;
    }


    // ── API: BASE DE CONHECIMENTO ─────────────────────────────────────────────

    // Chunking helper — divide texto em pedaços de ~800 chars com overlap
    function chunkText(text, size = 800, overlap = 100) {
        const chunks = [];
        let i = 0;
        while (i < text.length) {
            chunks.push(text.slice(i, i + size).trim());
            i += size - overlap;
        }
        return chunks.filter(c => c.length > 20);
    }

    // POST /api/knowledge/upload  — Upload de documento (multipart)
    if (req.url === '/api/knowledge/upload' && req.method === 'POST') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            try {
                const raw = Buffer.concat(chunks);
                const ct = req.headers['content-type'] || '';
                const boundary = ct.split('boundary=')[1];
                if (!boundary) throw new Error('Multipart boundary não encontrado');

                const parts = parseMultipart(raw, boundary);
                const instPart = parts.find(p => p.name === 'inst');
                const filePart = parts.find(p => p.name === 'file');
                if (!instPart || !filePart) throw new Error('inst e file são obrigatórios');

                const inst = instPart.data.toString('utf8').trim();
                const fileName = filePart.filename || 'documento.txt';
                const ext = (fileName.split('.').pop() || 'txt').toLowerCase();
                const fileBuffer = filePart.data;

                let textoExtraido = '';

                if (ext === 'pdf') {
                    const pdfParse = require('pdf-parse');
                    const pdfData = await pdfParse(fileBuffer);
                    textoExtraido = pdfData.text || '';
                } else if (ext === 'docx') {
                    const mammoth = require('mammoth');
                    const result = await mammoth.extractRawText({ buffer: fileBuffer });
                    textoExtraido = result.value || '';
                } else if (ext === 'txt' || ext === 'csv' || ext === 'md') {
                    textoExtraido = fileBuffer.toString('utf8');
                } else {
                    // Tenta ler como texto
                    textoExtraido = fileBuffer.toString('utf8');
                }

                if (!textoExtraido.trim()) throw new Error('Não foi possível extrair texto do arquivo');

                const textChunks = chunkText(textoExtraido);
                log(inst, 'ok', `[Knowledge] 📄 Upload: "${fileName}" → ${textoExtraido.length} chars, ${textChunks.length} chunks`);

                const { data: doc, error } = await db.from('knowledge_docs').insert({
                    instance_name: inst,
                    nome: fileName,
                    tipo: ext,
                    conteudo_raw: textoExtraido,
                    chunks: JSON.stringify(textChunks),
                    tamanho: fileBuffer.length
                });
                if (error) throw new Error(error.message);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, doc, chunks: textChunks.length, chars: textoExtraido.length }));
            } catch(e) {
                log('knowledge', 'erro', `[Knowledge] Upload falhou: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // GET /api/knowledge/docs?inst=X  — Lista documentos
    if (req.url.startsWith('/api/knowledge/docs') && req.method === 'GET') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const inst = url.searchParams.get('inst') || '';
            const { data } = await db.from('knowledge_docs')
                .select('id, instance_name, nome, tipo, tamanho, created_at')
                .eq('instance_name', inst)
                .order('created_at', { ascending: false });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: data || [] }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // DELETE /api/knowledge/docs?id=X  — Remove documento
    if (req.url.startsWith('/api/knowledge/docs') && req.method === 'DELETE') {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const id = url.searchParams.get('id') || '';
            if (!id) throw new Error('id obrigatório');
            await db.from('knowledge_docs').delete().eq('id', id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // POST /api/knowledge/ask  — Consulta à base de conhecimento
    if (req.url === '/api/knowledge/ask' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { inst, question } = JSON.parse(body);
                if (!inst || !question) throw new Error('inst e question obrigatórios');

                // Busca API key
                const apiKey = await getApiKey(inst);
                if (!apiKey) throw new Error('API Key não configurada. Configure em Configurações da IA.');

                // Busca todos os documentos da instância
                const { data: docs } = await db.from('knowledge_docs')
                    .select('nome, chunks')
                    .eq('instance_name', inst);

                if (!docs || docs.length === 0) throw new Error('Nenhum documento na base de conhecimento. Faça upload de documentos primeiro.');

                // Coleta todos os chunks e faz ranking por relevância (keyword matching)
                const queryWords = question.toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .split(/\s+/).filter(w => w.length > 2);

                let allChunks = [];
                for (const doc of docs) {
                    let parsed = [];
                    try { parsed = typeof doc.chunks === 'string' ? JSON.parse(doc.chunks) : (doc.chunks || []); } catch(e) {}
                    for (const chunk of parsed) {
                        const chunkNorm = chunk.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                        let score = 0;
                        for (const w of queryWords) {
                            if (chunkNorm.includes(w)) score++;
                        }
                        if (score > 0) allChunks.push({ text: chunk, score, doc: doc.nome });
                    }
                }

                // Se não encontrou por keyword, pega os primeiros chunks de cada doc como fallback
                if (allChunks.length === 0) {
                    for (const doc of docs) {
                        let parsed = [];
                        try { parsed = typeof doc.chunks === 'string' ? JSON.parse(doc.chunks) : (doc.chunks || []); } catch(e) {}
                        for (const chunk of parsed.slice(0, 3)) {
                            allChunks.push({ text: chunk, score: 0, doc: doc.nome });
                        }
                    }
                }

                // Ordena por score e pega top 6
                allChunks.sort((a, b) => b.score - a.score);
                const topChunks = allChunks.slice(0, 6);
                const contexto = topChunks.map((c, i) => `[Doc: ${c.doc}]\n${c.text}`).join('\n\n---\n\n');

                log(inst, 'info', `[Knowledge] Pergunta: "${question.substring(0,60)}" → ${topChunks.length} chunks selecionados`);

                // Envia para OpenAI
                const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        temperature: 0.3,
                        max_tokens: 800,
                        messages: [{
                            role: 'system',
                            content: `Você é um assistente interno de uma empresa. Responda a pergunta do atendente EXCLUSIVAMENTE com base nos documentos fornecidos abaixo. Se a informação não estiver nos documentos, diga claramente "Não encontrei essa informação nos documentos disponíveis." Sempre cite de qual documento veio a informação quando possível. Responda em português de forma clara e objetiva.

DOCUMENTOS DA BASE DE CONHECIMENTO:
${contexto}`
                        }, {
                            role: 'user',
                            content: question
                        }]
                    })
                });

                if (!aiRes.ok) throw new Error('OpenAI HTTP ' + aiRes.status);
                const aiData = await aiRes.json();
                const answer = aiData?.choices?.[0]?.message?.content?.trim() || 'Sem resposta.';

                log(inst, 'ok', `[Knowledge] ✅ Resposta gerada (${answer.length} chars)`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer, chunks_used: topChunks.length }));
            } catch(e) {
                log('knowledge', 'erro', `[Knowledge] Ask falhou: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Qualquer rota /api/* não tratada → 404 JSON (nunca serve HTML)
    if (req.url.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Rota não encontrada: ${req.method} ${req.url}` }));
        return;
    }

    // Serve arquivos estáticos do CRM
    let filePath = req.url.split('?')[0]; // remove query string
    if (filePath === '/' || filePath === '') filePath = '/index.html';

    const fullPath = path.join(__dirname, filePath);
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    fs2.readFile(fullPath, (err, data) => {
        if (err) {
            // Qualquer rota não encontrada → volta para index.html (SPA)
            fs2.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
                if (err2) {
                    res.writeHead(404);
                    res.end('index.html nao encontrado');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                });
                res.end(data2);
            });
            return;
        }
        // HTML e JS nunca ficam em cache — garante que atualizações chegam imediatamente
        const noCache = ['.html', '.js'].includes(ext);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': noCache
                ? 'no-cache, no-store, must-revalidate'
                : 'public, max-age=86400',
            ...(noCache ? { 'Pragma': 'no-cache', 'Expires': '0' } : {}),
        });
        res.end(data);
    });
});

// Upgradar conexões WebSocket
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost`);
    const inst = url.searchParams.get('inst') || url.pathname.replace('/ws/', '').replace('/ws','');
    if (!inst) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (!wsClients[inst]) wsClients[inst] = new Set();
        wsClients[inst].add(ws);
        log(inst, 'info', `📡 WS client conectado (total: ${wsClients[inst].size})`);

        ws.on('close', () => {
            wsClients[inst]?.delete(ws);
        });
        ws.on('error', () => {
            wsClients[inst]?.delete(ws);
        });

        // Envia confirmação de conexão
        ws.send(JSON.stringify({ type: 'connected', inst }));
    });
});

const wss = new WebSocket.Server({ noServer: true });

server.listen(PORT, async () => {
    console.log(`\n🤖 IA WORKER CRM - Rodando na porta ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/health\n`);

    // ── Inicializa SQLite (WASM) antes de qualquer outra coisa ───────────────
    await initDb();

    // ── AUTO-SEED: cria licença e config IA automaticamente pelas variáveis ──
    // Basta definir INSTANCE_NAME e LICENSE_KEY no EasyPanel — zero configuração manual.
    const autoInst  = process.env.INSTANCE_NAME;
    const autoKey   = process.env.LICENSE_KEY   || 'evocrm2024';
    const autoPlano = process.env.PLANO         || 'platinum';

    if (autoInst) {
        try {
            const { data: licExiste } = await db.from('licenses')
                .select('id').eq('instance_name', autoInst).single();

            if (!licExiste) {
                await db.from('licenses').insert({
                    instance_name: autoInst,
                    license_key:   autoKey,
                    plano:         autoPlano,
                    status:        'active',
                    features: JSON.stringify({
                        bot: true, disparo: true, agenda: true,
                        setores: true, ia_atendimento: true, audio_ia: true
                    })
                });
                console.log(`✅ [AutoSeed] Licença criada: ${autoInst} (${autoPlano})`);
            } else {
                console.log(`ℹ️  [AutoSeed] Licença já existe: ${autoInst}`);
            }
        } catch(e) {
            // Licença não existe ainda — cria
            await db.from('licenses').insert({
                instance_name: autoInst,
                license_key:   autoKey,
                plano:         autoPlano,
                status:        'active',
                features: JSON.stringify({
                    bot: true, disparo: true, agenda: true,
                    setores: true, ia_atendimento: true, audio_ia: true
                })
            }).catch(() => {});
            console.log(`✅ [AutoSeed] Licença criada: ${autoInst} (${autoPlano})`);
        }

        try {
            const { data: iaExiste } = await db.from('ia_config')
                .select('id').eq('instance_name', autoInst).single();

            if (!iaExiste) {
                await db.from('ia_config').insert({
                    instance_name: autoInst,
                    ativo:  false,
                    modelo: 'gpt-4o-mini',
                    prompt: ''
                });
                console.log(`✅ [AutoSeed] ia_config criada: ${autoInst}`);
            }
        } catch(e) {
            await db.from('ia_config').insert({
                instance_name: autoInst,
                ativo:  false,
                modelo: 'gpt-4o-mini',
                prompt: ''
            }).catch(() => {});
            console.log(`✅ [AutoSeed] ia_config criada: ${autoInst}`);
        }
    } else {
        console.warn('⚠️  [AutoSeed] INSTANCE_NAME não definido — configure no EasyPanel');
    }

    // Diagnóstico MP na inicialização
    getMpToken().then(t => {
        if (t) console.log(`✅ [MP] Access Token carregado: ${t.substring(0,20)}...`);
        else   console.error('❌ [MP] ERRO: Access Token NÃO encontrado!');
    });
    getMpPublicKey().then(k => {
        if (k) console.log(`✅ [MP] Public Key carregada: ${k.substring(0,20)}...`);
        else   console.error('❌ [MP] ERRO: Public Key NÃO encontrada!');
    });

    seedMpConfig().catch(e => console.error('[MP] Erro ao seed config:', e.message));

    // ── MIGRATION automática: preenche atendimento_inicio para leads existentes ─
    try {
        const { query } = require('./db.js');
        await query(`UPDATE leads SET atendimento_inicio = last_interaction WHERE atendimento_inicio IS NULL AND last_interaction IS NOT NULL`);
        console.log('✅ [Migration] atendimento_inicio preenchido nos leads existentes');
    } catch(e) {
        console.warn('[Migration] atendimento_inicio:', e.message);
    }

    setupGlobalDbListener(); // SQLite realtime — deve rodar antes de carregarInstancias
    carregarInstancias();

    // ── BACKUP AUTOMÁTICO: executa a cada 6 horas e ao iniciar ───────────────
    setTimeout(() => executarBackup().catch(e => console.error('[Backup] Erro inicial:', e.message)), 10000);
    setInterval(() => executarBackup().catch(e => console.error('[Backup] Erro periódico:', e.message)), 6 * 60 * 60 * 1000);
    console.log('💾 [Backup] Worker agendado (a cada 6h | primeiro em 10s)');
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGTERM', () => { console.log('Encerrando...'); process.exit(0); });
process.on('uncaughtException', err => console.error('Erro não tratado:', err));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err));
