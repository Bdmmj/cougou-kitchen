FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4174

COPY package.json ./
COPY server.js index.html styles.css app.js ./
COPY admin.html admin.css admin.js ./
COPY scripts ./scripts

RUN mkdir -p /app/data

EXPOSE 4174
VOLUME ["/app/data"]

CMD ["node", "server.js"]
