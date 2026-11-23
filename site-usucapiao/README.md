# Site Usucapião + Admin das inscrições

Publica a página do site, recebe o formulário, guarda todos os inscritos e repassa cada um ao EvoCRM,
que dispara o fluxo no WhatsApp.

```
Visitante preenche o formulário
        │
        ▼
Este servidor grava a inscrição (nunca se perde)  ──►  /admin mostra todos os inscritos
        │
        ▼  (código de conexão)
EvoCRM → cria/atualiza o contato → notifica → envia o fluxo configurado em "Inscrições do site"
```

## Estrutura
Tudo numa pasta só:
- `server.js` — servidor (site, formulário, admin e envio ao CRM)
- `site-config.js` — textos editáveis, vídeos, logo, WhatsApp, Pixel/Google, versões e backup
- `usucapiao.html` — modelo da página (os textos vêm do Admin → Site). Pode ter outro nome: o sistema usa o `.html` da pasta que não for o `admin.html`.
- `admin.html` — painel administrativo
- `logo-padrao.png` — logo usada enquanto nenhuma outra for escolhida
- `package.json`, `package-lock.json`, `Dockerfile`, `.env.example`, `.dockerignore`, `.gitignore`

Por segurança, o navegador só consegue baixar a página, o `/admin`, a logo padrão e os vídeos/imagens enviados.
Código, banco e configurações nunca são servidos.
- `data/` — banco (`site.db`) e vídeos/imagens (`midia/`). **Tem que ser um volume.**

## O que nunca se perde no deploy
Tudo que você configura no Admin (textos, vídeos, logo, senha, código do CRM, inscrições) fica em `/app/data`.
O código do projeto não guarda nada disso, então trocar arquivos e fazer redeploy não apaga configuração —
**desde que `/app/data` seja um volume**. O próprio Admin mostra um aviso vermelho se não for.
Extra: cada vez que você salva o site, a versão anterior fica guardada (30 últimas) e você pode baixar um backup.

## Subir no EasyPanel
1. Crie um serviço **App** a partir deste projeto (Dockerfile incluso).
2. **Volume:** monte `/app/data` (ex.: volume `site-usucapiao-data`). Sem ele, as inscrições somem a cada deploy.
3. **Ambiente** (opcional): `ADMIN_SENHA=uma-senha-forte`. Sem ela, o primeiro acesso ao `/admin` pede para criar a senha.
4. **Domínio:** aponte o domínio do site para a porta `3000`.

## Aba Site (no Admin)
- **Vídeo principal:** envie qualquer formato (MP4, MOV do iPhone, AVI, MKV, WMV...) e qualquer tamanho.
  O envio é feito em partes de 8 MB: se a internet cair, escolha o mesmo arquivo de novo e ele continua de onde parou.
  O servidor converte para MP4 (H.264), que toca em todo celular, e gera a capa sozinho. Vídeo em pé fica em pé.
  Também aceita link do YouTube/Vimeo.
- **Textos:** todos os textos da página, com botão "↺ original" em cada um.
- **Logo, capa do vídeo, WhatsApp flutuante, Pixel da Meta e Google Analytics/Ads.**
- **Versões e backup:** restaurar qualquer uma das 30 últimas versões, baixar e restaurar backup.

## Ligar ao CRM
1. No CRM: **Inscrições do site → + Conectar site** → aba **Conexão** → **Copiar** o código.
2. No site: `https://seu-site/admin` → **Conexão com o CRM** → cole o código → **Salvar e testar**.
3. No CRM, aba **Fluxo**: monte as mensagens que o inscrito recebe e use **Simular inscrição** para testar.

## Como funciona o envio
- A inscrição é gravada antes de responder ao visitante.
- Se o CRM estiver fora do ar, tenta de novo sozinho (1, 2, 5, 15, 30 min, 1 h, 2 h, 6 h, 12 h, 24 h).
- Inscrições feitas antes de conectar o CRM ficam guardadas e vão assim que você conectar.
- Código trocado/excluído no CRM: as inscrições aparecem como "Código inválido". Cole o novo código e elas são reenviadas.
- A cada 3 minutos o painel busca no CRM a situação do WhatsApp (fluxo enviado, cliente respondeu, botão escolhido).

## Proteções
- Anti-robô (campo escondido + tempo mínimo de preenchimento) e limite de 8 envios por IP a cada 10 min.
- Mesmo telefone em 10 minutos não duplica (clique duplo).
- Senha com hash (scrypt), sessão de 7 dias, limite de tentativas de login, trocar a senha derruba as outras sessões.

## Página em outro servidor
Se o HTML do site ficar hospedado em outro lugar, coloque antes do `</body>`:
```html
<script>window.INSCRICAO_API = 'https://endereco-deste-servidor';</script>
```
(o servidor já libera o envio de outros domínios para `/api/inscricao`).
