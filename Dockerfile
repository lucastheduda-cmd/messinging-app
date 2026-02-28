 FROM node:20-alpine

  WORKDIR /app

  COPY messaging-app/package.json ./

  RUN npm install --production

  COPY messaging-app/ .

  EXPOSE 3000

  CMD ["node", "server.js"]
