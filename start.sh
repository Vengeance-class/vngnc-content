#!/bin/sh
set -e
# Make sure the mounted volume is writable by the app user, then drop root.
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"
exec su-exec node node /app/server.js
