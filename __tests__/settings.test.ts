import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultSettings, parseSettings, serializeSettings } from "../settings.ts";

describe("parseSettings", () => {
	it("falls back to the default range when there is no file", () => {
		assert.deepEqual(parseSettings(undefined), { range: "today", scope: "project" });
		assert.deepEqual(parseSettings(""), { range: "today", scope: "project" });
	});

	it("reads a stored range and scope", () => {
		assert.deepEqual(parseSettings('{"range":"7d","scope":"all"}'), { range: "7d", scope: "all" });
		assert.deepEqual(parseSettings('{"range":"all","extra":true}'), { range: "all", scope: "project" });
	});

	it("keeps the range of a file written before scope existed", () => {
		// Older settings only carried a range; they meant "this project" in
		// practice, so the scope default applies without losing the range.
		assert.deepEqual(parseSettings('{"range":"30d"}'), { range: "30d", scope: "project" });
	});

	it("ignores values this version does not support", () => {
		assert.deepEqual(parseSettings('{"range":"90d"}'), defaultSettings());
		assert.deepEqual(parseSettings('{"range":42}'), defaultSettings());
		assert.deepEqual(parseSettings('{"range":"7d","scope":"galaxy"}'), { range: "7d", scope: "project" });
	});

	it("survives a corrupted file", () => {
		assert.deepEqual(parseSettings("{not json"), defaultSettings());
		assert.deepEqual(parseSettings("null"), defaultSettings());
		assert.deepEqual(parseSettings("[]"), defaultSettings());
	});
});

describe("serializeSettings", () => {
	it("round-trips and ends with a newline", () => {
		const text = serializeSettings({ range: "7d", scope: "all" });
		assert.ok(text.endsWith("\n"));
		assert.deepEqual(parseSettings(text), { range: "7d", scope: "all" });
	});
});
