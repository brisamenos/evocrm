// app-docs.js — Mixin extraído do app.js
function docsMixin() {
    return {
        // ── DOCUMENTOS DO LEAD ──
        docsPanelOpen: false,
        docsList: [],
        docsLoading: false,
        docsUploading: false,
        docsEditId: null,
        docsNotificar: true,

        downloadedMedia: JSON.parse(localStorage.getItem('evo_dl_media') || '[]'),
        downloadedMediaSet: new Set(),
        lightboxOpen: false,
        lightboxUrl: '',
        
        // CONTROLE DE ETIQUETAS (ORIGEM)
        isEtiquetaModalOpen: false,
        activeLeadForEtiqueta: null,
        novaEtiquetaInput: '',
        newTagColor: '#a855f7',
        dbTags: [],
        listaEtiquetasTemporaria: [],

        // ════════════════════════════════════════
        //  RESPOSTAS AUTOMÁTICAS (Chatbot por KW)
        // ════════════════════════════════════════
        botTab: 'fluxos',
        arBotAtivo: true,
        arTotalDisparos: 0,
        autoReplies: [],
        arEditId: null,
        arSalvando: false,
        arLeadsJaRespondidos: {},
        arForm: {
            gatilhos: '',
            modoMatch: 'contem',
            blocos: [],
            apenasUmaVez: false,
            prioridade: '2'
        },


        // CONTROLE DE AÇÕES RÁPIDAS
        isQuickFlowOpen: false,
        quickFlowId: '',
        isQuickScheduleOpen: false,
        quickScheduleForm: { tipo: 'simples', flowId: '', texto: '', dataHora: '' },
        activeLeadForAction: null,

        // ✅ Carregados dinamicamente de /api/config no init() — não editar aqui
        EVO_URL: '',
        EVO_KEY: '',
        _operatorNames: new Set(), // nomes do operador — nunca salvar como nome de lead

        navItems: [
            { id: 'dash',              label: 'Dash',            icon: 'pie-chart',                          roles: ['admin','supervisor'] },
            { id: 'kanban',            label: 'Kanban',          icon: 'columns',                            roles: ['admin','atendente'] },
            { id: 'chats',             label: 'Conversas',       icon: 'message-circle',                     roles: ['admin','supervisor','atendente'] },
            { id: 'bot',               label: 'Automação',       icon: 'git-merge',     requerFeature: true, roles: ['admin'] },
            { id: 'ia_atendimento',    label: 'Agentes de IA',   icon: 'sparkles',      requerFeature: true, roles: ['admin'] },
            { id: 'disparo',           label: 'Campanhas',       icon: 'send',          requerFeature: true, roles: ['admin'] },
            { id: 'agenda',            label: 'Agenda',          icon: 'calendar',      requerFeature: true, roles: ['admin','atendente'] },
            { id: 'setores',           label: 'Departamentos',   icon: 'shield',        requerFeature: true, roles: ['admin','supervisor'] },
            { id: 'atendimento',       label: 'Atendimento',     icon: 'activity',                           roles: ['admin','supervisor'] },
            { id: 'conexao',           label: 'Conexão',         icon: 'smartphone',                         roles: ['admin'] },
            { id: 'meu_plano',         label: 'Meu Plano',       icon: 'crown',                              roles: ['admin'] }
        ],
        
        columns: [],
        allColumnsMap: {}, 
        funilIaModal: { open: false, col: {} },

    };
}
