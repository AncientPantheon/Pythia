/**
 * The running Pythia service version. Surfaced at `GET /healthz` (`version`) and
 * rendered in the landing-page footer, so which build is live is verifiable at a
 * glance after a deploy. Bump this on each release.
 */
export const PYTHIA_VERSION = "1.13.0";
