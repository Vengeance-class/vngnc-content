FROM node:22-alpine

# su-exec lets the start script fix /data ownership as root, then drop to the "node" user.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY server.js ./
COPY public ./public
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/start.sh"]
