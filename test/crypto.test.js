import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSecrets, getWebhookSecret } from "../src/crypto.js";

test("webhook secret comes only from TELEGRAM_SECRET", async () => {
  assert.equal(await getWebhookSecret({ TELEGRAM_SECRET: " webhook-secret " }), "webhook-secret");
  assert.equal(await getWebhookSecret({ TELEGRAM_BOT_TOKEN: "123:token" }), null);
  assert.equal(await getWebhookSecret({ TELEGRAM_SECRET: "   " }), null);
});

test("only Telegram runtime secrets are required", () => {
  assert.equal(validateSecrets({ TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_SECRET: "secret" }), null);
  assert.deepEqual(validateSecrets({ TELEGRAM_BOT_TOKEN: "123:token" }), ["TELEGRAM_SECRET"]);
  assert.deepEqual(validateSecrets({ TELEGRAM_SECRET: "secret" }), ["TELEGRAM_BOT_TOKEN"]);
  assert.deepEqual(validateSecrets({}), ["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET"]);
});
