// Shared mini-app response envelopes. Every endpoint answers JSON, so the
// two constructors live in one place instead of being repeated per handler.


export function jsonOk(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

export function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}
