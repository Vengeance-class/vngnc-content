#!/bin/sh
# Build-time: if pages/ has no index.html, generate one listing every page.
set -e
ROOT="${1:-/usr/share/nginx/html}"
cd "$ROOT"

[ -f index.html ] && { echo "Custom index.html found, skipping generation."; exit 0; }

items=""
for f in *.html; do
    [ -f "$f" ] || continue
    case "$f" in 404.html) continue ;; esac
    name="${f%.html}"
    items="$items<li><a href=\"/$name\">$name</a></li>"
done
for d in */; do
    [ -f "${d}index.html" ] || continue
    name="${d%/}"
    items="$items<li><a href=\"/$name/\">$name</a></li>"
done
[ -n "$items" ] || items="<li class=\"empty\">No pages yet.</li>"

cat > index.html <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Content</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  ul { list-style: none; padding: 0; }
  li { padding: .5rem 0; border-bottom: 1px solid #8884; }
  a { text-decoration: none; }
  .empty { opacity: .6; }
</style>
</head>
<body>
<h1>Content</h1>
<ul>$items</ul>
</body>
</html>
EOF
echo "Generated index.html."
