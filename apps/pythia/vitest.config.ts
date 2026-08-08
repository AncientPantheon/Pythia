import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // The suite does real Schnorr / HD-wallet seed derivation (koala 24-word,
    // chainweaver 12-word) which is genuinely CPU-heavy and borderline against
    // vitest's default 5s on a loaded CI runner — it flaked in Build & Validate
    // while passing elsewhere on the same commit. 15s gives 3× headroom without
    // masking a real hang.
    testTimeout: 15000,
  },
});
