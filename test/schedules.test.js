import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLocalTime, computeNextRunAt, defaultTemplate } from "../src/db/schedules.js";

describe("schedules", () => {
  it("parseLocalTime accepts HH:MM", () => {
    assert.deepEqual(parseLocalTime("08:30"), { hour: 8, minute: 30 });
    assert.deepEqual(parseLocalTime("23:59"), { hour: 23, minute: 59 });
    assert.equal(parseLocalTime("24:00"), null);
    assert.equal(parseLocalTime("nope"), null);
  });

  it("computeNextRunAt returns a future UTC second for daily local time", () => {
    const from = Math.floor(Date.UTC(2026, 5, 15, 10, 0, 0) / 1000);
    const next = computeNextRunAt("08:00", "UTC", null, from);
    assert.ok(Number.isFinite(next));
    assert.ok(next > from);
    const d = new Date(next * 1000);
    assert.equal(d.getUTCHours(), 8);
    assert.equal(d.getUTCMinutes(), 0);
  });

  it("default templates differ by language", () => {
    assert.ok(defaultTemplate("good_morning", "fa").length > 3);
    assert.ok(defaultTemplate("good_morning", "en").length > 3);
    assert.notEqual(defaultTemplate("good_morning", "fa"), defaultTemplate("good_morning", "en"));
  });

  it("computeNextRunAt finds a valid UTC instant in America/New_York", () => {
    const from = Math.floor(Date.UTC(2026, 2, 7, 17, 0, 0) / 1000);
    const next = computeNextRunAt("09:00", "America/New_York", null, from);
    assert.ok(Number.isFinite(next), "expected finite next, got " + next);
    assert.ok(next > from);
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    const parts = {};
    fmt.formatToParts(new Date(next * 1000)).forEach((p) => { parts[p.type] = p.value; });
    assert.equal(parseInt(parts.hour, 10) % 24, 9);
    assert.equal(parseInt(parts.minute, 10), 0);
  });
});
