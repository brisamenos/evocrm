FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data /app/uploads-v2

EXPOSE 3002

CMD ["node", "server.js"]
