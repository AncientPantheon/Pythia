import { describe, it, expectTypeOf } from "vitest";
import type {
  HealthSnapshot,
  PythiaClientOptions,
  ReadInput,
  SendInput,
  PollInput,
  PollResult,
} from "./types.js";

describe("public response/input type contracts", () => {
  it("HealthSnapshot carries service:ok, routing tri-state, and per-source health", () => {
    expectTypeOf<HealthSnapshot["service"]>().toEqualTypeOf<"ok">();
    expectTypeOf<HealthSnapshot["routing"]>().toEqualTypeOf<
      "primary" | "fallback" | "unreachable"
    >();
    expectTypeOf<HealthSnapshot["sources"][number]["reachable"]>().toEqualTypeOf<
      boolean
    >();
  });

  it("ReadInput requires a string code and allows optional chainId/data/sender", () => {
    expectTypeOf<ReadInput["code"]>().toEqualTypeOf<string>();
    expectTypeOf<ReadInput["chainId"]>().toEqualTypeOf<number | undefined>();
  });

  it("SendInput carries the cmds array of caller-signed commands", () => {
    expectTypeOf<SendInput["cmds"]>().toEqualTypeOf<unknown[]>();
  });

  it("PollInput requires a requestKeys string array", () => {
    expectTypeOf<PollInput["requestKeys"]>().toEqualTypeOf<string[]>();
  });

  it("PollResult keys per-request-key status/depth by request key", () => {
    expectTypeOf<PollResult["finalityDepth"]>().toEqualTypeOf<number>();
    expectTypeOf<
      PollResult["results"][string]["status"]
    >().toEqualTypeOf<"pending" | "final">();
    expectTypeOf<PollResult["results"][string]["depth"]>().toEqualTypeOf<number>();
  });

  it("client option shape matches the API surface", () => {
    expectTypeOf<PythiaClientOptions["baseUrl"]>().toEqualTypeOf<string>();
  });
});
