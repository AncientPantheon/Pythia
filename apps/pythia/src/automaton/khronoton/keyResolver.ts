import { randomBytes } from "node:crypto";
import { smartDecrypt } from "@stoachain/stoa-core/crypto";
import {
  kadenaDecrypt,
  kadenaGenKeypairFromSeed,
  kadenaMnemonicToSeed,
} from "@stoachain/kadena-stoic-legacy/hd-wallet";
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

/** Re-derive a seed account's keypair at its recorded index; the derived pubkey MUST
 * equal the requested one (a mismatch throws). */
async function fromSeedAccount(
  seed: IStoaChainSeed,
  accountIndex: number,
  wantedPub: string,
  codexPassword: string,
): Promise<IKadenaKeypair> {
  const mnemonic = await smartDecrypt(seed.secret, codexPassword);
  const tempPassword = randomBytes(32).toString("base64"); // transient, never persisted.
  const encSeed = await kadenaMnemonicToSeed(tempPassword, mnemonic);
  const [derivedPub, encSecret] = await kadenaGenKeypairFromSeed(tempPassword, encSeed, accountIndex);
  if (bareKey(derivedPub) !== wantedPub) {
    throw new Error(
      `khronoton key resolver: seed "${seed.name ?? seed.id}" derived a different key at index ` +
        `${accountIndex} than the codex recorded — refusing to sign.`,
    );
  }
  if (seed.seedType === "chainweaver" || seed.seedType === "eckowallet") {
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
      for (const acc of ouros(snap)) if (acc.publicKey) set.add(bareKey(acc.publicKey));
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
      const ouro = ouros(snap).find((acc) => acc.publicKey && bareKey(acc.publicKey) === wanted);
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
      for (const acc of ouros(snap)) if (acc.publicKey) push(acc.publicKey, "ouro");
      return descriptors;
    },
  };
}
