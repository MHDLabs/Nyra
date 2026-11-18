// Nyra — storage entry point.
//
// This file is intentionally a thin re-export. The implementation lives in
// `src/db/` (see `src/db/index.js`) split by responsibility; keeping this path
// stable means no caller and no test has to change its import.
export * from "./db/index.js";
