// The OpenCode V2 free lane has the same two 429s as the v1 lane: a transient
// "service is overloaded" (retry it) and a spent/flagged session
// (FreeUsageLimitError / FreeTierError, do not retry). It also needs the same
// TLS-impersonating transport, because the gate keys on the ClientHello — a
// native Node fetch is answered with 429 no matter the headers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { baseExecuteMock, tlsFetchMock } = vi.hoisted(() => ({
  baseExecuteMock: vi.fn(),
  tlsFetchMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/base.js", () => ({
  BaseExecutor: class {
    async execute(args) {
      return baseExecuteMock(args);
    }
  },
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
}));

const { OpenCodeV2Executor } = await import("../../open-sse/executors/opencode-v2.js");

const OVERLOAD = JSON.stringify({
  error: { type: "server_error", message: "The inference service is overloaded. Please try again later." },
});
const FREE_USAGE = JSON.stringify({
  type: "error",
  error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Please try again later." },
});

function upstream(status, body) {
  return { response: new Response(body, { status, headers: { "content-type": "application/json" } }) };
}

async function run(executor, credentials = {}, log) {
  const pending = executor.execute({
    model: "deepseek-v4.1-flash-free",
    body: { messages: [{ role: "user", content: "say OK" }] },
    stream: true,
    credentials,
    log,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  return pending;
}

const sessionOf = (call) => call[0].credentials._opencodeV2Session;

describe("OpenCodeV2Executor overload retry", () => {
  beforeEach(() => {
    baseExecuteMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("retries the transient free-lane 429 and returns the recovered stream", async () => {
    baseExecuteMock
      .mockResolvedValueOnce(upstream(429, OVERLOAD))
      .mockResolvedValueOnce(upstream(429, OVERLOAD))
      .mockResolvedValueOnce(upstream(200, "data: ok\n\n"));
    const log = { debug: vi.fn() };

    const result = await run(new OpenCodeV2Executor("opencode-v2", {}), undefined, log);

    expect(baseExecuteMock).toHaveBeenCalledTimes(3);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("data: ok\n\n");
    expect(log.debug).toHaveBeenCalledWith("RETRY", expect.stringContaining("overload"));
  });

  it("stops after eight attempts and hands the last 429 back intact", async () => {
    baseExecuteMock.mockImplementation(async () => upstream(429, OVERLOAD));

    const result = await run(new OpenCodeV2Executor("opencode-v2", {}));

    expect(baseExecuteMock).toHaveBeenCalledTimes(8);
    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toBe(OVERLOAD);
  });

  it("does not retry a free-tier quota 429 and rotates the session", async () => {
    baseExecuteMock.mockResolvedValue(upstream(429, FREE_USAGE));
    const creds = { rawHeaders: { authorization: "Bearer v2-quota-test" } };
    const executor = new OpenCodeV2Executor("opencode-v2", {});

    const first = await run(executor, creds);
    expect(first.response.status).toBe(429);
    await run(executor, creds);

    expect(baseExecuteMock).toHaveBeenCalledTimes(2);
    const [a, b] = baseExecuteMock.mock.calls.map(sessionOf);
    expect(a).toMatch(/^ses_/);
    expect(b).toMatch(/^ses_/);
    // A spent session must not be reused, or every later request fails the same way.
    expect(b).not.toBe(a);
  });

  it("keeps one stable session across successful requests", async () => {
    baseExecuteMock.mockImplementation(async () => upstream(200, "data: ok\n\n"));
    const creds = { rawHeaders: { authorization: "Bearer v2-stable-test" } };
    const executor = new OpenCodeV2Executor("opencode-v2", {});

    await run(executor, creds);
    await run(executor, creds);

    const [a, b] = baseExecuteMock.mock.calls.map(sessionOf);
    expect(b).toBe(a);
  });

  it("does not retry other upstream failures", async () => {
    baseExecuteMock.mockResolvedValue(upstream(500, '{"error":"boom"}'));

    const result = await run(new OpenCodeV2Executor("opencode-v2", {}));

    expect(baseExecuteMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(500);
  });

  it("sends the request through the impersonating TLS transport", async () => {
    baseExecuteMock.mockImplementation(async () => upstream(200, "data: ok\n\n"));

    await run(new OpenCodeV2Executor("opencode-v2", {}));

    const directFetch = baseExecuteMock.mock.calls[0][0].directFetch;
    expect(typeof directFetch).toBe("function");
    // Proxies are tunneled by wreq itself; adapters that cannot must stay on undici.
    expect(directFetch.proxyCapable).toBe(true);
  });
});
