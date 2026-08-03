import { describe, it, expect, vi } from "vitest";
import { meterChainRuntime } from "./meteredRuntime.js";

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
    expect(ledger.recordSend).toHaveBeenCalledWith(true, 1500, 1);
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
    expect(ledger.recordSend).toHaveBeenCalledWith(false, 1500, 1);
  });

  it("counts a dirtyRead as a petition (recordRead with positive pondus)", async () => {
    const ledger = fakeLedger();
    const client = meterChainRuntime(fakeRuntime({}), ledger).createClient("url");
    const res = await client.dirtyRead(signedTx);
    expect((res as { result: { status: string } }).result.status).toBe("success"); // passthrough
    expect(ledger.recordRead).toHaveBeenCalledTimes(1);
    expect(ledger.recordRead.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it("gas defaults to 0 when the tx has no parseable meta.gasLimit", async () => {
    const ledger = fakeLedger();
    const client = meterChainRuntime(fakeRuntime({}), ledger).createClient("url");
    await client.submit({ cmd: "not-json" });
    expect(ledger.recordSend).toHaveBeenCalledWith(true, 0, 1);
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
});
