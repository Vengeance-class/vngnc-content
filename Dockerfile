FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/40-basic-auth.sh /docker-entrypoint.d/40-basic-auth.sh
COPY docker/gen-index.sh /usr/local/bin/gen-index.sh
RUN chmod +x /docker-entrypoint.d/40-basic-auth.sh /usr/local/bin/gen-index.sh

COPY pages/ /usr/share/nginx/html/
RUN /usr/local/bin/gen-index.sh /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
