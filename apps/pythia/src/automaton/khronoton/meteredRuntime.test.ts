import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meterChainRuntime } from "./meteredRuntime.js";
import { PythLedger } from "../../pyth/ledger.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Minimal fake ChainRuntime whose client records/echoes, so we can assert the
// wrapper meters submit/dirtyRead into the ledger without a real chain.
function fakeRuntime(opts: {
  submit?: () => Promise<{ requestKey: string }>;
  dirtyRead?: () => Promise<unknown>;
}) {
  const submit = opts.submit ?? (async () => ({ requestKey: "rk-1" }));
  const dirtyRead = opts.dirtyRead ?? (async () => ({ result: { status: "success", data: {} } }));
  return {
    Pact: { builder: { execution: () => ({}) } },
    createClient: () => ({ submit, dirtyRead, listen: async () => ({}) }),
    isSignedTransaction: () => true,
    universalSignTransaction: async () => ({}),
    calculateAutoGasLimit: (g: number) => g,
    anuToStoa: (n: number) => n,
    getPactUrl: () => "u",
    networkId: "n",
    namespace: "ns",
    gasStationAccount: "gs",
  } as unknown as Parameters<typeof meterChainRuntime>[0];
}

function fakeLedger() {
  return { recordSend: vi.fn(), recordRead: vi.fn() } as unknown as Parameters<
    typeof meterChainRuntime
  >[1] & { recordSend: ReturnType<typeof vi.fn>; recordRead: ReturnType<typeof vi.fn> };
}

const signedTx = { cmd: JSON.stringify({ meta: { gasLimit: 1500 } }), sigs: [] };

describe("meterChainRuntime", () => {
  it("counts an accepted submit as a transaction (+gasLimit) in the ledger", async () => {
    const ledger = fakeLedger();
    const client = meterChainRuntime(fakeRuntime({}), ledger).createClient("url");
    const out = await client.submit(signedTx);
    expect(out).toEqual({ requestKey: "rk-1" }); // return value passes through
    expect(ledger.recordSend).toHaveBeenCalledWith(true, 1500, 1, "pythia-self");
  });

  it("counts a REJECTED/thrown submit as a failed transaction and rethrows", async () => {
    const ledger = fakeLedger();
    const runtime = fakeRuntime({
      submit: async () => {
        throw new Error("node rejected");
      },
    });
    const client = meterChainRuntime(runtime, ledger).createClient("url");
    await expect(client.submit(signedTx)).rejects.toThrow("node rejected");
    expect(ledger.recordSend).toHaveBeenCalledWith(false, 1500, 1, "pythia-self");
  });

  it("does NOT meter a dirtyRead — Pythia's own dirty reads are not petitions (only client-served reads count)", async () => {
    const ledger = fakeLedger();
    const client = meterChainRuntime(fakeRuntime({}), ledger).createClient("url");
    const res = await client.dirtyRead(signedTx);
    expect((res as { result: { status: string } }).result.status).toBe("success"); // still passes through
    expect(ledger.recordRead).not.toHaveBeenCalled();
  });

  it("gas defaults to 0 when the tx has no parseable meta.gasLimit", async () => {
    const ledger = fakeLedger();
    const client = meterChainRuntime(fakeRuntime({}), ledger).createClient("url");
    await client.submit({ cmd: "not-json" });
    expect(ledger.recordSend).toHaveBeenCalledWith(true, 0, 1, "pythia-self");
  });

  it("metering is best-effort — a throwing ledger never breaks the submit result", async () => {
    const ledger = {
      recordSend: vi.fn(() => {
        throw new Error("ledger boom");
      }),
      recordRead: vi.fn(),
    } as unknown as Parameters<typeof meterChainRuntime>[1];
    const client = meterChainRuntime(fakeRuntime({}), ledger).createClient("url");
    await expect(client.submit(signedTx)).resolves.toEqual({ requestKey: "rk-1" });
  });

  it("attributes Pythia's own fires to the 'pythia-self' consumer in a real ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyth-metered-"));
    tmpDirs.push(dir);
    const l = new PythLedger({ filePath: join(dir, "l.json"), flushMs: 0 });
    const client = meterChainRuntime(fakeRuntime({}), l).createClient("url");
    await client.submit(signedTx);
    expect(l.byConsumer()["pythia-self"]).toEqual({
      transactions: 1,
      failedTransactions: 0,
      gasReserved: 1500,
      wastedGasReserved: 0,
    });

    const runtime = fakeRuntime({
      submit: async () => {
        throw new Error("node rejected");
      },
    });
    const failing = meterChainRuntime(runtime, l).createClient("url");
    await expect(failing.submit(signedTx)).rejects.toThrow("node rejected");
    expect(l.byConsumer()["pythia-self"].failedTransactions).toBe(1);
  });
});
