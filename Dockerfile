FROM node:20-slim

# ffmpeg converte áudios (gravações do navegador, mp3, etc.) para OGG/Opus,
# formato exigido pela Wuzapi para mensagens de voz.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data /app/uploads

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
