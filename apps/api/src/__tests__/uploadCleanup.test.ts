// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * What happens to uploaded files when the documents that name them go away.
 *
 * Uploads live in one folder per *user* (`uploads/<userId>/`), not per Space, and a file is known to
 * the server only through a `document` row of type `image` or `file` (the "Media" records the editor
 * and the importers file under a page). So whether a file is cleaned up depends on how the row names
 * it, whether the row is readable, and which delete path ran. These tests pin each case.
 *
 * Two kinds of test, named so that a reader can tell them apart:
 * - plain tests assert behaviour the code has and should keep;
 * - `KNOWN GAP` tests assert the behaviour the code has today and should not have, so the gap is
 *   written down where the suite will notice it moving; `it.fails` ones state the *desired*
 *   behaviour and pass only while it is missing (vitest reports them when a fix lands, which is the
 *   cue to turn them into plain tests).
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initUserDb } from '../db/database';
import type { UserDbHandle } from '../db/database';

const TEST_USER_ID = 'test-user-uploads-cleanup';
const OTHER_USER_ID = 'someone-else';
/** What the web client stores: the server's base URL in front of the path the upload returned. */
const CLIENT_BASE = 'https://app.example.test';

describe('deleting documents — uploaded files', () => {
  let tmpDir: string;
  let handle: UserDbHandle;
  let server: ReturnType<typeof express.application.listen> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubimate-upload-cleanup-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });
    handle = initUserDb(path.join(tmpDir, 'users', `${TEST_USER_ID}.db`));

    vi.resetModules();
    vi.doMock('../middleware/auth', () => ({
      requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { userId: string }).userId = TEST_USER_ID;
        (req as Request & { userDbHandle: UserDbHandle }).userDbHandle = handle;
        next();
      },
    }));

    const { documentsRouter } = await import('../routes/documents');
    const app = express();
    app.use(express.json());
    app.use('/api/documents', documentsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    const { closeRegistryDb } = await import('../db/registry');
    closeRegistryDb();
    handle.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** A real file in a user's upload folder. */
  function seedFile(ext = 'png', userId = TEST_USER_ID, name = `${randomUUID()}.${ext}`) {
    const dir = path.join(tmpDir, 'uploads', userId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, `bytes of ${name}`);
    return { filePath, name, path: `/uploads/${userId}/${name}`, url: `${CLIENT_BASE}/uploads/${userId}/${name}` };
  }

  async function create(type: string, properties: Record<string, unknown>, parentId: string | null = null): Promise<string> {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, parent_id: parentId, position: 'a0', properties }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  /** A Space holding a page with a Media folder, as the editor files uploads. */
  async function spaceWithMedia(): Promise<{ space: string; page: string; media: string }> {
    const space = await create('workspace', { title: 'Space' });
    const page = await create('page', { title: 'Page' }, space);
    const media = await create('folder', { title: 'Media' }, page);
    return { space, page, media };
  }

  const del = (id: string) => fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE' });
  /** `fs.unlink` runs unawaited in the handler. */
  const settle = () => new Promise<void>((r) => setTimeout(r, 80));

  // -------------------------------------------------------------------------
  // Permanent delete: what is cleaned up
  // -------------------------------------------------------------------------

  it('removes the file behind an image row, whose src is the absolute URL clients store', async () => {
    const { space, media } = await spaceWithMedia();
    const file = seedFile('png');
    await create('image', { src: file.url, title: file.name }, media);

    expect((await del(space)).ok).toBe(true);
    await settle();
    expect(fs.existsSync(file.filePath)).toBe(false);
  });

  it('removes the file behind every row of a Space: images, files, and the file rows video and audio make', async () => {
    const { space, media } = await spaceWithMedia();
    // The editor files a video or audio upload as a `file` row (AppEditor createVideoDocument/AudioDocument).
    const files = ['png', 'pdf', 'mp4', 'mp3'].map((ext) => seedFile(ext));
    await create('image', { src: files[0].url }, media);
    await create('file', { src: files[1].url, mimeType: 'application/pdf' }, media);
    await create('file', { src: files[2].url, mimeType: 'video/mp4' }, media);
    await create('file', { src: files[3].url, mimeType: 'audio/mpeg' }, media);

    expect((await del(space)).ok).toBe(true);
    await settle();
    expect(files.map((f) => fs.existsSync(f.filePath))).toEqual([false, false, false, false]);
  });

  it('removes files filed anywhere in the subtree, not only directly under the Space', async () => {
    const space = await create('workspace', { title: 'Space' });
    const folder = await create('folder', { title: 'Deep' }, space);
    const page = await create('page', { title: 'P' }, folder);
    const media = await create('folder', { title: 'Media' }, page);
    const file = seedFile('png');
    await create('image', { src: file.url }, media);

    await del(space);
    await settle();
    expect(fs.existsSync(file.filePath)).toBe(false);
  });

  it('deleting one page removes only the files of that page', async () => {
    const { space, page, media } = await spaceWithMedia();
    const otherPage = await create('page', { title: 'Other' }, space);
    const otherMedia = await create('folder', { title: 'Media' }, otherPage);
    const gone = seedFile('png');
    const kept = seedFile('png');
    await create('image', { src: gone.url }, media);
    await create('image', { src: kept.url }, otherMedia);

    await del(page);
    await settle();
    expect(fs.existsSync(gone.filePath)).toBe(false);
    expect(fs.existsSync(kept.filePath)).toBe(true);
  });

  it('leaves another Space\'s files alone', async () => {
    const a = await spaceWithMedia();
    const b = await spaceWithMedia();
    const mine = seedFile('png');
    const theirs = seedFile('png');
    await create('image', { src: mine.url }, a.media);
    await create('image', { src: theirs.url }, b.media);

    await del(a.space);
    await settle();
    expect(fs.existsSync(mine.filePath)).toBe(false);
    expect(fs.existsSync(theirs.filePath)).toBe(true);
  });

  it('does not fail when a file is already gone', async () => {
    const { space, media } = await spaceWithMedia();
    const file = seedFile('png');
    fs.unlinkSync(file.filePath);
    await create('image', { src: file.url }, media);

    expect((await del(space)).ok).toBe(true);
  });

  it('does not fail on a row with no src, or an external one', async () => {
    const { space, media } = await spaceWithMedia();
    await create('image', { title: 'no src' }, media);
    await create('image', { src: 'https://example.test/external.png' }, media);
    expect((await del(space)).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Permanent delete: what must not be touched
  // -------------------------------------------------------------------------

  it('only ever unlinks inside the user\'s own upload folder, whatever the src says', async () => {
    const { space, media } = await spaceWithMedia();
    const outside = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(outside, 'not an upload');
    const someoneElses = seedFile('png', OTHER_USER_ID, 'shared-name.png');
    // A src that walks out of the folder, and one naming another user's file.
    await create('file', { src: `${CLIENT_BASE}/uploads/${TEST_USER_ID}/../../secret.txt` }, media);
    await create('file', { src: `${CLIENT_BASE}/uploads/${OTHER_USER_ID}/shared-name.png` }, media);

    expect((await del(space)).ok).toBe(true);
    await settle();
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(someoneElses.filePath)).toBe(true);
  });

  it('does not remove anything when the Space is only trashed', async () => {
    const { space, media } = await spaceWithMedia();
    const file = seedFile('png');
    await create('image', { src: file.url }, media);

    const res = await fetch(`${baseUrl}/api/documents/${space}/trash`, { method: 'PATCH' });
    expect(res.ok).toBe(true);
    await settle();
    expect(fs.existsSync(file.filePath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Known gaps
  // -------------------------------------------------------------------------

  it('KNOWN GAP: leaves a file that no row names, such as an upload used only in page content', async () => {
    const { space } = await spaceWithMedia();
    const orphan = seedFile('png');

    await del(space);
    await settle();
    // The server cannot know which files a page's Yjs content uses, only what rows say.
    expect(fs.existsSync(orphan.filePath)).toBe(true);
  });

  it('KNOWN GAP: leaves the files behind rows whose properties are encrypted', async () => {
    const { space, media } = await spaceWithMedia();
    const file = seedFile('png');
    // With workspace keys held (the normal case) the client sends `{ _enc }` and never the src
    // (ClientContext.encryptProperties), so the server has nothing to read the file name from.
    await create('image', { _enc: Buffer.from(JSON.stringify({ src: file.url })).toString('base64') }, media);

    expect((await del(space)).ok).toBe(true);
    await settle();
    expect(fs.existsSync(file.filePath)).toBe(true);
  });

  it('KNOWN GAP: a structural delete op, which is how the apps delete when syncing, removes no files', async () => {
    const { space, media } = await spaceWithMedia();
    const file = seedFile('png');
    await create('image', { src: file.url }, media);

    const res = await fetch(`${baseUrl}/api/documents/sync/structural`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'delete', id: space, client_ts: Date.now() + 10_000 }] }),
    });
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { applied: number }).applied).toBe(1);
    await settle();
    expect(fs.existsSync(file.filePath)).toBe(true);
  });

  it.fails('keeps a file that a row in another Space still names (files are per user, not per Space)', async () => {
    const a = await spaceWithMedia();
    const b = await spaceWithMedia();
    // Importing an export twice reuses the upload, so two Spaces can name one file.
    const shared = seedFile('png');
    await create('image', { src: shared.url }, a.media);
    await create('image', { src: shared.url }, b.media);

    await del(a.space);
    await settle();
    expect(fs.existsSync(shared.filePath)).toBe(true);
  });

  it.fails('removes the file behind a row whose src is a relative /uploads/ path', async () => {
    const { space, media } = await spaceWithMedia();
    const file = seedFile('png');
    // `new URL('/uploads/…')` throws without a base, and the handler swallows it.
    await create('image', { src: file.path }, media);

    await del(space);
    await settle();
    expect(fs.existsSync(file.filePath)).toBe(false);
  });

  it.fails('removes the replaced file when the new src is an absolute URL (the PUT cleanup only matches /uploads/…)', async () => {
    const { media } = await spaceWithMedia();
    const old = seedFile('png');
    const next = seedFile('png');
    const id = await create('image', { src: old.url }, media);

    const res = await fetch(`${baseUrl}/api/documents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { src: next.url } }),
    });
    expect(res.ok).toBe(true);
    await settle();
    expect(fs.existsSync(old.filePath)).toBe(false);
  });
});
