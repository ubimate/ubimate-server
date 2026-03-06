import express from 'express';
import cors from 'cors';
import path from 'path';
import { documentsRouter } from './routes/documents';
import { uploadsRouter } from './routes/uploads';
import { hocuspocus } from './hocuspocus';

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

// Serve uploaded files as static assets.
app.use('/uploads', express.static(path.join(process.cwd(), 'data', 'uploads')));

app.listen(API_PORT, () => {
  console.log(`[api]   REST API listening on http://localhost:${API_PORT}`);
});

// ---------------------------------------------------------------------------
// Hocuspocus – Yjs WebSocket server
// ---------------------------------------------------------------------------

hocuspocus.listen().then(() => {
  console.log(`[yjs]   Hocuspocus WebSocket listening on ws://localhost:1234`);
});
