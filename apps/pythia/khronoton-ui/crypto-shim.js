// Browser shim for Node's `crypto`, aliased in by esbuild for the island bundles.
// The khronoton-core shared chunk reaches for `createHash` (server-side capability
// hashing) and `randomUUID`. `createHash` comes from crypto-browserify; `randomUUID`
// comes from the browser's Web Crypto — both real, so any UI path that touches them
// works rather than crashing on a missing Node builtin.
import cryptoBrowserify from "crypto-browserify";

const randomUUID = () => globalThis.crypto.randomUUID();

export const createHash = cryptoBrowserify.createHash;
export const randomBytes = cryptoBrowserify.randomBytes;
export { randomUUID };
export default { ...cryptoBrowserify, randomUUID };
