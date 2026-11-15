/** Worker runtime helpers: clock, HTTP responses, sleep, timed fetch. */

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function okResponse(): Response {
  return new Response("OK", { status: 200 });
}

export function jsonResponse(data: unknown, status?: number): Response {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  try {
    const opts = Object.assign({}, options, { signal: controller.signal });
    return await fetch(url, opts);
  } finally {
    clearTimeout(timer);
  }
}
