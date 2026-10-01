// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

/**
 * The document event stream's broadcasts (lib/documentEvents.ts): each goes to the user's own clients
 * only, and `content-changed` is throttled — the first at once, the rest gathered into one.
 */
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function client() {
  const events: { event: string; data: string }[] = [];
  const res = {
    write: (chunk: string) => {
      const [event, data] = chunk.trim().split('\n').map((line) => line.slice(line.indexOf(': ') + 2));
      events.push({ event, data });
      return true;
    },
  } as unknown as Response;
  return { res, events };
}

describe('document events', () => {
  let events: typeof import('../lib/documentEvents');
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    events = await import('../lib/documentEvents');
  });
  afterEach(() => vi.useRealTimers());

  it('sends tree-changed to every client of the user, and to no one else', () => {
    const a = client();
    const b = client();
    const other = client();
    events.addDocumentEventClient('u1', a.res);
    events.addDocumentEventClient('u1', b.res);
    events.addDocumentEventClient('u2', other.res);
    events.broadcastTreeChanged('u1');
    expect(a.events).toEqual([{ event: 'tree-changed', data: '{}' }]);
    expect(b.events).toEqual([{ event: 'tree-changed', data: '{}' }]);
    expect(other.events).toEqual([]);
  });

  it('announces a content change at once, and gathers those that follow within the window into one', () => {
    const a = client();
    events.addDocumentEventClient('u1', a.res);
    events.broadcastContentChanged('u1', 'd1');
    expect(a.events).toEqual([{ event: 'content-changed', data: '{"ids":["d1"]}' }]);
    events.broadcastContentChanged('u1', 'd2');
    events.broadcastContentChanged('u1', 'd3');
    events.broadcastContentChanged('u1', 'd2');
    expect(a.events).toHaveLength(1);
    vi.advanceTimersByTime(events.CONTENT_EVENT_THROTTLE_MS);
    expect(a.events[1]).toEqual({ event: 'content-changed', data: '{"ids":["d2","d3"]}' });
    // A change after a quiet window goes out at once again.
    vi.advanceTimersByTime(events.CONTENT_EVENT_THROTTLE_MS);
    events.broadcastContentChanged('u1', 'd4');
    expect(a.events[2]).toEqual({ event: 'content-changed', data: '{"ids":["d4"]}' });
  });

  it('stops sending to a client once removed', () => {
    const a = client();
    const remove = events.addDocumentEventClient('u1', a.res);
    remove();
    events.broadcastTreeChanged('u1');
    events.broadcastContentChanged('u1', 'd1');
    expect(a.events).toEqual([]);
  });
});
