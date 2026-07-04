import { describe, it, expectTypeOf } from "vitest";
import type {
  Balance,
  Confirmations,
  HealthSnapshot,
  PythiaClientOptions,
  GetBalanceInput,
  GetConfirmationsInput,
  RpcInput,
} from "./types.js";

describe("public response/input type contracts", () => {
  it("Balance amounts are decimal strings and token is optional", () => {
    expectTypeOf<Balance["ignis"]>().toEqualTypeOf<string>();
    expectTypeOf<Balance["ouroDispo"]>().toEqualTypeOf<string>();
    expectTypeOf<Balance["virtualOuro"]>().toEqualTypeOf<string>();
    expectTypeOf<Balance["chain"]>().toEqualTypeOf<"stoachain">();
    expectTypeOf<Balance>().toHaveProperty("token");
  });

  it("Confirmations status is the pending|final union", () => {
    expectTypeOf<Confirmations["status"]>().toEqualTypeOf<
      "pending" | "final"
    >();
    expectTypeOf<Confirmations["depth"]>().toEqualTypeOf<number>();
  });

  it("HealthSnapshot carries service:ok, routing tri-state, and per-source health", () => {
    expectTypeOf<HealthSnapshot["service"]>().toEqualTypeOf<"ok">();
    expectTypeOf<HealthSnapshot["routing"]>().toEqualTypeOf<
      "primary" | "fallback" | "unreachable"
    >();
    expectTypeOf<HealthSnapshot["sources"][number]["reachable"]>().toEqualTypeOf<
      boolean
    >();
  });

  it("client option and method-input shapes match the API surface", () => {
    expectTypeOf<PythiaClientOptions["baseUrl"]>().toEqualTypeOf<string>();
    expectTypeOf<GetBalanceInput["address"]>().toEqualTypeOf<string>();
    expectTypeOf<GetConfirmationsInput["tx"]>().toEqualTypeOf<string>();
    expectTypeOf<RpcInput["payload"]>().toEqualTypeOf<unknown>();
  });
});
