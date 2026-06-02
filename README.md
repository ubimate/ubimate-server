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

---

## Requirements

- Node.js 20+
- pnpm 8+
- Docker & Docker Compose (for the recommended deployment path)

---

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, APP_URL, CORS_ORIGIN, and the ADMIN_* vars
docker compose up -d
```

The REST API will be available on port **3001** and the Yjs WebSocket on port **1234**.

Point your Ubimate client at your server by setting the server URL in the app settings.

---

## Manual setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # or copy from root .env.example
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
| `CORS_ORIGIN` | Yes | URL of the Ubimate client (browser CORS policy) |
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
| `3001` | HTTP | REST API |
| `1234` | WebSocket | Yjs real-time sync (Hocuspocus) |

Both ports must be reachable from the Ubimate client. If you put the server behind a reverse proxy (nginx, Caddy), ensure the WebSocket port is also proxied.

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
