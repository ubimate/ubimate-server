/**
 * Seed a fresh demo workspace with a realistic set of starter documents so
 * new visitors land on a populated workspace rather than a blank slate.
 *
 * No ZK encryption is applied — demo workspaces are unencrypted by design.
 */
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { generateKeyBetween } from '@ubimate/utils';
import type { UserDbHandle } from './database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Tiptap-compatible Yjs state update for a page. */
function buildYjsUpdate(nodes: Array<{ type: string; text: string }>): Uint8Array {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');
  for (const { type, text } of nodes) {
    const el = new Y.XmlElement(type);
    if (text) el.insert(0, [new Y.XmlText(text)]);
    fragment.insert(fragment.length, [el]);
  }
  return Y.encodeStateAsUpdate(ydoc);
}

interface DocRow {
  id: string;
  parent_id: string | null;
  type: string;
  position: string;
  properties: string;
  created_at: number;
  updated_at: number;
  last_struct_ts: number;
  status: number;
  status_timestamp: number | null;
  last_properties_ts: number;
}

function makeDoc(overrides: Partial<DocRow> & Pick<DocRow, 'id' | 'parent_id' | 'type' | 'position' | 'properties'>): DocRow {
  const now = Date.now();
  return {
    created_at: now,
    updated_at: now,
    last_struct_ts: now,
    status: 0,
    status_timestamp: null,
    last_properties_ts: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a pre-built document tree into `db`.
 * `workspaceId` must be a fresh UUID not yet present in the database.
 *
 * Tree layout:
 *   workspace  "My Workspace"
 *   ├── page      "👋 Welcome to Ubimate"  ← Yjs rich-text pre-seeded
 *   ├── folder    "Notes"
 *   │   ├── page  "Meeting notes"
 *   │   └── page  "Ideas"
 *   └── db-folder "Tasks"
 *       ├── db-page  "Design new landing page"
 *       ├── db-page  "Write onboarding guide"
 *       └── db-page  "Set up CI pipeline"
 */
export function seedDemoWorkspace(db: UserDbHandle, workspaceId: string): void {
  const now = Date.now();

  // ── positions ──────────────────────────────────────────────────────────────
  const wPos   = generateKeyBetween(null, null);
  const p1     = generateKeyBetween(null, null);      // welcome (first child)
  const p2     = generateKeyBetween(p1, null);        // notes folder
  const p3     = generateKeyBetween(p2, null);        // tasks db-folder
  const n1     = generateKeyBetween(null, null);      // meeting notes (first child of notes)
  const n2     = generateKeyBetween(n1, null);        // ideas
  const t1     = generateKeyBetween(null, null);      // design
  const t2     = generateKeyBetween(t1, null);        // write guide
  const t3     = generateKeyBetween(t2, null);        // ci pipeline

  // ── IDs ───────────────────────────────────────────────────────────────────
  const welcomeId       = randomUUID();
  const notesFolderId   = randomUUID();
  const meetingNotesId  = randomUUID();
  const ideasId         = randomUUID();
  const tasksFolderId   = randomUUID();
  const task1Id         = randomUUID();
  const task2Id         = randomUUID();
  const task3Id         = randomUUID();

  // ── document rows ─────────────────────────────────────────────────────────
  const docs: DocRow[] = [
    makeDoc({
      id: workspaceId, parent_id: null, type: 'workspace', position: wPos,
      properties: JSON.stringify({ title: 'My Workspace' }),
    }),
    makeDoc({
      id: welcomeId, parent_id: workspaceId, type: 'page', position: p1,
      properties: JSON.stringify({ title: '👋 Welcome to Ubimate' }),
    }),
    makeDoc({
      id: notesFolderId, parent_id: workspaceId, type: 'folder', position: p2,
      properties: JSON.stringify({ title: 'Notes' }),
    }),
    makeDoc({
      id: meetingNotesId, parent_id: notesFolderId, type: 'page', position: n1,
      properties: JSON.stringify({ title: 'Meeting notes' }),
    }),
    makeDoc({
      id: ideasId, parent_id: notesFolderId, type: 'page', position: n2,
      properties: JSON.stringify({ title: 'Ideas' }),
    }),
    makeDoc({
      id: tasksFolderId, parent_id: workspaceId, type: 'db-folder', position: p3,
      properties: JSON.stringify({ title: 'Tasks' }),
    }),
    makeDoc({
      id: task1Id, parent_id: tasksFolderId, type: 'db-page', position: t1,
      properties: JSON.stringify({ title: 'Design new landing page' }),
    }),
    makeDoc({
      id: task2Id, parent_id: tasksFolderId, type: 'db-page', position: t2,
      properties: JSON.stringify({ title: 'Write onboarding guide' }),
    }),
    makeDoc({
      id: task3Id, parent_id: tasksFolderId, type: 'db-page', position: t3,
      properties: JSON.stringify({ title: 'Set up CI pipeline' }),
    }),
  ];

  for (const doc of docs) {
    db.stmts.insertDocument.run(doc);
  }

  // ── Yjs content for the Welcome page ─────────────────────────────────────
  const welcomeUpdate = buildYjsUpdate([
    { type: 'heading', text: 'Welcome to Ubimate 👋' },
    { type: 'paragraph', text: "You're exploring a live demo workspace. Feel free to create pages, edit content, and try the editor — nothing you do here affects anyone else." },
    { type: 'paragraph', text: 'This workspace and all its content will be automatically deleted in 24 hours.' },
    { type: 'heading', text: "What you can try" },
    { type: 'paragraph', text: '📄  Pages — rich-text editor with headings, lists, code blocks, and more.' },
    { type: 'paragraph', text: '📁  Folders — organise your pages into a nested tree.' },
    { type: 'paragraph', text: '🗄️  Databases — the Tasks folder above contains database row pages.' },
    { type: 'paragraph', text: 'Create a free account to keep your work and access all features.' },
  ]);

  db.appendYjsUpdate(welcomeId, welcomeUpdate);

  // Stamp the yjs_sv_hash so initial sync recognises content as present.
  const svHash = computeHex(Y.encodeStateVector(decodeUpdateToDoc(welcomeUpdate)));
  db.stmts.updateYjsSvHash.run({ yjs_sv_hash: svHash, id: welcomeId });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function decodeUpdateToDoc(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

function computeHex(bytes: Uint8Array): string {
  // Node 18+ has crypto.createHash available; use a simple hex loop as fallback.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    // Fallback — not expected in practice.
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
