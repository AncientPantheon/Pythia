import { describe, it, expect } from "vitest";
import {
  PythiaConnectorError,
  PythiaConnectorValidationError,
  PythiaConnectorSignatureError,
  PythiaConnectorNotLinkedError,
  PythiaConnectorUnavailableError,
} from "./connectorErrors.js";

describe("connector error taxonomy", () => {
  it("PythiaConnectorError is the shared instanceof root for consumers", () => {
    // A consumer that catches the base class must catch every connector
    // subclass — this is the whole point of adding a base to this separate
    // (non-transport-relay) wire contract's error taxonomy.
    const validation = new PythiaConnectorValidationError(
      "invalid apollo account",
    );
    const signature = new PythiaConnectorSignatureError(
      "signature verification failed",
    );
    const notLinked = new PythiaConnectorNotLinkedError(
      "not an active dual link",
    );
    const unavailable = new PythiaConnectorUnavailableError(
      "verification temporarily unavailable",
    );

    for (const err of [validation, signature, notLinked, unavailable]) {
      expect(err).toBeInstanceOf(PythiaConnectorError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("each subclass is instanceof itself (a broken prototype chain in a future refactor would slip past the root/Error checks above alone)", () => {
    expect(new PythiaConnectorValidationError("x")).toBeInstanceOf(
      PythiaConnectorValidationError,
    );
    expect(new PythiaConnectorSignatureError("x")).toBeInstanceOf(
      PythiaConnectorSignatureError,
    );
    expect(new PythiaConnectorNotLinkedError("x")).toBeInstanceOf(
      PythiaConnectorNotLinkedError,
    );
    expect(new PythiaConnectorUnavailableError("x")).toBeInstanceOf(
      PythiaConnectorUnavailableError,
    );
  });

  it("sets a wire-stable name equal to each class name", () => {
    // `name` is how a consumer identifies the condition without importing the
    // class (structured logging / serialization) — it must match the class.
    expect(new PythiaConnectorError("x").name).toBe("PythiaConnectorError");
    expect(new PythiaConnectorValidationError("x").name).toBe(
      "PythiaConnectorValidationError",
    );
    expect(new PythiaConnectorSignatureError("x").name).toBe(
      "PythiaConnectorSignatureError",
    );
    expect(new PythiaConnectorNotLinkedError("x").name).toBe(
      "PythiaConnectorNotLinkedError",
    );
    expect(new PythiaConnectorUnavailableError("x").name).toBe(
      "PythiaConnectorUnavailableError",
    );
  });

  it("preserves the message on each error", () => {
    expect(
      new PythiaConnectorValidationError("invalid or expired nonce").message,
    ).toBe("invalid or expired nonce");
    expect(
      new PythiaConnectorSignatureError("signature verification failed")
        .message,
    ).toBe("signature verification failed");
  });
});
