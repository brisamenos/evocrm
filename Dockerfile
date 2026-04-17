FROM node:20

WORKDIR /app

# Dependências de build para better-sqlite3 (node-gyp)
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data/uploads

EXPOSE 3001

CMD ["node", "server.js"]
