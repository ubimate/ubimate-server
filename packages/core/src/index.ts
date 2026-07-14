// @ubimate/core — runtime-agnostic domain + storage contract shared by the
// cloud API (better-sqlite3) and the local backend (webview worker).
//
// - storage: the SQLite schema/migrations, compaction policy, and the
//   encryption-agnostic `StoragePort` contract.
// - domain: content-adjacent pure logic (positioning, compaction policy).
export * from './storage';
export * from './domain';
