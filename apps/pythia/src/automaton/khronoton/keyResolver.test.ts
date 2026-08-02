import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { encryptStringV2 } from "@stoachain/stoa-core/crypto";
import type { IOuroAccount } from "@ancientpantheon/codex/ouronet";
import { ensureSodiumReady, parseMasterKey } from "../../codex/vault.js";
import { SealedStore } from "../../codex/sealedStore.js";
import { CodexStore } from "../codexStore.js";
import { seedCodexWithRealPair } from "../codexApolloFixtures.js";
import { createPythiaKeyResolver, createPythiaSignerSource } from "./keyResolver.js";

// Lives in `automaton/khronoton/` — inside the `keyless-invariant.test.ts` directory
// exemption (same rationale as `codexApolloFixtures.ts`'s own doc comment), which is
// why this file may import `encryptStringV2` directly to build a realistic Kadena-
// curve codex fixture (no shared helper exists for one — `codexApolloFixtures.ts`
// only ever built Apollo-curve pairs).

const KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const KADENA_PUBKEY = "864fa7a0f0cee797a0ef048bc67c3966ac246e79ece644f5259d16c69dc5b197";
// Deterministic length (64 hex chars, matching keyResolver.ts's own HEX_SECRET check) —
// generated, not hand-typed, so a transcription slip can never silently produce a
// wrong-length string that fails for an unrelated reason.
const KADENA_SECRET = randomBytes(32).toString("hex");
const tmpDirs: string[] = [];

beforeAll(async () => {
  await ensureSodiumReady();
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeCodex(): CodexStore {
  const dir = mkdtempSync(join(tmpdir(), "pyth-keyresolver-"));
  tmpDirs.push(dir);
  return new CodexStore(new SealedStore({ dir, keyProvider: () => parseMasterKey(KEY) }));
}

// A real Apollo-format public key (`<len>.<xy>`, e.g. the exact shape the live Builder
// signing-key picker showed leaking) — NOT 64-hex. `createPythia*` must exclude any
// account whose `publicKey` looks like this, regardless of metadata.
const APOLLO_FORMAT_PUBKEY = "9G.17Kd3BJuvMaocH5g6v5GMdKa6vejnH23Lqmotlpeas8Aluiqzmsbdwoo4jJJlw9e0xtGce2vcyfwKsc5xk267";

/** Merges an `ouroAccounts` entry into whatever the codex already holds (read-then-write —
 *  unlike `seedCodexWithRealPair`, which OVERWRITES the whole snapshot). `omitOriginCurve`
 *  reproduces the live-field bug: a real Codex-generated Apollo account whose `originCurve`
 *  is NOT set, so the old metadata-based filter (`originCurve !== "apollo"`) let it through
 *  — the format-based filter must catch it via `publicKey` shape alone. */
async function seedOuroAccount(
  codex: CodexStore,
  opts: { id: string; publicKey: string; secret: string; originCurve?: "dalos" | "apollo" },
): Promise<void> {
  const codexPassword = codex.getOrCreateCodexPassword();
  const backup = codex.loadBackup();
  const snap = backup ? JSON.parse(backup) : { ouroAccounts: [] };
  const account = {
    id: opts.id,
    version: "1.0",
    isSmart: false,
    address: opts.publicKey.includes(".") ? opts.publicKey : `k:${opts.publicKey}`,
    guard: null,
    stoaChainLedger: null,
    publicKey: opts.publicKey,
    secret: await encryptStringV2(opts.secret, codexPassword),
    backup: "",
    ...(opts.originCurve ? { originCurve: opts.originCurve } : {}),
  } as IOuroAccount;
  snap.ouroAccounts = [...(Array.isArray(snap.ouroAccounts) ? snap.ouroAccounts : []), account];
  codex.saveBackup(JSON.stringify(snap));
}

async function seedKadenaOuroAccount(codex: CodexStore): Promise<void> {
  await seedOuroAccount(codex, { id: "test-kadena-ouro", publicKey: KADENA_PUBKEY, secret: KADENA_SECRET });
}

describe("createPythiaSignerSource — Kadena-only filtering", () => {
  it("lists a Kadena ouro account but excludes Apollo-format ones (by publicKey shape)", async () => {
    const codex = makeCodex();
    // seedCodexWithRealPair's own saveBackup() OVERWRITES the whole snapshot (it
    // doesn't merge) — it must run FIRST; seedKadenaOuroAccount reads-then-merges, so
    // it's the one that has to run second to end up with BOTH kinds present.
    const pair = await seedCodexWithRealPair(codex); // two Apollo-format ouro accounts
    await seedKadenaOuroAccount(codex);

    const descriptors = await createPythiaSignerSource(codex).listSignerDescriptors();
    const pubs = descriptors.map((d) => d.publicKey);

    expect(pubs).toContain(KADENA_PUBKEY);
    expect(pubs).not.toContain(pair.standardPublicKey);
    expect(pubs).not.toContain(pair.smartPublicKey);
  });

  it("excludes an Apollo-format account even when originCurve metadata is ABSENT (the live-field bug — filters on publicKey shape, not metadata)", async () => {
    const codex = makeCodex();
    await seedKadenaOuroAccount(codex);
    // An Apollo-format publicKey with NO originCurve field — the exact shape the old
    // metadata-based (`originCurve !== "apollo"`) filter let slip through into the live
    // Builder signing-key picker.
    await seedOuroAccount(codex, {
      id: "test-apollo-no-metadata",
      publicKey: APOLLO_FORMAT_PUBKEY,
      secret: randomBytes(32).toString("hex"),
    });

    const pubs = (await createPythiaSignerSource(codex).listSignerDescriptors()).map((d) => d.publicKey);
    expect(pubs).toContain(KADENA_PUBKEY);
    expect(pubs).not.toContain(APOLLO_FORMAT_PUBKEY);
  });

  it("returns an empty list when Codex holds nothing but Apollo-format accounts", async () => {
    const codex = makeCodex();
    await seedCodexWithRealPair(codex);

    const descriptors = await createPythiaSignerSource(codex).listSignerDescriptors();
    expect(descriptors).toHaveLength(0);
  });
});

describe("createPythiaKeyResolver — Kadena-only filtering", () => {
  it("listCodexPubs() excludes Apollo-format ouro accounts (including ones with no originCurve metadata)", async () => {
    const codex = makeCodex();
    // Same overwrite-vs-merge ordering constraint as the SignerSource tests above.
    const pair = await seedCodexWithRealPair(codex);
    await seedKadenaOuroAccount(codex);
    await seedOuroAccount(codex, {
      id: "test-apollo-no-metadata",
      publicKey: APOLLO_FORMAT_PUBKEY,
      secret: randomBytes(32).toString("hex"),
    });

    const pubs = await createPythiaKeyResolver(codex).listCodexPubs();
    expect(pubs.has(KADENA_PUBKEY)).toBe(true);
    expect(pubs.has(pair.standardPublicKey)).toBe(false);
    expect(pubs.has(pair.smartPublicKey)).toBe(false);
    expect(pubs.has(APOLLO_FORMAT_PUBKEY)).toBe(false);
  });

  it("getKeyPairByPublicKey() still signs with a real Kadena ouro account", async () => {
    const codex = makeCodex();
    await seedKadenaOuroAccount(codex);

    const keypair = await createPythiaKeyResolver(codex).getKeyPairByPublicKey(KADENA_PUBKEY);
    expect(keypair.publicKey).toBe(KADENA_PUBKEY);
    expect(keypair.privateKey).toBe(KADENA_SECRET);
  });

  it("getKeyPairByPublicKey() rejects an Apollo-format account's public key as not held (never attempts to decrypt it as a Kadena key)", async () => {
    const codex = makeCodex();
    const pair = await seedCodexWithRealPair(codex);

    await expect(createPythiaKeyResolver(codex).getKeyPairByPublicKey(pair.standardPublicKey)).rejects.toThrow(
      /not held by Pythia's operator codex/,
    );
  });
});
