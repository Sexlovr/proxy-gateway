FROM node:20-slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --branch main --depth 1 https://github.com/Sexlovr/proxy-gateway.git .
RUN npm install --production
RUN mkdir -p /data && chmod 777 /data
ENV PORT=7860
ENV DATA_DIR=/data
ENV DELETE_PASSWORD=changeme
EXPOSE 7860
CMD ["node", "server.js"]
