import express from 'express';
import cors from 'cors';
import { documentsRouter } from './routes/documents';
import { hocuspocus } from './hocuspocus';

const API_PORT = Number(process.env.API_PORT) || 3001;

// ---------------------------------------------------------------------------
// Express – REST API
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.use('/api/documents', documentsRouter);

app.listen(API_PORT, () => {
  console.log(`[api]   REST API listening on http://localhost:${API_PORT}`);
});

// ---------------------------------------------------------------------------
// Hocuspocus – Yjs WebSocket server
// ---------------------------------------------------------------------------

hocuspocus.listen().then(() => {
  console.log(`[yjs]   Hocuspocus WebSocket listening on ws://localhost:1234`);
});
