// Nyra — AI layer entry point.
//
// Intentionally a thin re-export. The implementation lives in `src/providers/`
// (see `src/providers/index.js`), split by provider and by responsibility;
// keeping this path stable means no caller and no test has to change its import.
export * from "./providers/index.js";
