/** Default bind port when `PORT` is not set. Mirrors the Dockerfile `EXPOSE`
 * and the `PORT` env contract documented in DEPLOY.md. */
export const DEFAULT_PORT = 8080;

/**
 * Resolve the server bind port from the environment. Returns the parsed `PORT`
 * when it is a positive integer; otherwise falls back to {@link DEFAULT_PORT} —
 * an unset, empty, non-numeric, zero, or negative `PORT` must not bind an
 * invalid port, it uses the documented default.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}
