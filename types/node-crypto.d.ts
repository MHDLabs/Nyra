/** Ambient module for Cloudflare nodejs_compat `node:crypto` under worker tsconfig types:[]. */
declare module "node:crypto" {
  interface Hmac {
    update(data: string | Uint8Array): Hmac;
    digest(): Uint8Array;
    digest(encoding: "hex" | "base64" | "utf8"): string;
  }
  export function createHmac(algorithm: string, key: string | Uint8Array): Hmac;
  export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}
