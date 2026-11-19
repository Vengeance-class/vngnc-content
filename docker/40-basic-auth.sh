#!/bin/sh
# Runs at container start (nginx image runs /docker-entrypoint.d/*.sh).
# Builds the htpasswd file from env vars so the password never lives in git.
set -e

USER_NAME="${BASIC_AUTH_USER:-admin}"

if [ -z "$BASIC_AUTH_PASSWORD" ]; then
    echo "ERROR: BASIC_AUTH_PASSWORD is not set; refusing to start without a password." >&2
    exit 1
fi

HASH="$(printf '%s' "$BASIC_AUTH_PASSWORD" | openssl passwd -apr1 -stdin)"
printf '%s:%s\n' "$USER_NAME" "$HASH" > /etc/nginx/.htpasswd
chmod 644 /etc/nginx/.htpasswd
echo "Basic auth enabled for user '$USER_NAME'."
