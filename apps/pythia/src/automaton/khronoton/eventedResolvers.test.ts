import { describe, it, expect } from "vitest";
import {
  isEventedResolver,
  enforceEventedScheduleless,
  EVENTED_SERVER_RESOLVERS,
} from "./eventedResolvers.js";
import { DUAL_LINK_ACTIVATE_RESOLVER } from "./dualLinkActivateResolver.js";
import { PYTH_FLUSH_RESOLVER } from "./pythFlushResolver.js";

describe("evented server resolvers", () => {
  it("classifies dual-link-activate as evented and pyth-flush as scheduled", () => {
    expect(isEventedResolver(DUAL_LINK_ACTIVATE_RESOLVER)).toBe(true);
    expect(EVENTED_SERVER_RESOLVERS.has(DUAL_LINK_ACTIVATE_RESOLVER)).toBe(true);
    // pyth-flush is schedule-driven — it must NOT be evented (keeps its schedule).
    expect(isEventedResolver(PYTH_FLUSH_RESOLVER)).toBe(false);
    expect(isEventedResolver("something-else")).toBe(false);
    expect(isEventedResolver(undefined)).toBe(false);
    expect(isEventedResolver(123)).toBe(false);
  });

  it("forces a commit bound to an evented resolver to be scheduleless (externalFireable)", () => {
    const body = {
      name: "activate",
      envelope: {
        pactCode: "(…A_LinkDualApiKey …)",
        serverResolver: DUAL_LINK_ACTIVATE_RESOLVER,
        externalFireable: false, // even if the UI sent a scheduled config…
      },
      schedule: { mode: "interval", config: { seconds: 120 } },
    };
    enforceEventedScheduleless(body);
    // …scheduling is turned OFF: externalFireable is forced true (→ next_fire_at NULL).
    expect(body.envelope.externalFireable).toBe(true);
  });

  it("leaves a schedule-driven resolver's commit untouched (pyth-flush keeps its schedule)", () => {
    const body = {
      envelope: { serverResolver: PYTH_FLUSH_RESOLVER, externalFireable: false },
      schedule: { mode: "cron", config: { expr: "0 0 * * *" } },
    };
    enforceEventedScheduleless(body);
    expect(body.envelope.externalFireable).toBe(false); // unchanged — stays scheduled
  });

  it("passes through a body with no envelope / no server resolver", () => {
    expect(() => enforceEventedScheduleless(undefined)).not.toThrow();
    expect(() => enforceEventedScheduleless({})).not.toThrow();
    const plain = { envelope: { serverResolver: undefined } };
    enforceEventedScheduleless(plain);
    expect((plain.envelope as { externalFireable?: boolean }).externalFireable).toBeUndefined();
  });
});
