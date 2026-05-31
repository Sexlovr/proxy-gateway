FROM node:20-slim

WORKDIR /app

RUN mkdir -p /data && chmod 777 /data

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod -R 755 /app

EXPOSE 7860

ENV PORT=7860
ENV DATA_DIR=/data
ENV DELETE_PASSWORD=changeme

CMD ["node", "server.js"]
