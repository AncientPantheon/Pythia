/**
 * Pythia's public EGRESS IP — the address the hub must allowlist for the signed
 * feed/usage calls. Surfaced in the admin UI so the operator always knows the
 * current value (in case the VPS egress ever changes and the hub allowlist needs
 * updating). Detected from a public IP echo, cached, with a `PYTHIA_EGRESS_IP`
 * env override for air-gapped/known deployments.
 */
let cached: string | null = process.env.PYTHIA_EGRESS_IP?.trim() || null;

/** The last-known egress IP (or null until first detection). Synchronous. */
export function cachedEgressIp(): string | null {
  return cached;
}

/**
 * Detect and cache the public egress IP. Honors `PYTHIA_EGRESS_IP` if set. On any
 * failure keeps the last-known value. Safe to call at boot and on admin refresh.
 */
export async function detectEgressIp(): Promise<string | null> {
  const override = process.env.PYTHIA_EGRESS_IP?.trim();
  if (override) {
    cached = override;
    return cached;
  }
  try {
    const res = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (ip) cached = ip;
    }
  } catch {
    // keep the last-known value
  }
  return cached;
}
