/** Error types surfaced by the library. */

import type { BackendKind } from './types';

/** Thrown when a backend call fails (network error, non-2xx status, or missing peer dependency). */
export class BackendError extends Error {
  readonly backendId: string;
  readonly status?: number;
  readonly responseBody?: string;

  constructor(
    message: string,
    options: { backendId: string; status?: number; responseBody?: string; cause?: unknown } = {
      backendId: 'unknown',
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'BackendError';
    this.backendId = options.backendId;
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

/**
 * Thrown when the policy blocks a request — currently only when a
 * `'sensitive'` request cannot run on-device. It is never routed to the cloud.
 */
export class RoutingBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'RoutingBlockedError';
    this.reason = reason;
  }
}

/**
 * Thrown when the router has no backend available for the mode the policy chose
 * (e.g. the policy chose on-device but no on-device backend was configured, and
 * no fallback was possible).
 */
export class NoBackendError extends Error {
  readonly mode: BackendKind;

  constructor(mode: BackendKind, message: string) {
    super(message);
    this.name = 'NoBackendError';
    this.mode = mode;
  }
}
