import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythLedger } from "./ledger.js";

const tmpDirs: string[] = [];
function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyth-ledger-"));
  tmpDirs.push(dir);
  return join(dir, "ledger.json");
}
function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function make(clock = fixedClock("2026-07-05T10:00:00.000Z"), filePath = scratchFile()) {
  return new PythLedger({ filePath, flushMs: 0, clock });
}

describe("PythLedger", () => {
  it("records reads as petitions + summed pondus", () => {
    const l = make();
    l.recordRead(10);
    l.recordRead(363.553);
    const t = l.total();
    expect(t.petitions).toBe(2);
    expect(t.pondus).toBe(373.553);
  });

  it("splits accepted vs rejected sends into tx/gas vs failed/wasted", () => {
    const l = make();
    l.recordSend(true, 1500);
    l.recordSend(true, 500);
    l.recordSend(false, 800);
    const t = l.total();
    expect(t.transactions).toBe(2);
    expect(t.gasReserved).toBe(2000);
    expect(t.failedTransactions).toBe(1);
    expect(t.wastedGasReserved).toBe(800);
  });

  it("aggregates across days; total = sum of the daily deltas", () => {
    let iso = "2026-07-05T10:00:00.000Z";
    const l = new PythLedger({ filePath: scratchFile(), flushMs: 0, clock: () => new Date(iso) });
    l.recordRead(10); // day 05
    iso = "2026-07-06T10:00:00.000Z";
    l.recordRead(20); // day 06
    l.recordSend(true, 500); // day 06

    const daily = l.daily();
    expect(daily.map((d) => d.day)).toEqual(["2026-07-05", "2026-07-06"]);
    expect(daily[0].petitions).toBe(1);
    expect(daily[1].petitions).toBe(1);
    expect(daily[1].transactions).toBe(1);

    const t = l.total();
    expect(t.petitions).toBe(2);
    expect(t.pondus).toBe(30);
    expect(t.gasReserved).toBe(500);
  });

  it("nuke resets everything to zero", () => {
    const l = make();
    l.recordRead(10);
    l.recordSend(true, 100);
    l.nuke();
    const t = l.total();
    expect(t.petitions).toBe(0);
    expect(t.transactions).toBe(0);
    expect(t.gasReserved).toBe(0);
    expect(l.daily()).toHaveLength(0);
  });

  it("persists and reloads across instances", () => {
    const file = scratchFile();
    const a = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    a.recordRead(42);
    a.recordSend(true, 999);
    a.persist();

    const b = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-05T10:00:00.000Z") });
    const t = b.total();
    expect(t.petitions).toBe(1);
    expect(t.pondus).toBe(42);
    expect(t.gasReserved).toBe(999);
  });

  it("rounds the pondus total to <=3 decimals", () => {
    const l = make();
    l.recordRead(0.0001);
    l.recordRead(0.0001);
    expect(l.total().pondus).toBe(0); // 0.0002 → 0.000
  });

  it("loads an old-format file with no generation field as generation 0 (backward compatible with the live pre-fix ledger file)", () => {
    const file = scratchFile();
    writeFileSync(
      file,
      JSON.stringify({
        days: {
          "2026-07-21": {
            petitions: 1,
            pondus: 5,
            transactions: 0,
            gasReserved: 0,
            failedTransactions: 0,
            wastedGasReserved: 0,
          },
        },
      }),
    );
    const l = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:00:00.000Z") });
    expect(l.total().petitions).toBe(1);
    // A subsequent ordinary persist() (disk generation 0 == our generation 0) must
    // still write normally, not be treated as stale.
    l.recordRead(2);
    l.persist();
    const b = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:00:00.000Z") });
    expect(b.total().petitions).toBe(2);
  });
});

describe("PythLedger — nuke/deploy generation race", () => {
  // Reproduces the exact production bug: a blue-green deploy's INCOMING container
  // boots (loading the ledger into its own memory) up to ~60s before Caddy cuts
  // traffic over to it (deploy/host/pythia-deploy.sh, health-check window). If an
  // admin's "Nuke" click lands on the OUTGOING container in that window (Caddy is
  // still routing to it), the incoming container's own eventual persist() — its 30s
  // timer, a served request, or its shutdown flush — used to blindly overwrite the
  // just-nuked file with its own stale pre-nuke snapshot, silently resurrecting
  // "nuked" data. See docs/work/pyth-ledger-nuke-race/ (or the nuke()/persist() doc
  // comments) for the full writeup.
  it("a stale sibling process self-heals on its own next persist() instead of clobbering a Nuke", () => {
    const file = scratchFile();

    // The OUTGOING container: already live, has real accumulated activity, persisted.
    const outgoing = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:00:00.000Z") });
    outgoing.recordRead(30.221);
    outgoing.persist();

    // The INCOMING container boots WHILE `outgoing` is still serving (the health-check
    // window) — it loads the SAME pre-nuke state into its own, separate memory.
    const incoming = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:05:00.000Z") });
    expect(incoming.total().petitions).toBe(1); // confirms it loaded the pre-nuke state

    // The admin clicks Nuke — Caddy hasn't cut over yet, so it lands on `outgoing`.
    outgoing.nuke();
    expect(outgoing.total().petitions).toBe(0);

    // Caddy now cuts traffic to `incoming`. Its first persist() (a request, its 30s
    // timer, or its eventual shutdown flush) must detect the generation bump and
    // self-heal (reload) instead of blindly re-persisting its stale snapshot.
    incoming.persist();

    // A third instance — the NEXT deploy's fresh container — must see the nuke, not
    // `incoming`'s resurrected stale total.
    const verify = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:10:00.000Z") });
    expect(verify.total().petitions).toBe(0);
    expect(verify.daily()).toHaveLength(0);
  });

  it("a stale sibling's own new activity recorded before it self-heals is lost, not merged — an accepted, documented trade-off vs. resurrecting nuked history", () => {
    const file = scratchFile();
    const outgoing = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:00:00.000Z") });
    outgoing.persist();
    const incoming = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:05:00.000Z") });
    outgoing.nuke();
    incoming.recordRead(99); // real traffic the stale sibling served post-cutover, pre-heal
    incoming.persist(); // self-heals: reloads the nuked state, discarding the above
    expect(incoming.total().petitions).toBe(0);
  });

  it("persist() writes normally (no self-heal, no data loss) when there is no staleness", () => {
    const file = scratchFile();
    const l = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:00:00.000Z") });
    l.recordRead(7);
    l.persist();
    l.recordRead(3);
    l.persist();
    expect(l.total().petitions).toBe(2);
    const reloaded = new PythLedger({ filePath: file, flushMs: 0, clock: fixedClock("2026-07-21T10:00:00.000Z") });
    expect(reloaded.total().petitions).toBe(2);
  });
});

// A mutable-clock ledger for driving multi-day flush scenarios.
function mkAt(iso: string): { l: PythLedger; set: (i: string) => void } {
  let cur = iso;
  const l = new PythLedger({ filePath: scratchFile(), flushMs: 0, clock: () => new Date(cur) });
  return { l, set: (i) => (cur = i) };
}

describe("PythLedger — Khronoton flush (drain model)", () => {
  it("beginFlush yields PythFlushEntry objects: integer day ordinal (epoch 2026-07-21), kebab keys, iz-complete derived", () => {
    const { l, set } = mkAt("2026-07-21T08:00:00.000Z"); // day 1
    l.recordRead(10);
    set("2026-07-22T08:00:00.000Z"); // day 2
    l.recordSend(true, 500);
    set("2026-07-23T08:00:00.000Z"); // day 3 (today)
    l.recordRead(5);

    const { entries } = l.beginFlush();
    expect(entries.map((e) => e.day)).toEqual([1, 2, 3]); // oldest-first, integer ordinals
    expect(entries.map((e) => e["iz-complete"])).toEqual([true, true, false]); // past done, today open
    // exact Pact schema shape (kebab keys) on the last entry
    expect(entries[2]).toEqual({
      day: 3,
      "iz-complete": false,
      petitions: 1,
      pondus: 5,
      transactions: 0,
      "gas-reserved": 0,
      "failed-transactions": 0,
      "wasted-gas-reserved": 0,
    });
  });

  it("beginFlush does NOT mutate the ledger; commitFlush drains exactly what was sent", () => {
    const { l } = mkAt("2026-07-23T08:00:00.000Z");
    l.recordRead(10);
    const { token } = l.beginFlush();
    expect(l.total().petitions).toBe(1); // untouched by beginFlush
    l.commitFlush(token);
    expect(l.total().petitions).toBe(0); // drained
    expect(l.unflushedDayCount()).toBe(0);
  });

  it("preserves traffic that arrives between snapshot and commit (subtract, not delete)", () => {
    const { l } = mkAt("2026-07-23T08:00:00.000Z");
    l.recordRead(10); // pondus 10, 1 petition
    const { token } = l.beginFlush(); // snapshot: 1 petition / pondus 10
    l.recordRead(4); // arrives mid-flush: now 2 petitions / pondus 14
    l.commitFlush(token); // drain the snapshot (1 / 10)
    const t = l.total();
    expect(t.petitions).toBe(1); // the mid-flush read survives
    expect(t.pondus).toBe(4);
  });

  it("a failed flush (beginFlush without commit) leaves everything to retry", () => {
    const { l } = mkAt("2026-07-23T08:00:00.000Z");
    l.recordRead(10);
    l.beginFlush(); // fire failed → no commit
    expect(l.total().petitions).toBe(1); // still there
    const again = l.beginFlush(); // next tick re-sends
    expect(again.entries[0].petitions).toBe(1);
  });

  it("caps the batch at maxDays (oldest-first); the rest stay for the next tick", () => {
    const { l, set } = mkAt("2026-07-21T08:00:00.000Z");
    l.recordRead(1);
    set("2026-07-22T08:00:00.000Z");
    l.recordRead(1);
    set("2026-07-23T08:00:00.000Z");
    l.recordRead(1);
    const { entries, token } = l.beginFlush(2); // cap 2
    expect(entries.map((e) => e.day)).toEqual([1, 2]);
    l.commitFlush(token);
    expect(l.unflushedDayCount()).toBe(1); // day 3 remains
    expect(l.beginFlush().entries.map((e) => e.day)).toEqual([3]);
  });

  it("previewEntries mirrors beginFlush without mutating (the admin monitor)", () => {
    const { l } = mkAt("2026-07-23T08:00:00.000Z");
    l.recordRead(10);
    const preview = l.previewEntries();
    expect(preview).toEqual(l.beginFlush().entries); // same content
    expect(l.total().petitions).toBe(1); // no drain
  });

  it("excludes pre-epoch buckets (day < 1 is not flushable on-chain)", () => {
    const { l, set } = mkAt("2026-07-20T08:00:00.000Z"); // ordinal 0 — before epoch
    l.recordRead(9);
    set("2026-07-21T08:00:00.000Z"); // ordinal 1
    l.recordRead(3);
    const { entries } = l.beginFlush();
    expect(entries.map((e) => e.day)).toEqual([1]); // the day-0 bucket is not sent
  });
});
