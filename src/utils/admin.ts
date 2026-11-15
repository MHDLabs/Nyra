export type AdminIdResult = {
  valid: string[];
  invalid: string[];
  configured: boolean;
};

export type AdminEnv = {
  ADMIN_IDS?: string | null;
};

export function parseAdminIds(raw: unknown): AdminIdResult {
  const entries = String(raw == null ? "" : raw)
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (/^\d{1,20}$/.test(entries[i]!)) valid.push(entries[i]!);
    else invalid.push(entries[i]!);
  }
  return { valid: valid, invalid: invalid, configured: valid.length > 0 };
}

export function isAdmin(env: AdminEnv, userId: string | number): boolean {
  if (!env.ADMIN_IDS) return false;
  return parseAdminIds(env.ADMIN_IDS).valid.indexOf(String(userId)) !== -1;
}

export function getAdminIds(env: AdminEnv): string[] {
  if (!env.ADMIN_IDS) return [];
  return parseAdminIds(env.ADMIN_IDS).valid;
}
