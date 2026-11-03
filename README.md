# ubimate-server

Self-hostable sync and collaboration server for [Ubimate](https://ubimate.com) — a privacy-oriented, local-first alternative to Notion.

> **License:** [Elastic License 2.0 (ELv2)](./LICENSE) — free to self-host; hosting it as a managed service for third parties is not permitted.

---

## What it does

`ubimate-server` is the backend that powers real-time collaboration and multi-device sync for Ubimate clients. It combines:

- **REST API** (Express) — authentication, workspace management, document metadata, encrypted file attachments
- **Real-time collaboration** (Hocuspocus + Yjs) — conflict-free, multiplayer editing over WebSocket
- **Persistence** (SQLite via better-sqlite3) — documents, users and the attachment ledger stay on your machine; no external database required
- **Object storage** (any S3-compatible bucket) — attachment bytes, always encrypted on the device before upload, so the bucket only ever holds ciphertext
- **Admin panel** — web-based interface for managing users and monitoring disk usage

When self-hosted, Ubimate clients connect to your instance instead of the Ubimate cloud.

For a detailed explanation of the end-to-end encryption model and the Yjs-based sync protocol, see the [Ubimate technical whitepaper](https://ubimate.com/whitepaper.html).

---

## Requirements

- Node.js 20+
- pnpm 8+
- Docker & Docker Compose (for the recommended deployment path)
- An S3-compatible bucket for attachments. The Docker Compose file bundles one (SeaweedFS); for a manual setup see [Object storage](#object-storage-attachments)

---

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, APP_URL, the ADMIN_* vars,
# and S3_ACCESS_KEY / S3_SECRET_KEY (any values, e.g. `openssl rand -hex 16`;
# the bundled SeaweedFS bucket is created with them)
docker compose up -d
```

The REST API and Yjs WebSocket will be available on port **3001**.

Point your Ubimate client at your server by setting the server URL in the app settings.

---

## Manual setup

```bash
pnpm install
cp .env.example apps/api/.env
# Edit apps/api/.env (in production also set the S3_* variables, see below)
pnpm dev
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit:

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Long random string used to sign auth tokens |
| `APP_URL` | Yes | Public URL of this server (used in emails) |
| `ADMIN_USERNAME` | Yes | Admin account created on first run |
| `ADMIN_PASSWORD` | Yes | Admin account password |
| `ADMIN_EMAIL` | Yes | Admin account email |
| `API_PORT` | No | REST API port (default: `3001`) |
| `DATA_DIR` | No | Path for the SQLite database (default: `./data`) |
| `REQUIRE_INVITATION` | No | Set to `true` to restrict registration to invited users |
| `INVITATION_TTL_DAYS` | No | Invitation link expiry in days (default: `7`) |
| `SMTP_HOST` | No | SMTP server host — leave blank to disable email |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_SECURE` | No | Use TLS (default: `false`) |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SMTP_FROM` | No | From address for outbound emails |
| `MAX_IMAGE_UPLOAD_MB` | No | Max image upload size in MB (default: `20`) |
| `MAX_AUDIO_UPLOAD_MB` | No | Max audio upload size in MB (default: `100`) |
| `MAX_VIDEO_UPLOAD_MB` | No | Max video upload size in MB (default: `50`) |
| `UPLOAD_MAX_SIZE_MB` | No | Max size in MB for other file attachments (default: `10`) |
| `S3_ENDPOINT` | Production | URL the API reaches the bucket at, e.g. `https://eu2.contabostorage.com` |
| `S3_BUCKET` | Production | Bucket name |
| `S3_ACCESS_KEY` | Production | S3 access key ID the API uses |
| `S3_SECRET_KEY` | Production | S3 secret access key the API uses |
| `S3_PUBLIC_ENDPOINT` | No | Where **browsers** reach the bucket, if that differs from `S3_ENDPOINT` (default: `S3_ENDPOINT`). Signed URLs name this host |
| `S3_REGION` | No | Region string (default: `eu-central-1`; many providers ignore it) |
| `S3_CLEANUP_ACCESS_KEY` | No | Access key of a separate credential that may delete objects (see below) |
| `S3_CLEANUP_SECRET_KEY` | No | Secret of the cleanup credential |
| `S3_PRESIGN_EXPIRY_PUT` | No | Upload URL lifetime in seconds (default: `900`) |
| `S3_PRESIGN_EXPIRY_GET` | No | Download URL lifetime in seconds (default: `300`) |

---

## Object storage (attachments)

Attachments (images, audio, video, files) are stored in an S3-compatible bucket, not on the server's disk. Clients encrypt each file on the device and upload it straight to the bucket with a short-lived signed URL; downloads go through signed URLs too, handed out only after a workspace-membership check. The server never proxies attachment bytes and never sees a file's name or type, only a coarse kind, a size and a state.

**Required in production.** With `NODE_ENV=production` the API refuses to start unless `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` are all set, and says which are missing. Outside production, with none of them set, attachments fall back to the local disk — fine for development and tests, not a way to run a server.

- **Docker Compose:** `docker-compose.yml` runs SeaweedFS' S3 gateway next to the app and creates the bucket. Set `S3_ACCESS_KEY` and `S3_SECRET_KEY` in `.env`, and `S3_PUBLIC_ENDPOINT` to the address browsers will use to reach the gateway (default `http://localhost:8333`); put it behind HTTPS in production.
- **Your own store** (AWS S3, Contabo, MinIO, Ceph, …): set the four required variables to point at it. The client uses path-style addressing, which Contabo and most self-hosted stores need. If the store honours CORS rules, allow `PUT` and `GET` from the app's origin, and the `Content-Type` header. The bucket must be reachable from browsers at `S3_PUBLIC_ENDPOINT`, over HTTPS when the app is.
- **Contabo:** the endpoint is `https://{region}.contabostorage.com`, e.g. `https://eu2.contabostorage.com`.

### Keeping the API from deleting

The API only ever deletes objects through its cleanup job. If you want the bucket itself to enforce that, use two credentials:

- `S3_ACCESS_KEY` / `S3_SECRET_KEY`: the API's credential, with read and write but a bucket policy denying `s3:DeleteObject` (and `s3:DeleteObjectVersion`).
- `S3_CLEANUP_ACCESS_KEY` / `S3_CLEANUP_SECRET_KEY`: the credential the cleanup job deletes with.

If you leave the cleanup pair unset, the API's own credential is used and the server logs a warning at startup. On Contabo (Ceph RGW), a bucket policy does not restrict the bucket **owner**, only other users, so the restricted user's keys go in `S3_ACCESS_KEY` and the owner's in `S3_CLEANUP_*`. Leave bucket versioning off: with it on, a delete keeps the old bytes as non-current versions and cleanup stops freeing space unless a lifecycle rule expires them.

---

## Admin UI

A browser-based admin panel is included and served at **`/admin/`** on the same port as the API (e.g. `http://localhost:3001/admin/`). Log in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you configured in `.env`.

The admin UI lets you:

- **View registered users** — email, account status, and per-user disk usage
- **Delete users** — permanently removes the account and all associated data
- **Manage invitations** — create invitation links, inspect their status (`pending` / `accepted` / `elapsed`), and revoke them

> The panel is only served in production (`NODE_ENV=production`). For local development, run it separately:
> ```bash
> pnpm --filter admin dev
> ```
> Open `http://localhost:5173`, then enter your API server URL in the login screen.

---

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| `3001` | HTTP + WebSocket | REST API (`/api/*`), Yjs real-time sync (`/yjs`), and Admin UI (`/admin/`) |

All services run on the **same port**. Your reverse proxy only needs to proxy one upstream.

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

---

## Data persistence

All data is stored under `DATA_DIR` (default: `./data`):

```
data/
  ubimate.db      ← SQLite database (documents, workspaces, users, Yjs updates)
```

Back up the entire `data/` directory to preserve the database. Attachments live in your bucket, so back that up (or enable your provider's redundancy) as well.

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
  admin/          ← Admin UI (React + Vite SPA, served at /admin/)
packages/
  types/          ← Shared TypeScript types (@ubimate/types)
  utils/          ← Shared utilities (@ubimate/utils)
```

---

## Transparency & contributing

`ubimate-server` is the self-hostable backend for [Ubimate](https://ubimate.com). We publish it as open source so that anyone deploying it can inspect exactly what they're running. This repository is a mirror of our internal production codebase — what you see here is what runs on Ubimate servers.

Because changes flow from the internal codebase outward, **we do not accept pull requests**. Bug reports and feature requests are welcome — please [open an issue](https://github.com/ubimate/ubimate-server/issues).

---

## License

[Elastic License 2.0 (ELv2)](./LICENSE) — © Ubimate

You are free to use, modify, and self-host this software. You may not offer it as a hosted or managed service to third parties.
