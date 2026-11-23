FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 TZ=America/Sao_Paulo DATA_DIR=/app/data
# ffmpeg: converte qualquer vídeo enviado no Admin para MP4 que toca em todo celular
RUN apk add --no-cache tzdata ffmpeg
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
