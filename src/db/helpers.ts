import type { NyraEnv } from "../../types/env.js";
/**
 * Typed D1 helpers — parameterized SQL only.
 */

export async function firstRow<T>(
  env: NyraEnv,
  sql: string,
  binds: unknown[] = []
): Promise<T | null> {
  const stmt = env.DB.prepare(sql);
  const bound = binds.length ? stmt.bind(...binds) : stmt;
  const row = await bound.first<T>();
  return row ?? null;
}

export async function allRows<T>(
  env: NyraEnv,
  sql: string,
  binds: unknown[] = []
): Promise<T[]> {
  const stmt = env.DB.prepare(sql);
  const bound = binds.length ? stmt.bind(...binds) : stmt;
  const result = await bound.all<T>();
  return (result.results ?? []) as T[];
}

export async function runSql(
  env: NyraEnv,
  sql: string,
  binds: unknown[] = []
): Promise<D1Result> {
  const stmt = env.DB.prepare(sql);
  const bound = binds.length ? stmt.bind(...binds) : stmt;
  return await bound.run();
}
