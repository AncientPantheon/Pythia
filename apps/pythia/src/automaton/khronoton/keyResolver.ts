import { randomBytes } from "node:crypto";
import { smartDecrypt } from "@stoachain/stoa-core/crypto";
import {
  kadenaDecrypt,
  kadenaGenKeypairFromSeed,
  kadenaMnemonicToSeed,
} from "@stoachain/kadena-stoic-legacy/hd-wallet";
import {
  kadenaGenKeypair as kadenaGenChainweaverKeypair,
  kadenaMnemonicToRootKeypair,
} from "@stoachain/kadena-stoic-legacy/hd-wallet/chainweaver";
import type {
  CodexSnapshot,
  IOuroAccount,
  IPureKeypair,
  IStoaChainSeed,
} from "@ancientpantheon/codex/ouronet";
import type { IKadenaKeypair, KeyResolver } from "@ancientpantheon/khronoton-core/server";
import { descriptorSourceToDisplay } from "@ancientpantheon/khronoton-core/handlers";
import type { SignerSource } from "@ancientpantheon/khronoton-core/handlers";
import type { CodexStore } from "../codexStore.js";

/**
 * The Khronoton `KeyResolver` backed by Pythia's SEALED OPERATOR CODEX (ported from
 * Mnemosyne, handoff 05) — the seam where the automaton signs with no human in the loop.
 * Per call: read the sealed snapshot + machine password from the {@link CodexStore},
 * `smartDecrypt` exactly the entry that owns the requested public key. The snapshot is
 * re-read every call (fire-time, not hot-path) so a codex edit is picked up next fire and
 * plaintext key material never outlives the call. A derived pubkey that doesn't match the
 * requested one throws instead of signing with the wrong key.
 */

function bareKey(pub: string): string {
  return pub.startsWith("k:") ? pub.slice(2) : pub;
}
const HEX_SECRET = /^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/;

/** A Kadena ed25519 public key is EXACTLY 32 bytes → 64 hex chars (bare, `k:`-prefix
 *  stripped). Nothing else is a valid Kadena signing key. */
const KADENA_PUBLIC_KEY = /^[0-9a-fA-F]{64}$/;

/** Every function in this file resolves Kadena/DALOS-curve signers only — this whole
 *  module is Khronoton's Kadena signing seam (Apollo signing has its own, separate seam:
 *  `codexApolloSigner.ts`). Pythia's operator Codex holds mixed-curve accounts: a
 *  Kadena/DALOS account's `publicKey` is a 64-hex ed25519 key; an APOLLO account's
 *  `publicKey` is Codex's own Apollo-local public key, a `<len>.<xy>` string (e.g.
 *  `9G.17Kd3B...`) — structurally nothing like a Kadena key. Only the former may ever be
 *  offered as a Kadena signer / signed with.
 *
 *  We discriminate on the KEY FORMAT ITSELF, not on Codex's `IOuroAccount.originCurve`
 *  metadata: a v2.7.7 fix filtered on `originCurve !== "apollo"`, but real Codex-generated
 *  Apollo accounts in the field do NOT reliably carry that field set, so the Apollo keys
 *  still leaked into the Builder's Kadena signing-key picker (confirmed live, 2026-08-02).
 *  The 64-hex shape is the actual on-chain requirement and is populated on every account
 *  by construction, so it's the robust discriminator — no dependence on optional metadata. */
function isKadenaPublicKey(publicKey: string): boolean {
  return KADENA_PUBLIC_KEY.test(bareKey(publicKey));
}

function loadSnapshot(codex: CodexStore): CodexSnapshot {
  const backup = codex.loadBackup();
  if (backup === null) {
    throw new Error(
      "khronoton key resolver: Pythia's operator codex is not initialized — populate it " +
        "under /admin (Codex) before scheduling signed transactions.",
    );
  }
  return JSON.parse(backup) as CodexSnapshot;
}

const pures = (s: CodexSnapshot): IPureKeypair[] => (Array.isArray(s.pureKeypairs) ? s.pureKeypairs : []);
const ouros = (s: CodexSnapshot): IOuroAccount[] => (Array.isArray(s.ouroAccounts) ? s.ouroAccounts : []);
const seeds = (s: CodexSnapshot): IStoaChainSeed[] => (Array.isArray(s.kadenaSeeds) ? s.kadenaSeeds : []);

function assertHexSecret(plaintext: string, origin: string): string {
  if (HEX_SECRET.test(plaintext)) return plaintext;
  throw new Error(
    `khronoton key resolver: decrypted ${origin} secret is not a raw hex key — the codex ` +
      "entry shape has drifted; refusing to sign.",
  );
}

/** Whether a seed derives through Chainweaver's BIP32-Ed25519 (WASM) scheme rather
 *  than the koala SLIP-10 path. */
function isChainweaverSeed(seed: IStoaChainSeed): boolean {
  return seed.seedType === "chainweaver" || seed.seedType === "eckowallet";
}

/** Re-derive a seed account's keypair at its recorded index; the derived pubkey MUST
 * equal the requested one (a mismatch throws).
 *
 * SEEDTYPE-AWARE (fixed v2.7.13): the derivation MUST match how Codex RECORDED the
 * account's public key, which Codex routes on `seedType` (its
 * `KadenaWalletBuilder.createWalletPairFromMnemonic`):
 *   - `koala` (24-word BIP39)               → SLIP-10 Ed25519, path `m'/44'/626'/idx'`
 *     via `kadenaMnemonicToSeed`+`kadenaGenKeypairFromSeed`.
 *   - `chainweaver`/`eckowallet` (12-word)  → Chainweaver BIP32-Ed25519 (WASM) via
 *     `kadenaMnemonicToRootKeypair`+`kadenaGenChainweaverKeypair`.
 * Both produce a PASSWORD-INDEPENDENT public key (verified), so re-deriving with a
 * fresh transient password reproduces exactly the pubkey Codex stored. Before this
 * fix `fromSeedAccount` always used the koala path, so a chainweaver/eckowallet seed
 * re-derived a DIFFERENT key at the same index and this function refused to sign
 * ("derived a different key at index N than the codex recorded") — the exact live
 * failure signing with the operator's "Pythia" (chainweaver) gas-payer seed. */
async function fromSeedAccount(
  seed: IStoaChainSeed,
  accountIndex: number,
  wantedPub: string,
  codexPassword: string,
): Promise<IKadenaKeypair> {
  const mnemonic = await smartDecrypt(seed.secret, codexPassword);
  const tempPassword = randomBytes(32).toString("base64"); // transient, never persisted.

  let derivedPub: string;
  let encSecret: string;
  if (isChainweaverSeed(seed)) {
    const root = await kadenaMnemonicToRootKeypair(tempPassword, mnemonic);
    const kp = await kadenaGenChainweaverKeypair(tempPassword, root, accountIndex);
    derivedPub = kp.publicKey;
    encSecret = kp.secretKey;
  } else {
    const encSeed = await kadenaMnemonicToSeed(tempPassword, mnemonic);
    [derivedPub, encSecret] = await kadenaGenKeypairFromSeed(tempPassword, encSeed, accountIndex);
  }

  if (bareKey(derivedPub) !== wantedPub) {
    throw new Error(
      `khronoton key resolver: seed "${seed.name ?? seed.id}" derived a different key at index ` +
        `${accountIndex} than the codex recorded — refusing to sign.`,
    );
  }
  if (isChainweaverSeed(seed)) {
    // Chainweaver's extended key isn't a plain 32-byte Ed25519 secret — signing
    // routes through the WASM path using `encryptedSecretKey` + `password`, never a
    // decrypted hex (see Codex's own `KadenaWalletBuilder`/headless resolver).
    return { publicKey: wantedPub, privateKey: "", seedType: seed.seedType, encryptedSecretKey: encSecret, password: tempPassword };
  }
  const raw = await kadenaDecrypt(tempPassword, encSecret);
  return { publicKey: wantedPub, privateKey: Buffer.from(raw).toString("hex"), seedType: seed.seedType };
}

/** The sealed-codex-backed resolver the engine (tick loop + handlers) injects. */
export function createPythiaKeyResolver(codex: CodexStore): KeyResolver {
  return {
    async listCodexPubs(): Promise<Set<string>> {
      const snap = loadSnapshot(codex);
      const set = new Set<string>();
      for (const kp of pures(snap)) set.add(bareKey(kp.publicKey));
      for (const acc of ouros(snap)) if (acc.publicKey && isKadenaPublicKey(acc.publicKey)) set.add(bareKey(acc.publicKey));
      for (const seed of seeds(snap)) for (const acc of seed.accounts ?? []) set.add(bareKey(acc.publicKey));
      return set;
    },

    async getKeyPairByPublicKey(publicKey: string): Promise<IKadenaKeypair> {
      const wanted = bareKey(publicKey);
      const snap = loadSnapshot(codex);
      const codexPassword = codex.getOrCreateCodexPassword();

      const pure = pures(snap).find((kp) => bareKey(kp.publicKey) === wanted);
      if (pure) {
        const plaintext = await smartDecrypt(pure.encryptedPrivateKey, codexPassword);
        return { publicKey: wanted, privateKey: assertHexSecret(plaintext, "pure-keypair"), seedType: "koala" };
      }
      const ouro = ouros(snap).find(
        (acc) => acc.publicKey && isKadenaPublicKey(acc.publicKey) && bareKey(acc.publicKey) === wanted,
      );
      if (ouro) {
        const plaintext = await smartDecrypt(ouro.secret, codexPassword);
        return { publicKey: wanted, privateKey: assertHexSecret(plaintext, "ouro-account"), seedType: "koala" };
      }
      for (const seed of seeds(snap)) {
        const account = (seed.accounts ?? []).find((a) => bareKey(a.publicKey) === wanted);
        if (account) return fromSeedAccount(seed, account.index, wanted, codexPassword);
      }
      throw new Error(`khronoton key resolver: public key ${wanted} is not held by Pythia's operator codex.`);
    },
  };
}

/** The Builder's signer-picker source (secret-free — only public keys leave). */
export function createPythiaSignerSource(codex: CodexStore): SignerSource {
  return {
    async listSignerDescriptors() {
      const snap = loadSnapshot(codex);
      const seen = new Set<string>();
      const descriptors: { publicKey: string; display: "derived" | "foreign" }[] = [];
      const push = (publicKey: string, source: string): void => {
        const pub = bareKey(publicKey);
        if (seen.has(pub)) return;
        seen.add(pub);
        descriptors.push({ publicKey: pub, display: descriptorSourceToDisplay(source) });
      };
      for (const seed of seeds(snap)) for (const acc of seed.accounts ?? []) push(acc.publicKey, "seed");
      for (const kp of pures(snap)) push(kp.publicKey, "pure");
      for (const acc of ouros(snap)) if (acc.publicKey && isKadenaPublicKey(acc.publicKey)) push(acc.publicKey, "ouro");
      return descriptors;
    },
  };
}
