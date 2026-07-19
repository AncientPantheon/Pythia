// Browser polyfills injected into every bundled module so `@stoachain/*` crypto
// (which reaches for Node's Buffer) works in the codex-ui island. esbuild `inject`
// makes these named exports available wherever the identifier is referenced.
import { Buffer as BufferPolyfill } from "buffer";
export { BufferPolyfill as Buffer };
