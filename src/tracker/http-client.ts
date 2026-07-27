/**
 * Minimal HTTP client abstraction so tests don't have to monkey-patch
 * `globalThis.fetch`. Production uses {@link FetchHttpClient} which wraps the
 * runtime fetch; tests use {@link RecordingHttpClient} which captures every
 * request and returns programmable responses.
 *
 * The interface intentionally mirrors a subset of the Fetch API so that
 * existing call sites read naturally: `await http.fetch(url, init)` returns
 * an object with `ok`, `status`, `json()`, and `text()`.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<HttpResponse>;
}

// ─── production impl ───────────────────────────────────────────────────────

/**
 * How long a single request may take before it is abandoned.
 *
 * There has to be a number here because Bun applies no response deadline of its
 * own: against a server that accepts the connection and never answers,
 * `globalThis.fetch` simply never settles. A tracker that is *down* is easy —
 * the connection is refused and the call throws. A tracker that is *degraded*
 * accepts and stalls, and that is the case that used to wedge the daemon: the
 * outbox drainer awaited it inside a transaction, and the orchestrator only
 * rescheduled its next tick in a `finally` that therefore never ran.
 *
 * 30s is well past a healthy Linear response and well short of a poll interval.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Wraps the runtime's global `fetch`, with a deadline it does not supply. */
export class FetchHttpClient implements HttpClient {
  constructor(private readonly timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS) {}

  async fetch(url: string, init?: RequestInit): Promise<HttpResponse> {
    const res = await globalThis.fetch(url, { ...init, signal: this.deadline(init?.signal) });
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json() as Promise<unknown>,
      text: () => res.text(),
    };
  }

  /**
   * The caller's signal, if any, *plus* the deadline — never instead of it.
   * Overwriting a caller's abort signal would silently disable their
   * cancellation, which is a worse bug than the one being fixed.
   */
  private deadline(caller?: AbortSignal | null): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }
}

// ─── test impl ─────────────────────────────────────────────────────────────

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** For JSON bodies, parsed. For form-encoded bodies, the raw string. For
   *  no body, undefined. */
  body: unknown;
}

/**
 * Test double. Pre-queue responses with {@link enqueue}; each `fetch` call
 * consumes the next queued response (or a function that returns one based on
 * the request body). Every request is captured on {@link calls} for
 * assertions.
 *
 * Throws if a fetch is made with an empty queue — fail-fast surfaces missing
 * stubs in tests rather than letting them hang or return undefined.
 */
export class RecordingHttpClient implements HttpClient {
  readonly calls: RecordedCall[] = [];
  private queue: Array<{
    body?: unknown;
    bodyFn?: (req: RecordedCall) => unknown;
    status?: number;
    ok?: boolean;
  }> = [];

  /** Queue one or more responses. Accepts either:
   *  - a value (returned as JSON with HTTP 200)
   *  - a function that receives the recorded call and returns the JSON body
   *  - an object `{ body, status, ok }` for fine-grained control
   */
  enqueue(...payloads: Array<
    unknown
    | ((req: RecordedCall) => unknown)
    | { body?: unknown; status?: number; ok?: boolean }
  >): this {
    for (const p of payloads) {
      if (typeof p === 'function') {
        this.queue.push({ bodyFn: p as (req: RecordedCall) => unknown });
      } else if (
        p !== null && typeof p === 'object' &&
        ('body' in p || 'status' in p || 'ok' in p) &&
        // Heuristic: discriminate a config object from a "data: ..." response by
        // checking if it has ONLY the config-shaped keys. If it also has e.g.
        // `data` or other arbitrary keys, treat it as a JSON body.
        Object.keys(p).every((k) => k === 'body' || k === 'status' || k === 'ok')
      ) {
        this.queue.push(p as { body?: unknown; status?: number; ok?: boolean });
      } else {
        this.queue.push({ body: p });
      }
    }
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
  }

  async fetch(url: string, init?: RequestInit): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const pair of h) {
          if (pair[0] !== undefined && pair[1] !== undefined) headers[pair[0]] = pair[1];
        }
      } else {
        Object.assign(headers, h);
      }
    }

    let parsedBody: unknown = undefined;
    if (init?.body !== undefined && init.body !== null) {
      const raw = typeof init.body === 'string' ? init.body : String(init.body);
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        parsedBody = raw;
      }
    }

    const recorded: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: parsedBody,
    };
    this.calls.push(recorded);

    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `RecordingHttpClient: no stubbed response for ${recorded.method} ${url}` +
        (typeof parsedBody === 'object' && parsedBody !== null && 'query' in parsedBody
          ? ` (GraphQL: ${String((parsedBody as { query?: string }).query).slice(0, 80)})`
          : ''),
      );
    }

    const body = next.bodyFn ? next.bodyFn(recorded) : next.body;
    const status = next.status ?? 200;
    const ok = next.ok ?? (status >= 200 && status < 300);

    return {
      ok,
      status,
      json: async () => body,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body ?? ''),
    };
  }
}
