/** Small helpers shared across backend adapters. */

let idCounter = 0;

/** A best-effort unique id for responses that don't carry one (e.g. on-device). */
export function generateId(prefix: string): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Current time as a Unix timestamp in seconds (the OpenAI `created` convention). */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** Normalize a `stop` value to the array form several providers expect. */
export function toStopSequences(stop: string | string[] | undefined): string[] | undefined {
  if (stop === undefined) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

/** Flatten message content to a plain string (dropping `null`), for backends that take strings. */
export function contentToString(content: string | null | undefined): string {
  return content ?? '';
}
