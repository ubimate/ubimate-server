# ubimate-server

Self-hostable sync and collaboration server for [Ubimate](https://ubimate.com) — a privacy-oriented, local-first alternative to Notion.

> **License:** [Elastic License 2.0 (ELv2)](./LICENSE) — free to self-host; hosting it as a managed service for third parties is not permitted.

---

## What it does

`ubimate-server` is the backend that powers real-time collaboration and multi-device sync for Ubimate clients. It combines:

- **REST API** (Express) — authentication, workspace management, document metadata, file uploads
- **Real-time collaboration** (Hocuspocus + Yjs) — conflict-free, multiplayer editing over WebSocket
- **Persistence** (SQLite via better-sqlite3) — all data stays on your machine; no external database required

When self-hosted, Ubimate desktop/web clients connect to your instance instead of the Ubimate cloud.

For a detailed explanation of the end-to-end encryption model and the Yjs-based sync protocol, see the [Ubimate technical whitepaper](https://ubimate.com/whitepaper.html).

---

## Requirements

- Node.js 20+
- pnpm 8+
- Docker & Docker Compose (for the recommended deployment path)

---

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, APP_URL, and the ADMIN_* vars
docker compose up -d
```

The REST API and Yjs WebSocket will be available on port **3001**.

Point your Ubimate client at your server by setting the server URL in the app settings.

---

## Manual setup

```bash
pnpm install
cp .env.example apps/api/.env
# Edit apps/api/.env
pnpm dev
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit:

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Long random string used to sign auth tokens |
| `APP_URL` | Yes | Public URL of this server (used in emails) |
| `CORS_ORIGIN` | No | Browser origin(s) to allow via CORS. Not needed for self-hosting |
| `ADMIN_USERNAME` | Yes | Admin account created on first run |
| `ADMIN_PASSWORD` | Yes | Admin account password |
| `ADMIN_EMAIL` | Yes | Admin account email |
| `API_PORT` | No | REST API port (default: `3001`) |
| `DATA_DIR` | No | Path for SQLite DB and uploads (default: `./data`) |
| `REQUIRE_INVITATION` | No | Set to `true` to restrict registration to invited users |
| `INVITATION_TTL_DAYS` | No | Invitation link expiry in days (default: `7`) |
| `SMTP_HOST` | No | SMTP server host — leave blank to disable email |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_SECURE` | No | Use TLS (default: `false`) |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SMTP_FROM` | No | From address for outbound emails |
| `MAX_IMAGE_UPLOAD_MB` | No | Max image upload size in MB (default: `10`) |
| `MAX_AUDIO_UPLOAD_MB` | No | Max audio upload size in MB (default: `50`) |
| `MAX_VIDEO_UPLOAD_MB` | No | Max video upload size in MB (default: `200`) |

---

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| `3001` | HTTP + WebSocket | REST API (`/api/*`) and Yjs real-time sync (`/yjs`) |

Both the REST API and the Hocuspocus WebSocket endpoint run on the **same port**. Your reverse proxy only needs to proxy one upstream.

---

## Reverse proxy / HTTPS

Exposing port 3001 directly is fine for local development. For production, put a reverse proxy in front so clients connect over HTTPS/WSS on standard port 443.

### Option A — Caddy (recommended, automatic TLS)

```bash
# Install Caddy: https://caddyserver.com/docs/install
# Then copy deploy/Caddyfile, edit the domain, and run:
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

See [`deploy/Caddyfile`](./deploy/Caddyfile) for the full config (it is two lines).

### Option B — nginx + certbot

```bash
# Obtain certificate first
sudo certbot --nginx -d your-server.example.com

# Then copy and adapt the example config
sudo cp deploy/nginx.conf /etc/nginx/sites-available/ubimate
sudo ln -s /etc/nginx/sites-available/ubimate /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

See [`deploy/nginx.conf`](./deploy/nginx.conf) for the annotated example.

### CORS_ORIGIN

The Tauri desktop app origins (`tauri://localhost`, `https://tauri.localhost`) are **always allowed** regardless of `CORS_ORIGIN`. You only need to set it if you are also serving the Ubimate web app from a browser origin:

```
CORS_ORIGIN=https://app.your-client.example.com
```

Leave it unset for a desktop-only self-hosted setup.

---

## Data persistence

All data is stored under `DATA_DIR` (default: `./data`):

```
data/
  ubimate.db      ← SQLite database (documents, workspaces, users, Yjs updates)
  uploads/        ← uploaded images, audio, and video files
```

Back up the entire `data/` directory to preserve all content.

---

## Development

```bash
pnpm install
pnpm dev          # starts the API server with hot-reload
pnpm test         # runs the test suite
pnpm build        # compiles TypeScript to dist/
```

---

## Upgrading

Schema migrations run automatically on startup — no manual SQL steps required. To upgrade:

```bash
# 1. Back up your data directory first
cp -r ./data ./data.bak-$(date +%Y%m%d)

# Docker deployment
docker compose pull
docker compose up -d

# Manual deployment
git pull
pnpm install
pnpm build
# then restart the process (systemd / pm2 / etc.)
```

The server records applied migrations in the `schema_version` table. If a startup migration fails, the server exits immediately so your data is never left in a partially-migrated state; restore from backup and file an issue.

---

## Project structure

```
apps/
  api/            ← Express + Hocuspocus server
    src/
      routes/     ← REST route handlers (auth, documents, workspaces, uploads, admin)
      db/         ← SQLite prepared statements and schema
      middleware/ ← JWT auth, rate limiting
      hocuspocus.ts  ← Yjs WebSocket server
packages/
  types/          ← Shared TypeScript types (@ubimate/types)
  utils/          ← Shared utilities (@ubimate/utils)
```

---

## License

[Elastic License 2.0 (ELv2)](./LICENSE) — © Ubimate

You are free to use, modify, and self-host this software. You may not offer it as a hosted or managed service to third parties.
