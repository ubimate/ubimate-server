import express from 'express';
import cors from 'cors';
import path from 'path';
import { documentsRouter } from './routes/documents';
import { uploadsRouter } from './routes/uploads';
import { hocuspocus } from './hocuspocus';

const NO_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150" width="200" height="150">
  <rect width="200" height="150" fill="#f5f5f5" rx="6"/>
  <rect x="55" y="35" width="90" height="80" rx="3" fill="none" stroke="#d0d0d0" stroke-width="2"/>
  <polygon points="70,105 100,68 130,105" fill="#e2e2e2"/>
  <circle cx="82" cy="58" r="9" fill="#e8e8e8"/>
  <line x1="58" y1="38" x2="142" y2="112" stroke="#c8c8c8" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="142" y1="38" x2="58" y2="112" stroke="#c8c8c8" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const API_PORT = Number(process.env.API_PORT) || 3001;

// ---------------------------------------------------------------------------
// Express – REST API
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api/documents', documentsRouter);
app.use('/api/uploads', uploadsRouter);

// Serve uploaded files as static assets; fall through to fallback if not found.
app.use('/uploads', express.static(path.join(process.cwd(), 'data', 'uploads')));

// Fallback: return a "no image" SVG for any missing upload.
app.get('/uploads/:filename', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(NO_IMAGE_SVG);
});

app.listen(API_PORT, () => {
  console.log(`[api]   REST API listening on http://localhost:${API_PORT}`);
});

// ---------------------------------------------------------------------------
// Hocuspocus – Yjs WebSocket server
// ---------------------------------------------------------------------------

hocuspocus.listen().then(() => {
  console.log(`[yjs]   Hocuspocus WebSocket listening on ws://localhost:1234`);
});
