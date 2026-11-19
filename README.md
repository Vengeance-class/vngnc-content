# content.vngnc.net

Password-protected static HTML showcase (nginx + basic auth).

## Adding a page

Drop files into `pages/`, commit, push. Coolify redeploys via webhook.

| File in repo                      | URL                                   |
|-----------------------------------|---------------------------------------|
| `pages/mypage1.html`              | `content.vngnc.net/mypage1`           |
| `pages/demo/index.html` (+assets) | `content.vngnc.net/demo/`             |

Use the folder form when a page has its own images/CSS/JS, and reference them
with relative paths (`./style.css`).

`content.vngnc.net/` shows an auto-generated list of all pages. Add your own
`pages/index.html` to replace it.

## Coolify setup

1. New Resource → your Git repo → **Build Pack: Dockerfile**.
2. **Ports Exposes:** `80`.
3. **Domains:** `https://content.vngnc.net`.
4. **Environment variables:**
   - `BASIC_AUTH_PASSWORD` (required — container won't start without it)
   - `BASIC_AUTH_USER` (optional, default `admin`)
5. Enable auto-deploy / webhook as with your other apps.
6. DNS: `A` record `content` → your VPS IP (skip if you have a `*` wildcard).

Health check: `/healthz` (not password protected).

## Run locally

```bash
docker build -t content .
docker run --rm -p 8080:80 -e BASIC_AUTH_PASSWORD=test content
```
