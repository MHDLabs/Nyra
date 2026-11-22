export function isOpenRouterUrl(baseUrl: unknown): boolean {
  if (!baseUrl) return false;
  return String(baseUrl).toLowerCase().indexOf("openrouter.ai") !== -1;
}
