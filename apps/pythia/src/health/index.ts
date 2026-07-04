export {
  resolveHealth,
  startHealthPoller,
  POLL_INTERVAL_MS,
  HEALTH_TIMEOUT_MS,
} from "./resolver.js";
export type {
  HealthSnapshot,
  SourceHealth,
  Routing,
  ResolveHealthDeps,
  PollerOptions,
} from "./resolver.js";
