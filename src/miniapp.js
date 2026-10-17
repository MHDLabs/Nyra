// Nyra — Mini App API entry point.
//
// Intentionally a thin re-export. The implementation lives in `src/miniapp/`
// (see `src/miniapp/index.js`), split by domain; keeping this path stable means
// no caller and no test has to change its import.
export * from "./miniapp/index.js";
