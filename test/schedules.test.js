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
    const from = Math.floor(Date.UTC(2026, 5, 15, 10, 0, 0) / 1000); // mid-day UTC
    const next = computeNextRunAt("08:00", "UTC", null, from);
    assert.ok(Number.isFinite(next));
    assert.ok(next > from);
    // Should land on 08:00 UTC of the following morning or same day if still ahead
    const d = new Date(next * 1000);
    assert.equal(d.getUTCHours(), 8);
    assert.equal(d.getUTCMinutes(), 0);
  });

  it("default templates differ by language", () => {
    assert.ok(defaultTemplate("good_morning", "fa").length > 3);
    assert.ok(defaultTemplate("good_morning", "en").length > 3);
    assert.notEqual(defaultTemplate("good_morning", "fa"), defaultTemplate("good_morning", "en"));
  });
});
