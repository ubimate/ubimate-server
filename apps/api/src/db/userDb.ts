/**
 * Per-user SQLite database factory with in-memory connection cache.
 *
 * Each registered user gets their own SQLite file at:
 *   DATA_DIR/users/<userId>.db
 *
 * Connections are opened on first access and kept open for the process lifetime
 * (one file per user = no write contention; WAL mode handles concurrent reads).
 */
import path from 'path';
import fs from 'fs';
import { initUserDb } from './database';
import type { UserDbHandle } from './database';

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, '../../data');
const USERS_DB_DIR = path.join(DATA_DIR, 'users');

/** In-process cache: userId → open UserDbHandle */
const cache = new Map<string, UserDbHandle>();

export function getUserDb(userId: string): UserDbHandle {
  const existing = cache.get(userId);
  if (existing) return existing;

  if (!fs.existsSync(USERS_DB_DIR)) {
    fs.mkdirSync(USERS_DB_DIR, { recursive: true });
  }

  const dbPath = path.join(USERS_DB_DIR, `${userId}.db`);
  const handle = initUserDb(dbPath);
  cache.set(userId, handle);
  return handle;
}

export type { UserDbHandle };
