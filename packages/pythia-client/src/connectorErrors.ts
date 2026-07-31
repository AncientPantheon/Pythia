/**
 * Error taxonomy for the connector protocol (`/connectors/auth/challenge` +
 * `/connectors/auth/verify`) — a separate wire contract from the transport-relay
 * taxonomy in `errors.ts`, with no shared `code` discriminator, so it gets its
 * own small hierarchy following the same `PythiaClientError`-rooted, `name`-
 * stamped pattern: a shared root a consumer can `instanceof`-catch for any
 * connector-originated failure, plus subclasses that discriminate the cause.
 */

/** Shared root of every connector protocol error. Consumers catch this to
 * handle any connector-originated failure; the subclasses discriminate the
 * specific cause. */
export class PythiaConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythiaConnectorError";
  }
}

/** A 400 from either round-trip call: an invalid apollo account on challenge,
 * or an invalid/expired nonce on verify. Both are caller/environment input
 * problems, so they share one class. */
export class PythiaConnectorValidationError extends PythiaConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "PythiaConnectorValidationError";
  }
}

/** A 401 on verify — signature verification failed. */
export class PythiaConnectorSignatureError extends PythiaConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "PythiaConnectorSignatureError";
  }
}

/** A 403 on verify — not an active dual link, and no server-side pairing hook
 * was available to record ownership proof toward eventual activation. */
export class PythiaConnectorNotLinkedError extends PythiaConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "PythiaConnectorNotLinkedError";
  }
}

/** A 502 on verify — a transient chain-read failure made verification
 * temporarily unavailable. */
export class PythiaConnectorUnavailableError extends PythiaConnectorError {
  constructor(message: string) {
    super(message);
    this.name = "PythiaConnectorUnavailableError";
  }
}
