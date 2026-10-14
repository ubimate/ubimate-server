// ---------------------------------------------------------------------------
// Zero-knowledge Yjs relay — wire protocol
//
// Frame layout: first byte = type, remainder = payload. The relay never decodes
// the payload of an UPDATE/AWARE/COMPACT frame; it is an opaque encrypted blob.
// Shared here so apps/api (apps/api/src/relay.ts) and the client provider
// (apps/web/src/api/CloudRelayProvider.ts) cannot drift apart. In @ubimate/utils, not
// @ubimate/types, because the API needs it at run time: the API runs compiled under
// plain Node, which loads a package's built `dist` but not TypeScript source.
//
//   Client -> Server
//     HELLO   : [tokenLen u16 BE][token utf8][docName utf8]  auth + subscribe
//     UPDATE  : [blob]   append + broadcast
//     AWARE   : [blob]   broadcast only (never stored)
//     COMPACT : [blob]   replace this user's stored blobs with a snapshot
//     PING    : ()       liveness probe, answered with PONG
//
//   Server -> Client
//     UPDATE  : [blob]
//     AWARE   : [blob]
//     SYNCED  : ()       sent once after the initial replay completes
//     PONG    : ()       answer to PING
// ---------------------------------------------------------------------------

export const RELAY_FRAME = {
  HELLO: 0x01,
  UPDATE: 0x02,
  AWARE: 0x03,
  COMPACT: 0x04,
  SYNCED: 0x05,
  PING: 0x06,
  PONG: 0x07,
} as const;

export type RelayFrameType = (typeof RELAY_FRAME)[keyof typeof RELAY_FRAME];
