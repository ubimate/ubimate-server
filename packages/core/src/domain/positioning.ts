// Fractional-index positioning. The generator lives in `@ubimate/utils` (shared
// with the client and the Rust `generate_key_between`); re-exported here so the
// domain layer is the single import surface for storage-adjacent logic.
export { generateKeyBetween } from '@ubimate/utils';
