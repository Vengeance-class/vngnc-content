# content.vngnc.net

Small HTML showcase with an admin panel. Upload an HTML file (or paste HTML),
pick a URL or get a random one, and share the link.

- **Admin panel:** `content.vngnc.net/admin` (login screen)
- **Pages:** `content.vngnc.net/<url>` — public to anyone with the link, or
  protected by a per-page viewer password you set in the panel.
- `content.vngnc.net/` lists nothing, so pages can't be discovered.

No dependencies: plain Node.js 22 standard library.

## Coolify setup

1. **Build Pack:** Dockerfile. **Ports Exposes:** `3000`.
2. **Domain:** `https://content.vngnc.net`.
3. **Persistent Storage:** add a volume with destination path **`/data`**.
   Without it, uploaded pages are lost on every redeploy (the panel shows a
   warning if it's missing).
4. **Environment variables:**

   | Variable          | Required | Default | Notes                                          |
   |-------------------|----------|---------|------------------------------------------------|
   | `ADMIN_PASSWORD`  | yes      | —       | Changing it logs out all admin sessions        |
   | `ADMIN_USER`      | no       | `admin` |                                                |
   | `MAX_UPLOAD_MB`   | no       | `20`    |                                                |
   | `SANDBOX_PAGES`   | no       | `true`  | See below                                      |

   (`BASIC_AUTH_PASSWORD` / `BASIC_AUTH_USER` from the old version still work.)

## Data

Everything lives in `/data`: `pages/<url>.html`, `pages.json` (titles, view
counts, password hashes) and `.secret` (signs login cookies). Back up that
volume to back up the site.

## Sandboxing

Uploaded pages are served with `Content-Security-Policy: sandbox …`, so their
scripts run in an isolated origin and can't act on your admin session. Scripts,
forms, popups and downloads still work, but `localStorage`, cookies and
same-site `fetch` inside a page do not. If a page needs those, set
`SANDBOX_PAGES=false`.

## Run locally

```bash
ADMIN_PASSWORD=test DATA_DIR=./data node server.js
```

Then open http://localhost:3000/admin.
