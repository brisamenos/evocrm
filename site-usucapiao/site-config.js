// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO DO SITE + BIBLIOTECA DE VÍDEOS/IMAGENS
// ───────────────────────────────────────────────────────────────────────────────
// • Textos, vídeo, logo, WhatsApp flutuante, Pixel/Google e SEO editáveis no Admin.
//   Tudo fica no banco (DATA_DIR) — nunca dentro do código —, então o deploy não apaga nada.
// • Cada salvamento guarda uma versão (últimas 30) para desfazer, e há backup em arquivo.
// • Upload em partes de 8 MB: sem limite de tamanho, passa por proxy/Cloudflare e
//   continua de onde parou se a internet cair.
// • Qualquer formato de vídeo: o servidor converte para MP4 (H.264/AAC), que toca em
//   todo celular e navegador, e gera a imagem de capa sozinho.
// ═══════════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PADRAO = {
    seo_titulo: 'Usucapião: regularize seu imóvel | Levi Farias Advocacia',
    seo_descricao: 'Mora há anos no imóvel e não tem escritura? Fale com um advogado especialista em usucapião.',
    logo_midia: '', logo_alt: 'Levi Farias Advocacia',
    selo: 'Especialistas em Usucapião',
    titulo: 'Você mora há anos no imóvel, mas ele',
    titulo_destaque: 'ainda não é legalmente seu?',
    subtitulo: 'A usucapião pode transformar sua posse em propriedade com escritura e registro. Assista ao vídeo e entenda, em poucos minutos, se o seu caso se encaixa.',
    video_tipo: 'nenhum',        // nenhum | arquivo | link
    video_midia: '', video_link: '', video_capa_midia: '',
    video_auto_inicio: true,     // começa sozinho e mudo (regra dos navegadores); o visitante toca para ouvir
    video_aviso_som: 'Seu vídeo já começou', video_aviso_sub: 'Toque para ouvir',
    video_cta_final: true,       // ao terminar mostra o botão de falar com o advogado
    botao_topo: 'Fale com nosso advogado especialista',
    secao_selo: 'Por que nos escolher',
    secao_titulo: 'Técnica, ética e proximidade em cada caso',
    card1_titulo: 'Foco em Direito Imobiliário', card1_texto: 'Atuação dedicada a usucapião e regularização de imóveis — não somos generalistas.',
    card2_titulo: 'Análise documental completa', card2_texto: 'Avaliamos a sua posse, prazos e provas antes de qualquer passo, com total transparência.',
    card3_titulo: 'Atendimento próximo', card3_texto: 'Você fala diretamente com o advogado e acompanha cada etapa do seu processo.',
    card4_titulo: 'Judicial ou extrajudicial', card4_texto: 'Indicamos o caminho mais rápido e seguro: em cartório ou na Justiça.',
    form_selo: 'Análise do seu caso',
    form_titulo: 'Descubra se você tem', form_titulo_destaque: 'direito à usucapião',
    form_subtitulo: 'Preencha seus dados e nossa equipe entrará em contato para entender a sua situação.',
    form_item1: 'Atendimento com advogado especialista',
    form_item2: 'Orientação clara sobre prazos e documentos',
    form_item3: 'Seus dados tratados com sigilo',
    form_botao: 'Quero falar com o advogado',
    form_seguranca: 'Seus dados estão protegidos e não serão compartilhados.',
    sucesso_titulo: 'Recebemos seus dados, {nome}!',
    sucesso_texto: 'Em instantes você vai receber uma mensagem no seu WhatsApp. Fique de olho! 📲',
    rodape: '© {ano} Levi Farias Advocacia Imobiliária — Todos os direitos reservados.',
    whatsapp_numero: '', whatsapp_mensagem: 'Olá! Vim pelo site e quero saber sobre usucapião.',
    pixel_meta: '', google_tag: '',
};
const LIMITES = { video_aviso_som: 60, video_aviso_sub: 60, seo_descricao: 300, subtitulo: 600, form_subtitulo: 600, sucesso_texto: 400, whatsapp_mensagem: 500, video_link: 600 };
const CHUNK = 8 * 1024 * 1024;
const EXT_IMAGEM = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|heic)$/i;

module.exports = function criarSiteConfig({ DATA_DIR, todos, um, exec, cfg, setCfg, lerCorpo, json }) {
    const MIDIA_DIR = path.join(DATA_DIR, 'midia');
    const TMP_DIR = path.join(MIDIA_DIR, '_envio');
    fs.mkdirSync(TMP_DIR, { recursive: true });

    exec(`CREATE TABLE IF NOT EXISTS midias (
        id TEXT PRIMARY KEY, nome TEXT, tipo TEXT, tamanho INTEGER, recebido INTEGER DEFAULT 0,
        arquivo TEXT, capa TEXT, largura INTEGER, altura INTEGER, duracao REAL,
        status TEXT, progresso INTEGER DEFAULT 0, erro TEXT, chave TEXT, created_at TEXT, updated_at TEXT)`);
    try { exec('ALTER TABLE midias ADD COLUMN chave TEXT'); } catch (e) {}
    exec(`CREATE TABLE IF NOT EXISTS site_versoes (id INTEGER PRIMARY KEY AUTOINCREMENT, em TEXT, dados TEXT, nota TEXT)`);

    const agora = () => new Date().toISOString();
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ── ffmpeg ──────────────────────────────────────────────────────────────────
    const temBin = b => { try { return spawnSync(b, ['-version'], { stdio: 'ignore', timeout: 8000 }).status === 0; } catch (e) { return false; } };
    const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
    const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
    const temFfmpeg = temBin(FFMPEG) && temBin(FFPROBE);
    if (!temFfmpeg) console.warn('⚠️  ffmpeg não encontrado: vídeos MP4 funcionam, outros formatos não serão convertidos.');

    // ── persistência: a pasta de dados está num volume? ─────────────────────────
    function infoArmazenamento() {
        let persistente = null;
        try {
            const alvo = fs.realpathSync(DATA_DIR);
            const pontos = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(l => l.split(' ')[4]).filter(Boolean);
            const naRaiz = pontos.filter(p => p !== '/').some(p => alvo === p || alvo.startsWith(p.endsWith('/') ? p : p + '/'));
            persistente = naRaiz;
        } catch (e) { persistente = null; }
        if (process.env.IGNORAR_AVISO_VOLUME === '1') persistente = true;
        let livre = null;
        try { const st = fs.statfsSync(DATA_DIR); livre = Number(st.bavail) * Number(st.bsize); } catch (e) {}
        return { persistente, livre, pasta: DATA_DIR, ffmpeg: temFfmpeg };
    }
    const arm = infoArmazenamento();
    if (arm.persistente === false) console.warn(`⚠️  ${DATA_DIR} NÃO está num volume: inscrições, configurações e vídeos serão perdidos no próximo deploy. Monte um volume nessa pasta.`);

    // ── configuração ────────────────────────────────────────────────────────────
    function lerSite() {
        let salvo = {};
        try { salvo = JSON.parse(cfg('site') || '{}'); } catch (e) { salvo = {}; }
        return { ...PADRAO, ...salvo };
    }
    function sanitizar(entrada) {
        const out = {};
        for (const k of Object.keys(PADRAO)) {
            if (!(k in entrada)) continue;
            const v = entrada[k];
            if (typeof PADRAO[k] === 'boolean') { out[k] = !!v; continue; }
            out[k] = String(v ?? '').replace(/\u0000/g, '').trim().slice(0, LIMITES[k] || 250);
        }
        if ('video_tipo' in out && !['nenhum', 'arquivo', 'link'].includes(out.video_tipo)) out.video_tipo = 'nenhum';
        if ('whatsapp_numero' in out) out.whatsapp_numero = out.whatsapp_numero.replace(/\D/g, '').slice(0, 15);
        if ('pixel_meta' in out) out.pixel_meta = out.pixel_meta.replace(/\D/g, '').slice(0, 20);
        if ('google_tag' in out) { const g = out.google_tag.toUpperCase().replace(/\s/g, ''); out.google_tag = /^(G|AW|GT|UA)-[A-Z0-9-]{4,30}$/.test(g) ? g : ''; }
        if ('video_link' in out && out.video_link && !/^https:\/\//i.test(out.video_link)) out.video_link = '';
        return out;
    }
    function salvarSite(novo, nota) {
        const atual = lerSite();
        const final = { ...atual, ...sanitizar(novo) };
        setCfg('site', JSON.stringify(final));
        exec('INSERT INTO site_versoes (em, dados, nota) VALUES (?, ?, ?)', [agora(), JSON.stringify(final), String(nota || 'Alteração salva').slice(0, 120)]);
        exec('DELETE FROM site_versoes WHERE id NOT IN (SELECT id FROM site_versoes ORDER BY id DESC LIMIT 30)');
        return final;
    }

    // ── mídias ──────────────────────────────────────────────────────────────────
    const midia = id => (id ? um('SELECT * FROM midias WHERE id = ?', [id]) : null);
    const urlMidia = m => (m && m.arquivo ? `/midia/${m.arquivo}` : '');
    const urlCapa = m => (m && m.capa ? `/midia/${m.capa}` : '');

    function sondar(arquivo) {
        return new Promise(resolve => {
            const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', arquivo]);
            let out = '';
            p.stdout.on('data', d => { out += d; });
            p.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
            p.on('error', () => resolve(null));
        });
    }
    function rodarFfmpeg(args, duracao, aoProgresso) {
        return new Promise((resolve, reject) => {
            const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-progress', 'pipe:1', '-nostats'].filter(Boolean));
            let erro = '';
            p.stderr.on('data', d => { erro = (erro + d).slice(-2000); });
            p.stdout.on('data', d => {
                const m = String(d).match(/out_time_ms=(\d+)/g);
                if (m && duracao && aoProgresso) aoProgresso(Math.min(99, Math.round(parseInt(m[m.length - 1].split('=')[1]) / 1e6 / duracao * 100)));
            });
            p.on('error', e => reject(e));
            p.on('close', c => (c === 0 ? resolve() : reject(new Error(erro.trim().split('\n').pop() || `ffmpeg saiu com código ${c}`))));
        });
    }

    let processando = false;
    async function processarFila() {
        if (processando) return;
        processando = true;
        try {
            let m;
            while ((m = um(`SELECT * FROM midias WHERE status = 'processando' ORDER BY created_at ASC LIMIT 1`))) await processar(m);
        } finally { processando = false; }
    }

    async function processar(m) {
        const origem = path.join(TMP_DIR, m.id);
        const atualizar = (campos) => {
            const ks = Object.keys(campos);
            exec(`UPDATE midias SET ${ks.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [...ks.map(k => campos[k]), agora(), m.id]);
        };
        try {
            if (!fs.existsSync(origem)) throw new Error('Arquivo enviado não encontrado no servidor. Envie de novo.');
            const ext = (path.extname(m.nome || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');

            // Imagem: guarda como veio
            if (m.tipo === 'imagem') {
                const destino = `${m.id}${ext}`;
                fs.renameSync(origem, path.join(MIDIA_DIR, destino));
                atualizar({ status: 'pronto', progresso: 100, arquivo: destino, capa: destino });
                return;
            }

            if (!temFfmpeg) {
                // Sem ffmpeg: só aceita o que o navegador já toca
                if (!/\.(mp4|m4v|webm)$/i.test(ext)) throw new Error('Este servidor não tem ffmpeg para converter o vídeo. Envie em MP4 ou instale o ffmpeg (já incluso no Dockerfile).');
                const destino = `${m.id}${ext}`;
                fs.renameSync(origem, path.join(MIDIA_DIR, destino));
                atualizar({ status: 'pronto', progresso: 100, arquivo: destino });
                return;
            }

            const info = await sondar(origem);
            const v = info?.streams?.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
            if (!v) throw new Error('Não encontrei imagem de vídeo neste arquivo (é um áudio ou o arquivo está corrompido).');
            const a = info.streams.find(s => s.codec_type === 'audio');
            const duracao = parseFloat(info.format?.duration || v.duration) || 0;
            const rot = Math.abs(parseInt(v.tags?.rotate || (v.side_data_list || []).find(x => x.rotation !== undefined)?.rotation || 0)) % 180 === 90;
            let largura = rot ? v.height : v.width, altura = rot ? v.width : v.height;
            const formato = String(info.format?.format_name || '');
            const destino = `${m.id}.mp4`;
            const saida = path.join(MIDIA_DIR, destino + '.parcial');

            // Já está no formato universal (H.264 + AAC/MP3 em MP4/MOV, 8 bits)? Só reorganiza para começar a tocar rápido.
            const compativel = v.codec_name === 'h264' && /mp4|mov|m4a/.test(formato) && (!a || ['aac', 'mp3'].includes(a.codec_name))
                && (!v.pix_fmt || v.pix_fmt === 'yuv420p') && largura <= 1920 && altura <= 1920;
            atualizar({ progresso: 1, duracao, largura, altura });
            if (compativel) {
                await rodarFfmpeg(['-i', origem, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', saida], duracao, p => atualizar({ progresso: p }));
            } else {
                // Limita a 1080p (lado maior 1920) sem distorcer; veryfast = rápido sem perder qualidade visível
                const escala = "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'";
                await rodarFfmpeg(['-i', origem, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `${escala},format=yuv420p`,
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1',
                    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', saida], duracao, p => atualizar({ progresso: p }));
            }
            fs.renameSync(saida, path.join(MIDIA_DIR, destino));
            const infoFinal = await sondar(path.join(MIDIA_DIR, destino));
            const vf = infoFinal?.streams?.find(s => s.codec_type === 'video');
            if (vf) { largura = vf.width; altura = vf.height; }

            // Capa automática (um quadro de ~1/3 do vídeo, no máximo aos 3 s)
            const capa = `${m.id}_capa.jpg`;
            try {
                await rodarFfmpeg(['-ss', String(Math.min(3, Math.max(0, duracao / 3))), '-i', path.join(MIDIA_DIR, destino), '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', path.join(MIDIA_DIR, capa)], 0);
            } catch (e) { /* sem capa não é erro */ }
            try { fs.unlinkSync(origem); } catch (e) {}
            atualizar({ status: 'pronto', progresso: 100, arquivo: destino, capa: fs.existsSync(path.join(MIDIA_DIR, capa)) ? capa : null, largura, altura, erro: null });
            console.log(`[vídeo] pronto: ${m.nome} (${largura}x${altura}, ${Math.round(duracao)} s)`);
        } catch (e) {
            console.error(`[vídeo] erro em ${m.nome}:`, e.message);
            try { fs.unlinkSync(path.join(MIDIA_DIR, `${m.id}.mp4.parcial`)); } catch (x) {}
            atualizar({ status: 'erro', erro: String(e.message).slice(0, 400) });
        }
    }

    // Ao ligar: envios abandonados há mais de 3 dias são limpos; conversões interrompidas recomeçam
    function arrumarAoIniciar() {
        const limite = new Date(Date.now() - 3 * 86400000).toISOString();
        for (const m of todos(`SELECT id FROM midias WHERE status = 'enviando' AND updated_at < ?`, [limite])) {
            try { fs.unlinkSync(path.join(TMP_DIR, m.id)); } catch (e) {}
            exec('DELETE FROM midias WHERE id = ?', [m.id]);
        }
        for (const f of fs.readdirSync(MIDIA_DIR)) if (f.endsWith('.parcial')) { try { fs.unlinkSync(path.join(MIDIA_DIR, f)); } catch (e) {} }
        setTimeout(() => processarFila().catch(() => {}), 2000);
    }
    arrumarAoIniciar();

    // ── página ──────────────────────────────────────────────────────────────────
    // O arquivo da página pode ter qualquer nome (usucapiao.html, index.html...).
    // Prioridade: PAGINA_ARQUIVO no ambiente → usucapiao.html → index.html → template.html → outro .html da pasta.
    let tpl = null, tplMtime = 0, TEMPLATE = null;
    function acharModelo() {
        const nomes = [process.env.PAGINA_ARQUIVO, 'usucapiao.html', 'index.html', 'template.html'].filter(Boolean);
        for (const n of nomes) { const f = path.join(__dirname, path.basename(n)); if (fs.existsSync(f)) return f; }
        const outro = fs.readdirSync(__dirname).find(f => f.toLowerCase().endsWith('.html') && f.toLowerCase() !== 'admin.html');
        return outro ? path.join(__dirname, outro) : null;
    }
    function lerTemplate() {
        TEMPLATE = acharModelo();
        if (!TEMPLATE) throw new Error('Arquivo da página não encontrado: coloque o usucapiao.html na pasta do projeto');
        const st = fs.statSync(TEMPLATE);
        if (!tpl || st.mtimeMs !== tplMtime || TEMPLATE !== lerTemplate._ult) { tpl = fs.readFileSync(TEMPLATE, 'utf8'); tplMtime = st.mtimeMs; lerTemplate._ult = TEMPLATE; }
        return tpl;
    }
    // ===== Player de vídeo do site =====
    // Navegadores só deixam um vídeo começar sozinho se estiver MUDO. Por isso o vídeo começa mudo,
    // em repetição, com o aviso "Seu vídeo já começou — toque para ouvir". Ao tocar, ele volta pro início com som.
    const IC = {
        play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/></svg>',
        pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>',
        som: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>',
        mudo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>',
        tela: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        sair: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
        denovo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
        seta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    };

    const CSS_PLAYER = `<style>
.vp{position:relative;overflow:hidden;margin:0 auto;border-radius:14px;background:#000;isolation:isolate;
 box-shadow:0 0 0 1px color-mix(in oklab,var(--primary) 45%,transparent),0 30px 80px -20px rgba(0,0,0,.85),0 0 60px -10px color-mix(in oklab,var(--primary) 35%,transparent);
 -webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;outline:none;font-family:inherit}
.vp:focus-visible{box-shadow:0 0 0 2px var(--primary),0 30px 80px -20px rgba(0,0,0,.85)}
.vp video,.vp iframe{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;border:0}
.vp button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer}
.vp svg{width:100%;height:100%;display:block}
.vp-cam{position:absolute;inset:0;z-index:1}
/* aviso de som */
.vp-som{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,rgba(0,0,0,.15),rgba(0,0,0,.55));transition:opacity .35s}
.vp-som-card{display:flex;flex-direction:column;align-items:center;gap:12px;padding:22px 30px 20px;border-radius:16px;background:rgba(10,9,8,.72);
 backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid color-mix(in oklab,var(--primary) 55%,transparent);box-shadow:0 18px 50px rgba(0,0,0,.6);
 transform:translateY(0);animation:vpFlutua 3s ease-in-out infinite;max-width:86%}
.vp-som-ic{width:62px;height:62px;border-radius:50%;padding:16px;background:var(--gradient-gold);color:#17130c;position:relative}
.vp-som-ic::before,.vp-som-ic::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--primary);animation:vpOnda 1.8s ease-out infinite}
.vp-som-ic::after{animation-delay:.9s}
.vp-som-t{font-family:"Libre Baskerville",Georgia,serif;font-size:clamp(15px,2.6vw,20px);color:#fff;text-align:center;line-height:1.25}
.vp-som-s{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--primary);font-weight:600}
/* play grande */
.vp-grande{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.45));transition:opacity .3s}
.vp-grande span{width:clamp(66px,12vw,92px);height:clamp(66px,12vw,92px);border-radius:50%;padding:clamp(20px,3.6vw,28px);padding-left:clamp(24px,4.2vw,32px);
 background:var(--gradient-gold);color:#17130c;box-shadow:0 10px 40px color-mix(in oklab,var(--primary) 55%,transparent);transition:transform .25s;position:relative}
.vp-grande span::before{content:"";position:absolute;inset:-8px;border-radius:50%;border:2px solid color-mix(in oklab,var(--primary) 70%,transparent);animation:vpOnda 2s ease-out infinite}
.vp-grande:hover span{transform:scale(1.07)}
/* carregando */
.vp-spin{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;z-index:3;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:var(--primary);
 animation:vpGira .8s linear infinite;opacity:0;pointer-events:none;transition:opacity .2s}
.vp.carregando .vp-spin{opacity:1}
/* ícone que pisca no centro ao pausar/tocar */
.vp-flash{position:absolute;left:50%;top:50%;width:70px;height:70px;margin:-35px 0 0 -35px;padding:20px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;z-index:3;opacity:0;pointer-events:none}
.vp-flash.on{animation:vpFlash .55s ease-out}
/* barra de controles */
.vp-bar{position:absolute;left:0;right:0;bottom:0;z-index:5;padding:28px 14px 10px;background:linear-gradient(0deg,rgba(0,0,0,.85),rgba(0,0,0,.45) 55%,transparent);
 color:#fff;transition:opacity .3s,transform .3s;opacity:0;transform:translateY(8px);pointer-events:none}
.vp.com-som.ativo .vp-bar,.vp.com-som.pausado .vp-bar{opacity:1;transform:none;pointer-events:auto}
.vp.com-som:not(.ativo):not(.pausado){cursor:none}
.vp-prog{position:relative;height:18px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.vp-trilho{position:relative;width:100%;height:4px;border-radius:4px;background:rgba(255,255,255,.22);transition:height .15s}
.vp-prog:hover .vp-trilho,.vp-prog.arrastando .vp-trilho{height:6px}
.vp-buf,.vp-feito{position:absolute;left:0;top:0;bottom:0;border-radius:4px;width:0}
.vp-buf{background:rgba(255,255,255,.3)}
.vp-feito{background:var(--gradient-gold)}
.vp-bola{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#fff;box-shadow:0 0 0 4px color-mix(in oklab,var(--primary) 45%,transparent);left:0;transform:scale(0);transition:transform .15s}
.vp-prog:hover .vp-bola,.vp-prog.arrastando .vp-bola{transform:scale(1)}
.vp-dica{position:absolute;bottom:22px;padding:3px 7px;border-radius:5px;background:rgba(0,0,0,.8);font-size:12px;font-variant-numeric:tabular-nums;transform:translateX(-50%);opacity:0;pointer-events:none;transition:opacity .15s}
.vp-prog:hover .vp-dica,.vp-prog.arrastando .vp-dica{opacity:1}
.vp-ctrl{display:flex;align-items:center;gap:6px;margin-top:4px}
.vp-b{width:38px;height:38px;padding:8px;border-radius:50%;flex:none;transition:background .15s,color .15s}
.vp-b:hover{background:rgba(255,255,255,.12);color:var(--primary)}
.vp-tempo{font-size:13px;font-variant-numeric:tabular-nums;opacity:.9;margin-left:4px;white-space:nowrap}
.vp-esp{flex:1}
.vp-vel{min-width:44px;height:28px;padding:0 9px;border-radius:14px;font-size:12px;font-weight:700;border:1px solid rgba(255,255,255,.3)!important;transition:all .15s}
.vp-vel:hover{border-color:var(--primary)!important;color:var(--primary)}
.vp-vol{width:0;opacity:0;transition:width .2s,opacity .2s;accent-color:var(--primary);height:4px;cursor:pointer}
.vp-volw:hover .vp-vol,.vp-vol:focus{width:70px;opacity:1}
.vp-volw{display:flex;align-items:center}
@media (hover:none){.vp-volw .vp-vol{display:none}}
@media (max-width:480px){.vp-tempo .vp-tot-sep,.vp-tempo .vp-tot{display:none}.vp-bar{padding:22px 8px 6px}.vp-b{width:36px;height:36px}}
/* tela final */
.vp-fim{position:absolute;inset:0;z-index:6;display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;text-align:center;
 background:radial-gradient(ellipse at center,rgba(20,16,10,.82),rgba(0,0,0,.94));animation:vpSobe .4s ease-out}
.vp.fim .vp-fim{display:flex}
.vp-fim-t{font-family:"Libre Baskerville",Georgia,serif;color:#fff;font-size:clamp(17px,3vw,26px);line-height:1.25;max-width:520px}
.vp-fim-cta{display:inline-flex;align-items:center;gap:10px;padding:14px 26px;border-radius:4px;background:var(--gradient-gold);color:#17130c;font-weight:700;font-size:13px;
 letter-spacing:.12em;text-transform:uppercase;text-decoration:none;box-shadow:0 10px 30px color-mix(in oklab,var(--primary) 45%,transparent);transition:transform .2s}
.vp-fim-cta:hover{transform:translateY(-2px)}
.vp-fim-cta i{width:16px;height:16px;display:inline-block}
.vp-fim-de{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.75)!important}
.vp-fim-de i{width:16px;height:16px;display:inline-block}
.vp-fim-de:hover{color:var(--primary)!important}
.vp.fim .vp-bar,.vp.fim .vp-grande{display:none}
.vp .esconde{opacity:0!important;pointer-events:none!important}
.vp:fullscreen{border-radius:0;width:100%!important;height:100%!important;aspect-ratio:auto!important}
.vp:-webkit-full-screen{border-radius:0;width:100%!important;height:100%!important;aspect-ratio:auto!important}
@keyframes vpOnda{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.7);opacity:0}}
@keyframes vpFlutua{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes vpGira{to{transform:rotate(360deg)}}
@keyframes vpFlash{0%{opacity:.9;transform:scale(.7)}100%{opacity:0;transform:scale(1.35)}}
@keyframes vpSobe{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.vp *{animation:none!important}}
</style>`;

    const JS_PLAYER = `<script>(function(){
function fmt(t){t=Math.max(0,Math.floor(t||0));var h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=t%60;return(h?h+':'+(m<10?'0':''):'')+m+':'+(s<10?'0':'')+s}
function ev(n,p){try{if(window.fbq)fbq('trackCustom',n,p||{});if(window.gtag)gtag('event',n==='AssistiuVideo'?'video_start':'video_progress',p||{})}catch(e){}}
document.querySelectorAll('.vp[data-player="arquivo"]').forEach(function(c){
 var v=c.querySelector('video'),q=function(s){return c.querySelector(s)};
 var som=q('.vp-som'),grande=q('.vp-grande'),bar=q('.vp-bar'),prog=q('.vp-prog'),feito=q('.vp-feito'),buf=q('.vp-buf'),bola=q('.vp-bola'),dica=q('.vp-dica'),
  bPlay=q('.vp-bplay'),bSom=q('.vp-bsom'),vol=q('.vp-vol'),bVel=q('.vp-vel'),bTela=q('.vp-btela'),tAt=q('.vp-at'),tTot=q('.vp-tot'),flash=q('.vp-flash'),cam=q('.vp-cam');
 var IC=JSON.parse(c.getAttribute('data-ic'));
 var auto=c.getAttribute('data-auto')==='1',cta=c.getAttribute('data-cta')==='1',comSom=false,inicio=false,marcos={},timer=null,velocidades=[1,1.25,1.5,2],vi=0;
 function mostra(el,s){if(el)el.classList.toggle('esconde',!s)}
 function estado(){var p=v.paused;c.classList.toggle('pausado',p&&comSom);bPlay.innerHTML=p?IC.play:IC.pause;bPlay.setAttribute('aria-label',p?'Reproduzir':'Pausar');
  bSom.innerHTML=(v.muted||v.volume===0)?IC.mudo:IC.som}
 function acorda(){c.classList.add('ativo');clearTimeout(timer);timer=setTimeout(function(){if(!v.paused)c.classList.remove('ativo')},2600)}
 function pisca(ic){flash.innerHTML=ic;flash.classList.remove('on');void flash.offsetWidth;flash.classList.add('on')}
 function tocar(){var p=v.play();if(p&&p.catch)p.catch(function(){c.classList.remove('carregando');if(!comSom){mostra(som,false);mostra(grande,true)}estado()})}
 function ligarSom(){comSom=true;c.classList.add('com-som');c.classList.remove('fim');v.loop=false;v.muted=false;if(v.volume===0)v.volume=1;
  try{v.currentTime=0}catch(e){}mostra(som,false);mostra(grande,false);tocar();acorda();
  if(!inicio){inicio=true;ev('AssistiuVideo')}}
 function alterna(){if(!comSom){ligarSom();return}if(c.classList.contains('fim'))return;if(v.paused){tocar();pisca(IC.play)}else{v.pause();pisca(IC.pause)}acorda()}
 if(som)som.addEventListener('click',function(e){e.stopPropagation();ligarSom()});
 grande.addEventListener('click',function(e){e.stopPropagation();ligarSom()});
 var ultToque=0;
 cam.addEventListener('pointerup',function(e){
  if(!comSom){ligarSom();return}
  if(e.pointerType!=='mouse'){if(!c.classList.contains('ativo')&&!v.paused){acorda();return}alterna();return}
  var agora=Date.now();if(agora-ultToque<300){ultToque=0;telaCheia();return}ultToque=agora;
  setTimeout(function(){if(ultToque===agora)alterna()},220)});
 bPlay.addEventListener('click',function(e){e.stopPropagation();alterna()});
 bSom.addEventListener('click',function(e){e.stopPropagation();v.muted=!v.muted;if(!v.muted&&v.volume===0)v.volume=1;estado();acorda()});
 if(vol){vol.addEventListener('input',function(){v.volume=+vol.value;v.muted=v.volume===0;estado();acorda()})}
 bVel.addEventListener('click',function(e){e.stopPropagation();vi=(vi+1)%velocidades.length;v.playbackRate=velocidades[vi];bVel.textContent=velocidades[vi]+'x';acorda()});
 function emTela(){return document.fullscreenElement===c||document.webkitFullscreenElement===c}
 function telaCheia(){try{if(emTela()){(document.exitFullscreen||document.webkitExitFullscreen).call(document)}
  else if(c.requestFullscreen)c.requestFullscreen();else if(c.webkitRequestFullscreen)c.webkitRequestFullscreen();else if(v.webkitEnterFullscreen)v.webkitEnterFullscreen()}catch(e){}}
 bTela.addEventListener('click',function(e){e.stopPropagation();telaCheia()});
 function aoTela(){bTela.innerHTML=emTela()?IC.sair:IC.tela}
 document.addEventListener('fullscreenchange',aoTela);document.addEventListener('webkitfullscreenchange',aoTela);
 // barra de progresso (clicar e arrastar)
 var arr=false;
 function pos(e){var r=prog.getBoundingClientRect();return Math.min(1,Math.max(0,(e.clientX-r.left)/r.width))}
 function pinta(f){feito.style.width=(f*100)+'%';bola.style.left=(f*100)+'%'}
 prog.addEventListener('pointerdown',function(e){if(!v.duration)return;e.stopPropagation();arr=true;prog.classList.add('arrastando');try{prog.setPointerCapture(e.pointerId)}catch(x){}var f=pos(e);pinta(f);v.currentTime=f*v.duration;acorda()});
 prog.addEventListener('pointermove',function(e){var f=pos(e);if(v.duration){dica.textContent=fmt(f*v.duration);dica.style.left=(f*100)+'%'}if(arr){pinta(f);v.currentTime=f*v.duration;acorda()}});
 function solta(){arr=false;prog.classList.remove('arrastando')}
 prog.addEventListener('pointerup',function(e){e.stopPropagation();solta()});prog.addEventListener('pointercancel',solta);
 bar.addEventListener('pointerup',function(e){e.stopPropagation()});
 bar.addEventListener('pointermove',acorda);
 c.addEventListener('pointermove',function(e){if(e.pointerType==='mouse'&&comSom)acorda()});
 c.addEventListener('mouseleave',function(){if(!v.paused)c.classList.remove('ativo')});
 // eventos do vídeo
 v.addEventListener('timeupdate',function(){if(!v.duration)return;var f=v.currentTime/v.duration;if(!arr)pinta(f);tAt.textContent=fmt(v.currentTime);if(tTot.textContent==='0:00')tTot.textContent=fmt(v.duration);
  if(comSom)[25,50,75].forEach(function(p){if(f*100>=p&&!marcos[p]){marcos[p]=1;ev('VideoProgresso',{percent:p})}})});
 v.addEventListener('progress',function(){try{if(v.duration&&v.buffered.length)buf.style.width=(v.buffered.end(v.buffered.length-1)/v.duration*100)+'%'}catch(e){}});
 v.addEventListener('loadedmetadata',function(){tTot.textContent=fmt(v.duration)});
 v.addEventListener('durationchange',function(){tTot.textContent=fmt(v.duration)});
 v.addEventListener('waiting',function(){c.classList.add('carregando')});
 ['playing','canplay','pause','seeked'].forEach(function(n){v.addEventListener(n,function(){c.classList.remove('carregando')})});
 v.addEventListener('play',estado);v.addEventListener('pause',function(){estado();c.classList.add('ativo')});v.addEventListener('volumechange',function(){estado();if(vol)vol.value=v.muted?0:v.volume});
 v.addEventListener('ended',function(){if(!comSom)return;if(!marcos[100]){marcos[100]=1;ev('VideoProgresso',{percent:100})}
  if(cta){c.classList.add('fim');try{if(emTela())(document.exitFullscreen||document.webkitExitFullscreen).call(document)}catch(e){}}else estado()});
 var de=q('.vp-fim-de');if(de)de.addEventListener('click',function(e){e.stopPropagation();c.classList.remove('fim');try{v.currentTime=0}catch(x){}tocar()});
 var ir=q('.vp-fim-cta');if(ir)ir.addEventListener('click',function(){try{if(window.fbq)fbq('trackCustom','CliqueVideoCTA')}catch(e){}});
 // teclado
 c.addEventListener('keydown',function(e){var k=e.key;if(k===' '||k==='k'||k==='K'){e.preventDefault();alterna()}else if(k==='m'||k==='M'){if(!comSom)ligarSom();else bSom.click()}
  else if(k==='f'||k==='F'){telaCheia()}else if(k==='ArrowRight'){v.currentTime=Math.min(v.duration||0,v.currentTime+5);acorda()}else if(k==='ArrowLeft'){v.currentTime=Math.max(0,v.currentTime-5);acorda()}});
 // pré-visualização muda pausa quando sai da tela (economiza internet do visitante)
 if(auto&&'IntersectionObserver'in window){new IntersectionObserver(function(es){es.forEach(function(x){if(comSom)return;if(x.isIntersecting)tocar();else v.pause()})},{threshold:.25}).observe(c)}
 if(auto){mostra(grande,false);c.classList.add('carregando');tocar()}else{mostra(som,false)}
 if(v.readyState>=1&&v.duration)tTot.textContent=fmt(v.duration);
 estado();
});
document.querySelectorAll('.vp[data-player="embed"]').forEach(function(c){
 var f=c.querySelector('iframe'),b=c.querySelector('.vp-som'),tipo=c.getAttribute('data-tipo');if(!b||!f)return;
 function manda(o){try{f.contentWindow.postMessage(JSON.stringify(o),'*')}catch(e){}}
 b.addEventListener('click',function(){
  if(tipo==='youtube'){manda({event:'command',func:'seekTo',args:[0,true]});manda({event:'command',func:'unMute',args:[]});manda({event:'command',func:'setVolume',args:[100]});manda({event:'command',func:'playVideo',args:[]})}
  else{manda({method:'setCurrentTime',value:0});manda({method:'setMuted',value:false});manda({method:'setVolume',value:1});manda({method:'play'})}
  b.classList.add('esconde');setTimeout(function(){b.remove()},400);ev('AssistiuVideo')});
});
})();</script>`;

    function playerArquivo({ src, poster, auto, cta, estilo, s }) {
        const ic = esc(JSON.stringify(IC));
        return `${CSS_PLAYER}<div class="vp" data-player="arquivo" data-auto="${auto ? 1 : 0}" data-cta="${cta ? 1 : 0}" data-ic="${ic}" tabindex="0" style="${estilo}">
<video src="${esc(src)}"${poster ? ` poster="${esc(poster)}"` : ''} playsinline webkit-playsinline preload="${auto ? 'auto' : 'metadata'}"${auto ? ' autoplay muted loop' : ''} disablepictureinpicture controlslist="nodownload"></video>
<div class="vp-cam"></div><div class="vp-spin"></div><div class="vp-flash"></div>
<button type="button" class="vp-som" aria-label="Ativar o som do vídeo"><span class="vp-som-card"><span class="vp-som-ic">${IC.mudo}</span><span class="vp-som-t">${esc(s.video_aviso_som || 'Seu vídeo já começou')}</span><span class="vp-som-s">${esc(s.video_aviso_sub || 'Toque para ouvir')}</span></span></button>
<button type="button" class="vp-grande" aria-label="Assistir ao vídeo"><span>${IC.play}</span></button>
<div class="vp-fim"><div class="vp-fim-t">Ficou com alguma dúvida sobre o seu caso?</div>
<a class="vp-fim-cta" href="#contato">${esc(s.botao_topo || 'Fale com o advogado')}<i>${IC.seta}</i></a>
<button type="button" class="vp-fim-de"><i>${IC.denovo}</i>Assistir de novo</button></div>
<div class="vp-bar"><div class="vp-prog"><div class="vp-trilho"><div class="vp-buf"></div><div class="vp-feito"></div><div class="vp-bola"></div></div><div class="vp-dica">0:00</div></div>
<div class="vp-ctrl"><button type="button" class="vp-b vp-bplay" aria-label="Reproduzir">${IC.play}</button>
<span class="vp-volw"><button type="button" class="vp-b vp-bsom" aria-label="Som">${IC.som}</button><input class="vp-vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume"></span>
<span class="vp-tempo"><span class="vp-at">0:00</span><span class="vp-tot-sep"> / </span><span class="vp-tot">0:00</span></span>
<span class="vp-esp"></span><button type="button" class="vp-vel" aria-label="Velocidade">1x</button>
<button type="button" class="vp-b vp-btela" aria-label="Tela cheia">${IC.tela}</button></div></div>
</div>${JS_PLAYER}`;
    }

    function blocoVideo(s) {
        const auto = s.video_auto_inicio !== false;
        const cta = s.video_cta_final !== false;
        if (s.video_tipo === 'link' && s.video_link) {
            const u = s.video_link;
            let emb = null, tipo = '';
            let mm = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i);
            if (mm) { tipo = 'youtube'; emb = `https://www.youtube-nocookie.com/embed/${mm[1]}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1${auto ? `&autoplay=1&mute=1&loop=1&playlist=${mm[1]}` : ''}`; }
            if (!emb && (mm = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) { tipo = 'vimeo'; emb = `https://player.vimeo.com/video/${mm[1]}?playsinline=1&title=0&byline=0&portrait=0${auto ? '&autoplay=1&muted=1&loop=1' : ''}`; }
            if (emb) {
                const vertical = /shorts\//i.test(u);
                const estilo = vertical ? 'aspect-ratio:9/16;width:min(100%,calc(78vh*9/16))' : 'aspect-ratio:16/9';
                return `${CSS_PLAYER}<div class="vp" data-player="embed" data-tipo="${tipo}" style="${estilo}">
<iframe src="${esc(emb)}" title="Vídeo" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe>
${auto ? `<button type="button" class="vp-som" aria-label="Ativar o som do vídeo"><span class="vp-som-card"><span class="vp-som-ic">${IC.mudo}</span><span class="vp-som-t">${esc(s.video_aviso_som || 'Seu vídeo já começou')}</span><span class="vp-som-s">${esc(s.video_aviso_sub || 'Toque para ouvir')}</span></span></button>` : ''}
</div>${JS_PLAYER}`;
            }
            // link direto para um arquivo de vídeo (.mp4 etc.)
            return playerArquivo({ src: u, poster: '', auto, cta, estilo: 'aspect-ratio:16/9', s });
        }
        if (s.video_tipo === 'arquivo') {
            const m = midia(s.video_midia);
            if (!m || m.status !== 'pronto' || m.tipo !== 'video') return '';
            const capaM = midia(s.video_capa_midia);
            const capa = capaM && capaM.status === 'pronto' ? urlMidia(capaM) : urlCapa(m);
            const w = m.largura || 16, h = m.altura || 9;
            const estilo = h > w ? `aspect-ratio:${w}/${h};width:min(100%,calc(78vh*${w}/${h}))` : `aspect-ratio:${w}/${h}`;
            return playerArquivo({ src: urlMidia(m), poster: capa, auto, cta, estilo, s });
        }
        return '';
    }
    function rastreamento(s) {
        let h = '';
        if (s.pixel_meta) h += `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${s.pixel_meta}');fbq('track','PageView');</script>`;
        if (s.google_tag) h += `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(s.google_tag)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${esc(s.google_tag)}');</script>`;
        return h;
    }
    function botaoWhatsapp(s) {
        if (!s.whatsapp_numero || s.whatsapp_numero.length < 10) return '';
        const n = s.whatsapp_numero.length <= 11 ? '55' + s.whatsapp_numero : s.whatsapp_numero;
        const url = `https://wa.me/${n}${s.whatsapp_mensagem ? '?text=' + encodeURIComponent(s.whatsapp_mensagem) : ''}`;
        return `<a href="${esc(url)}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp" onclick="try{if(window.fbq)fbq('track','Contact');if(window.gtag)gtag('event','contact_whatsapp')}catch(e){}"
 style="position:fixed;right:18px;bottom:18px;z-index:60;width:58px;height:58px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(0,0,0,.35)">
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="#fff"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.2-.57-.35zM12.04 21.5h-.01a9.45 9.45 0 0 1-4.82-1.32l-.35-.21-3.58.94.96-3.49-.23-.36A9.43 9.43 0 0 1 2.58 12c0-5.22 4.25-9.46 9.47-9.46 2.53 0 4.9.99 6.69 2.78a9.4 9.4 0 0 1 2.77 6.69c0 5.22-4.25 9.47-9.47 9.47zm8.05-17.52A11.32 11.32 0 0 0 12.04.65C5.77.65.66 5.75.66 12.02c0 2 .52 3.96 1.52 5.69L.57 23.35l5.77-1.51a11.35 11.35 0 0 0 5.7 1.45h.01c6.27 0 11.37-5.1 11.37-11.37 0-3.04-1.18-5.89-3.33-8.04z"/></svg></a>`;
    }

    function renderizar(baseUrl) {
        const s = lerSite();
        const logo = midia(s.logo_midia);
        const vid = s.video_tipo === 'arquivo' ? midia(s.video_midia) : null;
        const capaM = midia(s.video_capa_midia);
        const imgOg = (capaM && capaM.status === 'pronto' && urlMidia(capaM)) || (vid && urlCapa(vid)) || '';
        const valores = {
            ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, esc(v)])),
            rodape: esc(String(s.rodape).replace(/\{ano\}/g, new Date().getFullYear())),
            logo_src: logo && logo.status === 'pronto' ? urlMidia(logo) : '/logo-padrao.png',
            video_bloco: blocoVideo(s),
            rastreamento: rastreamento(s),
            whatsapp_flutuante: botaoWhatsapp(s),
            og_imagem: imgOg ? `<meta property="og:image" content="${esc(baseUrl + imgOg)}">` : '',
            site_txt: `<script>window.SITE_TXT=${JSON.stringify({ sucesso_titulo: s.sucesso_titulo, sucesso_texto: s.sucesso_texto }).replace(/</g, '\\u003c')};</script>`,
        };
        return lerTemplate().replace(/\{\{(\w+)\}\}/g, (_, k) => (k in valores ? valores[k] : ''));
    }

    // ── servir arquivos de mídia (com Range: vídeo começa a tocar na hora e dá para avançar) ──
    function servirMidia(req, res, nome) {
        if (!/^[0-9a-f-]{36}(_capa)?\.[a-z0-9]{2,5}$/i.test(nome)) { res.writeHead(404); return res.end(); }
        const arq = path.join(MIDIA_DIR, nome);
        let st;
        try { st = fs.statSync(arq); } catch (e) { res.writeHead(404); return res.end(); }
        const tipos = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
            '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp' };
        const ct = tipos[path.extname(nome).toLowerCase()] || 'application/octet-stream';
        const base = { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
        if (ct === 'image/svg+xml') base['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
        const range = req.headers.range;
        if (range) {
            const m = range.match(/bytes=(\d*)-(\d*)/);
            let ini = m && m[1] ? parseInt(m[1]) : NaN, fim = m && m[2] ? parseInt(m[2]) : NaN;
            if (isNaN(ini)) { ini = st.size - (isNaN(fim) ? 0 : fim); fim = st.size - 1; }
            if (isNaN(fim) || fim >= st.size) fim = st.size - 1;
            if (ini < 0 || ini > fim) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
            res.writeHead(206, { ...base, 'Content-Range': `bytes ${ini}-${fim}/${st.size}`, 'Content-Length': fim - ini + 1 });
            if (req.method === 'HEAD') return res.end();
            return fs.createReadStream(arq, { start: ini, end: fim }).pipe(res);
        }
        res.writeHead(200, { ...base, 'Content-Length': st.size });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(arq).pipe(res);
    }

    // ── rotas do admin (já autenticadas) ────────────────────────────────────────
    const fmtMidia = m => ({ ...m, url: urlMidia(m), capa_url: urlCapa(m) });
    const travas = new Set();

    async function rotas(req, res, url) {
        const rota = url.pathname, metodo = req.method;

        if (rota === '/admin/api/site' && metodo === 'GET') {
            return json(res, 200, { ok: true, site: lerSite(), padrao: PADRAO, armazenamento: infoArmazenamento() }), true;
        }
        if (rota === '/admin/api/site' && metodo === 'POST') {
            const b = await lerCorpo(req, 256 * 1024);
            const s = salvarSite(b.site || {}, b.nota);
            return json(res, 200, { ok: true, site: s }), true;
        }
        if (rota === '/admin/api/site/versoes' && metodo === 'GET') {
            return json(res, 200, { ok: true, versoes: todos('SELECT id, em, nota FROM site_versoes ORDER BY id DESC LIMIT 30') }), true;
        }
        if (rota === '/admin/api/site/restaurar' && metodo === 'POST') {
            const b = await lerCorpo(req);
            const v = um('SELECT * FROM site_versoes WHERE id = ?', [parseInt(b.id) || 0]);
            if (!v) return json(res, 404, { ok: false, error: 'Versão não encontrada' }), true;
            const s = salvarSite(JSON.parse(v.dados), `Restaurada a versão de ${new Date(v.em).toLocaleString('pt-BR')}`);
            return json(res, 200, { ok: true, site: s }), true;
        }
        if (rota === '/admin/api/site/backup' && metodo === 'GET') {
            const corpo = JSON.stringify({ tipo: 'backup-site', versao: 1, exportado_em: agora(), site: lerSite() }, null, 2);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="backup-site-${agora().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
            res.end(corpo);
            return true;
        }
        if (rota === '/admin/api/site/importar' && metodo === 'POST') {
            const b = await lerCorpo(req, 512 * 1024);
            if (!b || b.tipo !== 'backup-site' || typeof b.site !== 'object') return json(res, 422, { ok: false, error: 'Arquivo de backup inválido' }), true;
            const s = salvarSite(b.site, `Importado do backup de ${b.exportado_em ? new Date(b.exportado_em).toLocaleString('pt-BR') : '?'}`);
            return json(res, 200, { ok: true, site: s }), true;
        }

        if (rota === '/admin/api/midias' && metodo === 'GET') {
            return json(res, 200, { ok: true, midias: todos(`SELECT * FROM midias WHERE status != 'enviando' OR updated_at > ? ORDER BY created_at DESC`, [new Date(Date.now() - 3 * 86400000).toISOString()]).map(fmtMidia), armazenamento: infoArmazenamento() }), true;
        }
        if (rota === '/admin/api/midia/iniciar' && metodo === 'POST') {
            const b = await lerCorpo(req);
            const tamanho = parseInt(b.tamanho);
            if (!(tamanho > 0)) return json(res, 422, { ok: false, error: 'Arquivo vazio' }), true;
            const nome = String(b.nome || 'arquivo').replace(/[\\/\u0000]/g, '_').slice(0, 200);
            const ehImagem = String(b.tipo || '').startsWith('image/') || EXT_IMAGEM.test(nome);
            const info = infoArmazenamento();
            if (info.livre !== null && tamanho * 2.2 + 200 * 1024 * 1024 > info.livre) {
                const gb = n => (n / 1073741824).toFixed(1) + ' GB';
                return json(res, 507, { ok: false, error: `Sem espaço no servidor: o arquivo tem ${gb(tamanho)} e há ${gb(info.livre)} livres (a conversão precisa de espaço extra).` }), true;
            }
            // Retomada: mesmo arquivo (nome + tamanho + chave) que ficou pela metade
            if (b.chave) {
                const ant = um(`SELECT * FROM midias WHERE status = 'enviando' AND nome = ? AND tamanho = ? AND chave = ?`, [nome, tamanho, String(b.chave).slice(0, 100)]);
                if (ant) {
                    let rec = 0; try { rec = fs.statSync(path.join(TMP_DIR, ant.id)).size; } catch (e) {}
                    exec('UPDATE midias SET recebido = ?, updated_at = ? WHERE id = ?', [rec, agora(), ant.id]);
                    return json(res, 200, { ok: true, id: ant.id, recebido: rec, parte: CHUNK, retomado: rec > 0 }), true;
                }
            }
            const id = crypto.randomUUID();
            fs.writeFileSync(path.join(TMP_DIR, id), '');
            exec(`INSERT INTO midias (id, nome, tipo, tamanho, recebido, status, progresso, chave, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'enviando', 0, ?, ?, ?)`,
                [id, nome, ehImagem ? 'imagem' : 'video', tamanho, b.chave ? String(b.chave).slice(0, 100) : null, agora(), agora()]);
            return json(res, 200, { ok: true, id, recebido: 0, parte: CHUNK }), true;
        }
        const mm = rota.match(/^\/admin\/api\/midia\/([0-9a-f-]{36})(\/parte|\/concluir)?$/);
        if (mm) {
            const id = mm[1];
            const m = midia(id);
            if (!m) return json(res, 404, { ok: false, error: 'Arquivo não encontrado (o envio expirou). Envie de novo.' }), true;
            const tmp = path.join(TMP_DIR, id);

            if (mm[2] === '/parte' && metodo === 'PUT') {
                if (m.status !== 'enviando') return json(res, 409, { ok: false, error: 'Este envio já terminou' }), true;
                if (travas.has(id)) return json(res, 409, { ok: false, error: 'Outra parte está sendo recebida' }), true;
                const offset = parseInt(url.searchParams.get('offset'));
                let atual = 0; try { atual = fs.statSync(tmp).size; } catch (e) {}
                if (offset !== atual) { req.resume(); return json(res, 409, { ok: false, recebido: atual, error: 'Posição diferente — continuando do ponto certo' }), true; }
                travas.add(id);
                try {
                    const recebidoAntes = atual;
                    await new Promise((resolve, reject) => {
                        const ws = fs.createWriteStream(tmp, { flags: 'a' });
                        let n = 0;
                        req.on('data', c => { n += c.length; if (n > CHUNK + 1024 || recebidoAntes + n > m.tamanho) { req.destroy(); ws.destroy(); reject(Object.assign(new Error('Parte maior que o esperado'), { status: 413 })); } });
                        req.on('aborted', () => { ws.destroy(); reject(new Error('Envio interrompido')); });
                        req.pipe(ws);
                        ws.on('finish', resolve);
                        ws.on('error', reject);
                    });
                } catch (e) {
                    // Parte incompleta: volta o arquivo para o fim da última parte inteira
                    try { fs.truncateSync(tmp, atual); } catch (x) {}
                    travas.delete(id);
                    if (!res.headersSent) json(res, e.status || 400, { ok: false, recebido: atual, error: e.message });
                    return true;
                }
                travas.delete(id);
                const rec = fs.statSync(tmp).size;
                exec('UPDATE midias SET recebido = ?, updated_at = ? WHERE id = ?', [rec, agora(), id]);
                return json(res, 200, { ok: true, recebido: rec }), true;
            }
            if (mm[2] === '/concluir' && metodo === 'POST') {
                let rec = 0; try { rec = fs.statSync(tmp).size; } catch (e) {}
                if (m.status !== 'enviando') return json(res, 200, { ok: true, midia: fmtMidia(m) }), true;
                if (rec !== m.tamanho) return json(res, 409, { ok: false, recebido: rec, error: `Faltam ${m.tamanho - rec} bytes` }), true;
                exec(`UPDATE midias SET status = 'processando', recebido = ?, progresso = 0, erro = NULL, updated_at = ? WHERE id = ?`, [rec, agora(), id]);
                setImmediate(() => processarFila().catch(() => {}));
                return json(res, 200, { ok: true, midia: fmtMidia(midia(id)) }), true;
            }
            if (!mm[2] && metodo === 'GET') return json(res, 200, { ok: true, midia: fmtMidia(m) }), true;
            if (!mm[2] && metodo === 'POST') {
                const b = await lerCorpo(req);
                if (b.reprocessar && m.status === 'erro' && fs.existsSync(tmp)) {
                    exec(`UPDATE midias SET status = 'processando', progresso = 0, erro = NULL, updated_at = ? WHERE id = ?`, [agora(), id]);
                    setImmediate(() => processarFila().catch(() => {}));
                }
                if (b.nome) exec('UPDATE midias SET nome = ?, updated_at = ? WHERE id = ?', [String(b.nome).slice(0, 200), agora(), id]);
                return json(res, 200, { ok: true }), true;
            }
            if (!mm[2] && metodo === 'DELETE') {
                const s = lerSite();
                const usos = ['video_midia', 'logo_midia', 'video_capa_midia'].filter(k => s[k] === id);
                if (usos.length && url.searchParams.get('forcar') !== '1') return json(res, 409, { ok: false, em_uso: usos, error: 'Este arquivo está em uso no site. Troque antes de excluir.' }), true;
                if (usos.length) salvarSite(Object.fromEntries(usos.map(k => [k, ''])), 'Arquivo excluído da biblioteca');
                for (const f of [m.arquivo, m.capa]) if (f) { try { fs.unlinkSync(path.join(MIDIA_DIR, f)); } catch (e) {} }
                try { fs.unlinkSync(tmp); } catch (e) {}
                exec('DELETE FROM midias WHERE id = ?', [id]);
                return json(res, 200, { ok: true }), true;
            }
        }
        return false;
    }

    return { renderizar, servirMidia, rotas, infoArmazenamento, lerSite, nomePagina: () => { const f = acharModelo(); return f ? path.basename(f) : null; } };
};
