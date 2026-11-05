import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addDays, localDay } from "../time.ts";

describe("localDay", () => {
	it("formats a local date with zero padding", () => {
		assert.equal(localDay(new Date(2026, 0, 5, 13, 30)), "2026-01-05");
		assert.equal(localDay(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
	});

	it("uses the local calendar day, not UTC", () => {
		// 00:30 local is the previous day in UTC west of Greenwich and the same
		// day east of it; the ledger must always report the local one.
		const lateNight = new Date(2026, 2, 5, 0, 30);
		assert.equal(localDay(lateNight), "2026-03-05");
	});
});

describe("addDays", () => {
	it("walks across month and year boundaries", () => {
		assert.equal(addDays("2026-03-01", -1), "2026-02-28");
		assert.equal(addDays("2026-12-31", 1), "2027-01-01");
		assert.equal(addDays("2026-02-28", 1), "2026-03-01");
	});

	it("handles leap days", () => {
		assert.equal(addDays("2028-02-28", 1), "2028-02-29");
		assert.equal(addDays("2028-02-29", 1), "2028-03-01");
	});

	it("lands on consecutive calendar dates across a daylight-saving change", () => {
		// The helper anchors at local noon precisely so a DST transition cannot
		// skip or repeat a date; these are the spring and autumn transitions in
		// a zone that observes them.
		assert.equal(addDays("2026-03-07", 1), "2026-03-08");
		assert.equal(addDays("2026-03-08", 1), "2026-03-09");
		assert.equal(addDays("2026-10-31", 1), "2026-11-01");
	});
});
