// app-sons.js — Mixin extraído do app.js
function sonsMixin() {
    return {
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
    };
}
