import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { documentsRouter } from './routes/documents';
import { uploadsRouter } from './routes/uploads';
import { authRouter } from './routes/auth';
import { unfurlRouter } from './routes/unfurl';
import { adminRouter } from './routes/admin';
import { workspacesRouter } from './routes/workspaces';
import { demoRouter, scheduleDemoCleanup } from './routes/demo';
import { requireAuth } from './middleware/auth';
import { relay } from './relay';

const NO_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150" width="200" height="150">
  <rect width="200" height="150" fill="#f5f5f5" rx="6"/>
  <rect x="55" y="35" width="90" height="80" rx="3" fill="none" stroke="#d0d0d0" stroke-width="2"/>
  <polygon points="70,105 100,68 130,105" fill="#e2e2e2"/>
  <circle cx="82" cy="58" r="9" fill="#e8e8e8"/>
  <line x1="58" y1="38" x2="142" y2="112" stroke="#c8c8c8" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="142" y1="38" x2="58" y2="112" stroke="#c8c8c8" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const API_PORT = Number(process.env.API_PORT) || 3001;

// Resolve data directory the same way database.ts and uploads.ts do so that
// setting DATA_DIR=/data (e.g. for a CapRover persistent volume) is honoured
// everywhere — both for writing files and for serving them.
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../data');

// ---------------------------------------------------------------------------
// Express – REST API
// ---------------------------------------------------------------------------

const app = express();

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
// Tauri webview requests carry no Origin header; the guard skips them so
// desktop clients are unaffected.
app.use((_req, res, next) => {
  const origin = _req.headers.origin ?? '';
  const isTauri = origin === 'tauri://localhost' || origin === 'https://tauri.localhost';
  if (!isTauri) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  next();
});

// In production set CORS_ORIGIN to the exact origin (e.g. https://app.ubimate.com)
// or a comma-separated list (e.g. https://app.ubimate.com,http://localhost:5173).
// Tauri desktop origins (https://tauri.localhost, tauri://localhost) are always allowed.
// In development we allow any localhost / 127.0.0.1 / ::1 origin on any port
// so Safari, Chrome, and Tauri webviews all work without extra config.
const TAURI_ORIGINS = ['https://tauri.localhost', 'tauri://localhost'];

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

app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/demo', demoRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/unfurl', unfurlRouter);
app.use('/api/workspaces', workspacesRouter);

// Serve uploaded files — authentication required to prevent unauthenticated
// access to potentially sensitive encrypted attachments.
// Note: app.use (not app.get) is required here so Express strips the /uploads
// prefix and req.path is relative to the mount point.
app.use('/uploads', requireAuth, (req: express.Request, res: express.Response) => {
  const relPath = req.path.replace(/^\//, ''); // strip leading slash
  if (!relPath) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(NO_IMAGE_SVG);
    return;
  }
  const uploadsRoot = path.resolve(path.join(DATA_DIR, 'uploads'));
  const target = path.resolve(path.join(DATA_DIR, 'uploads', relPath));
  // Guard against path traversal attempts.
  if (!target.startsWith(uploadsRoot + path.sep)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(NO_IMAGE_SVG);
    return;
  }
  res.sendFile(target, (err) => {
    if (err) {
      // The error often fires because the client aborted the request mid-stream
      // (onaborted). By then the response may have already started, so writing
      // the SVG fallback would throw ERR_HTTP_HEADERS_SENT — just end instead.
      if (res.headersSent || req.aborted) {
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'image/svg+xml');
      res.send(NO_IMAGE_SVG);
    }
  });
});

// ---------------------------------------------------------------------------
// SPA – serve the Vite build in production
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV === 'production') {
  // Admin SPA — served under /admin (before the main SPA catch-all)
  const ADMIN_ROOT = path.join(__dirname, '../../admin/dist');
  app.use('/admin', express.static(ADMIN_ROOT));
  app.get('/admin/*path', (_req, res) => res.sendFile(path.join(ADMIN_ROOT, 'index.html')));

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

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin ?? 'unknown-origin';
  const userAgent = request.headers['user-agent'] ?? 'unknown-ua';
  const wsUrl = request.url ?? 'unknown-url';

  if (request.url?.startsWith('/yjs')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
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
  scheduleDemoCleanup();
});
