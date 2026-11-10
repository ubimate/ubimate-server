import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { documentsRouter } from './routes/documents';
import { attachmentsRouter } from './routes/attachments';
import { usageRouter } from './routes/usage';
import { authRouter } from './routes/auth';
import { unfurlRouter } from './routes/unfurl';
import { adminRouter } from './routes/admin';
import { workspacesRouter } from './routes/workspaces';
import { healthRouter } from './routes/health';
import billing from './billing';
import { scheduleUsageReconcile } from './lib/quota';
import { scheduleAttachmentCleanup } from './lib/attachments';
import { assertObjectStorageConfigured } from './lib/objectStore';
import { relay } from './relay';

const API_PORT = Number(process.env.API_PORT) || 3001;

try {
  assertObjectStorageConfigured();
  console.log(`[billing] ${billing.describeBilling()}`);
} catch (err) {
  console.error(`[startup] ${(err as Error).message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express – REST API
// ---------------------------------------------------------------------------

const app = express();

// Trust the first reverse-proxy hop (CapRover / nginx / Caddy).
// Required so express-rate-limit can read X-Forwarded-For without throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when the app is deployed behind a proxy.
app.set('trust proxy', 1);

// Security headers — CSP is left to the reverse proxy / operator so the
// pre-built SPAs (which use inline scripts from Vite) are not broken.
app.use(helmet({ contentSecurityPolicy: false }));

// Cross-origin isolation — places the web app in a dedicated OS process,
// preventing Spectre-class cross-origin reads of the JS heap (where the
// Ed25519 private key and derived seed live for the session).
//
// COOP: prevents cross-origin windows from retaining a reference to this
//       browsing context, blocking window.opener-based attacks.
// COEP: requires all loaded sub-resources to either be same-origin or
//       explicitly opt-in via Cross-Origin-Resource-Policy / CORS.
//       This is safe because the SPA loads no external CDN resources —
//       all scripts, styles, and fonts are bundled and self-hosted.
//
// Tauri webview requests are skipped so desktop clients are unaffected.
//
// Tauri desktop origins: tauri://localhost on macOS/Linux; on Windows
// http://tauri.localhost by default (https:// when the app sets
// useHttpsScheme). Missing the http:// one rejected every request the
// Windows app made — CORS, "Failed to fetch".
const TAURI_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];

app.use((_req, res, next) => {
  const origin = _req.headers.origin ?? '';
  const isTauri = TAURI_ORIGINS.includes(origin);
  if (!isTauri) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  next();
});

// In production set CORS_ORIGIN to the exact origin (e.g. https://ubimate.app)
// or a comma-separated list (e.g. https://ubimate.app,http://localhost:5173).
// Tauri desktop origins (TAURI_ORIGINS above) are always allowed.
// In development we allow any localhost / 127.0.0.1 / ::1 origin on any port
// so Safari, Chrome, and Tauri webviews all work without extra config.
function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
}

const corsOrigin: cors.CorsOptions['origin'] = process.env.CORS_ORIGIN
  ? (origin, callback) => {
      const allowed = process.env.CORS_ORIGIN!.split(',').map(s => s.trim());
      // Allow: no-origin requests, explicit allow-list, Tauri origins, and
      // localhost (needed for Tauri dev-mode which sends http://localhost:*).
      if (!origin || allowed.includes(origin) || TAURI_ORIGINS.includes(origin) || isLocalhostOrigin(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    }
  : (origin, callback) => {
      // Allow requests with no origin (same-origin, Tauri, curl, etc.)
      if (!origin) return callback(null, true);
      if (TAURI_ORIGINS.includes(origin)) return callback(null, true);
      callback(null, isLocalhostOrigin(origin));
    };

app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// Before the JSON parser: the webhook's signature covers the raw body.
app.use('/api/billing/webhook', billing.billingWebhookRouter);

app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

app.use('/api/health', healthRouter);

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/usage', usageRouter);
app.use('/api/unfurl', unfurlRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/billing', billing.billingRouter);

// ---------------------------------------------------------------------------
// SPA – serve the Vite build in production
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV === 'production') {
  // Admin SPA — served under /admin (before the main SPA catch-all)
  const ADMIN_ROOT = path.join(__dirname, '../../admin/dist');
  app.use('/admin', express.static(ADMIN_ROOT));
  app.get('/admin/*path', (_req, res) => res.sendFile(path.join(ADMIN_ROOT, 'index.html')));

  // Mobile web app — served under /m, also before the catch-all. Built only into the
  // unified image; the API image has no mobile-web/dist and skips it.
  const MOBILE_ROOT = path.join(__dirname, '../../mobile-web/dist');
  if (fs.existsSync(MOBILE_ROOT)) {
    app.use('/m', express.static(MOBILE_ROOT));
    app.get(['/m', '/m/*path'], (_req, res) => res.sendFile(path.join(MOBILE_ROOT, 'index.html')));
  }

  const SPA_ROOT = path.join(__dirname, '../../web/dist');
  if (fs.existsSync(SPA_ROOT)) {
    app.use(express.static(SPA_ROOT));
    // SPA fallback — any non-API, non-upload path serves index.html
    app.get('*', (_req, res) => {
      res.sendFile(path.join(SPA_ROOT, 'index.html'));
    });
  }
}

// ---------------------------------------------------------------------------
// Unified HTTP server – Express + zero-knowledge Yjs relay on a single port
// ---------------------------------------------------------------------------

const server = createServer(app);

// Handle WebSocket upgrades for the encrypted Yjs relay (collaboration).
// Client connects to: ws(s)://host:port/yjs/<documentName>
const wss = new WebSocketServer({ noServer: true });

// Protocol-level keepalive. A client that vanishes without a close frame (lost
// network, killed process) would otherwise sit in its room forever, holding a
// socket and receiving broadcasts nobody reads. Ping every interval and drop
// sockets that missed the previous round; browsers answer pings in the
// WebSocket layer, so this needs no client-side code.
const WS_PING_INTERVAL_MS = 30_000;
const wsAlive = new WeakSet<import('ws').WebSocket>();

const wsPingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!wsAlive.has(ws)) {
      ws.terminate();
      continue;
    }
    wsAlive.delete(ws);
    ws.ping();
  }
}, WS_PING_INTERVAL_MS);
wsPingTimer.unref();

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin ?? 'unknown-origin';
  const userAgent = request.headers['user-agent'] ?? 'unknown-ua';
  const wsUrl = request.url ?? 'unknown-url';

  if (request.url?.startsWith('/yjs')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wsAlive.add(ws);
      ws.on('pong', () => wsAlive.add(ws));
      // Surface WS-level failures with request metadata so malformed clients
      // are easier to identify from logs.
      ws.on('error', (err) => {
        console.warn(
          `[yjs] websocket error url=${wsUrl} origin=${origin} ua=${userAgent}:`,
          err,
        );
      });
      ws.on('close', (code, reason) => {
        if (code !== 1000) {
          const reasonText = reason.length > 0 ? reason.toString('utf8') : 'no-reason';
          console.warn(
            `[yjs] websocket closed abnormally code=${code} reason=${reasonText} url=${wsUrl} origin=${origin} ua=${userAgent}`,
          );
        }
      });
      relay.handleConnection(ws, request);
    });
  } else {
    console.warn(
      `[yjs] rejected websocket upgrade url=${wsUrl} origin=${origin} ua=${userAgent}`,
    );
    socket.destroy();
  }
});

server.listen(API_PORT, () => {
  console.log(`[app]   listening on http://localhost:${API_PORT}`);
  console.log(`[app]   REST API at /api, WebSocket at /yjs`);
  scheduleUsageReconcile();
  scheduleAttachmentCleanup();
  billing.startBackgroundJobs();
});
