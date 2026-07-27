/**
 * HttpClient abstraction tests. Verifies the test double
 * ({@link RecordingHttpClient}) behaves as expected — production
 * {@link FetchHttpClient} is exercised end-to-end via linear.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { FetchHttpClient, RecordingHttpClient, type RecordedCall } from '../tracker/http-client.ts';

describe('RecordingHttpClient', () => {
  test('captures method, url, headers, and parsed JSON body', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ ok: true });
    await http.fetch('https://api.example/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 1 }),
    });
    expect(http.calls.length).toBe(1);
    expect(http.calls[0]?.url).toBe('https://api.example/x');
    expect(http.calls[0]?.method).toBe('POST');
    expect(http.calls[0]?.headers.Authorization).toBe('Bearer abc');
    expect(http.calls[0]?.body).toEqual({ q: 1 });
  });

  test('defaults method to GET when not provided', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('anything');
    await http.fetch('https://x');
    expect(http.calls[0]?.method).toBe('GET');
  });

  test('returns 200 by default for a queued response', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ hello: 'world' });
    const res = await http.fetch('https://x');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  test('honours an explicit status + ok in the response config', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ status: 401, body: 'denied' });
    const res = await http.fetch('https://x');
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe('denied');
  });

  test('supports response factories that read the request body', async () => {
    const http = new RecordingHttpClient();
    http.enqueue((req: RecordedCall) => ({ echoed: req.body }));
    const res = await http.fetch('https://x', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });
    expect(await res.json()).toEqual({ echoed: { a: 1 } });
  });

  test('throws when the queue is empty (fail-fast)', async () => {
    const http = new RecordingHttpClient();
    await expect(http.fetch('https://x', { method: 'POST' })).rejects.toThrow(/no stubbed response/i);
  });

  test('throws message includes a GraphQL query snippet when the body has one', async () => {
    const http = new RecordingHttpClient();
    await expect(
      http.fetch('https://x', { method: 'POST', body: JSON.stringify({ query: 'query Foo { x }' }) }),
    ).rejects.toThrow(/GraphQL: query Foo/);
  });

  test('reset() empties calls and queue', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('a').enqueue('b');
    await http.fetch('https://x');
    http.reset();
    expect(http.calls.length).toBe(0);
    await expect(http.fetch('https://x')).rejects.toThrow();
  });

  test('queues drain in order', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('first', 'second', 'third');
    const r1 = await http.fetch('https://x');
    const r2 = await http.fetch('https://x');
    const r3 = await http.fetch('https://x');
    expect(await r1.json()).toBe('first');
    expect(await r2.json()).toBe('second');
    expect(await r3.json()).toBe('third');
  });

  test('preserves raw string body when JSON parsing fails', async () => {
    const http = new RecordingHttpClient();
    http.enqueue('ok');
    await http.fetch('https://x', { method: 'POST', body: 'not-json' });
    expect(http.calls[0]?.body).toBe('not-json');
  });
});

// ─── the deadline ───────────────────────────────────────────────────────────
//
// A tracker that is *down* refuses the connection and the call throws, which was
// always handled. A tracker that is *degraded* accepts and never answers, and Bun
// applies no response deadline of its own — so `fetch` simply never settled. That
// composed into a permanently wedged daemon: the outbox drainer awaited it inside
// a transaction, and the orchestrator rescheduled its next tick only in a
// `finally` that therefore never ran. A hang is not a throw.

describe('FetchHttpClient — the response deadline', () => {
  /** A server that accepts the connection and never replies. */
  function stalling(): { url: string; stop: () => void } {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
  }

  test('a stalled server aborts rather than hanging forever', async () => {
    const s = stalling();
    try {
      const started = Date.now();
      await expect(new FetchHttpClient(250).fetch(s.url)).rejects.toThrow();
      // The point is that it settles at all; the bound just proves it was the
      // deadline and not something else.
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      s.stop();
    }
  });

  test("a caller's own signal still works — the deadline is added, not substituted", async () => {
    // Overwriting `init.signal` would silently disable the caller's cancellation,
    // which is a worse bug than the one the deadline fixes. The deadline here is
    // far longer than the test, so only the caller's abort can settle this.
    const s = stalling();
    const ctrl = new AbortController();
    try {
      const inflight = new FetchHttpClient(60_000)
        .fetch(s.url, { signal: ctrl.signal })
        .then(() => 'responded')
        .catch((err: Error) => err.name);
      ctrl.abort();
      expect(await inflight).toBe('AbortError');
    } finally {
      s.stop();
    }
  });

  test('a healthy response is untouched by the deadline', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: 1 }) });
    try {
      const res = await new FetchHttpClient(5_000).fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ ok: 1 });
    } finally {
      server.stop(true);
    }
  });
});
