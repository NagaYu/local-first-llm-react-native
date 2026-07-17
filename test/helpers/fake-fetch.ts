/** A recording fetch stub for backend mapping tests — no real network. */

export interface FetchCall {
  url: string;
  method?: string;
  headers: Record<string, unknown>;
  body: unknown;
}

export interface FakeFetchResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

export function createFakeFetch(response: FakeFetchResponse): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = async (url: unknown, init: unknown): Promise<Response> => {
    const requestInit = (init ?? {}) as RequestInit;
    const rawBody = requestInit.body;
    calls.push({
      url: String(url),
      method: requestInit.method,
      headers: (requestInit.headers ?? {}) as Record<string, unknown>,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody,
    });
    const status = response.status ?? 200;
    if (response.text !== undefined) {
      return new Response(response.text, { status });
    }
    return new Response(JSON.stringify(response.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}
