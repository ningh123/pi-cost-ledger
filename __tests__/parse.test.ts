import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bucketKey, parseSession, splitBucketKey, TOOLS_MODEL, TOOLS_PROVIDER, UNKNOWN } from "../parse.ts";
import { localDay } from "../time.ts";
import { emptyTotal } from "../usage.ts";

/** A usage object shaped like pi's. */
function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function log(entries: unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const meta = { mtimeMs: Date.parse("2026-03-06T08:00:00Z"), size: 1234 };

/** A local-noon ISO timestamp on a fixed day, so the test does not depend on the runner's zone. */
const moment = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).toISOString();
const dayOf = (year: number, month: number, day: number) => localDay(new Date(year, month - 1, day, 12));

describe("parseSession", () => {
	it("reads the working directory from the session header", () => {
		const summary = parseSession(
			log([{ type: "session", id: "s", timestamp: moment(2026, 3, 5), cwd: "/projects/atlas" }]),
			meta,
		);
		assert.equal(summary.cwd, "/projects/atlas");
		assert.deepEqual(summary.buckets, {});
	});

	it("buckets assistant usage by local day, provider, and model", () => {
		const summary = parseSession(
			log([
				{ type: "session", timestamp: moment(2026, 3, 5), cwd: "/projects/atlas" },
				{
					type: "message",
					timestamp: moment(2026, 3, 5, 14),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(100, 10, 50, 0, 0.02) },
				},
			]),
			meta,
		);
		assert.deepEqual(summary.buckets, {
			[bucketKey(dayOf(2026, 3, 5), "zai", "glm-5.3")]: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 0,
				cost: 0.02,
				calls: 1,
			},
		});
	});

	it("merges several calls on the same day and model into one bucket", () => {
		const summary = parseSession(
			log([
				{
					type: "message",
					timestamp: moment(2026, 3, 5),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(10, 1, 0, 0, 0.01) },
				},
				{
					type: "message",
					timestamp: moment(2026, 3, 5, 13),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(20, 2, 5, 0, 0.02) },
				},
			]),
			meta,
		);
		const buckets = Object.values(summary.buckets);
		assert.equal(buckets.length, 1);
		assert.deepEqual(buckets[0], { input: 30, output: 3, cacheRead: 5, cacheWrite: 0, cost: 0.03, calls: 2 });
	});

	it("attributes a usage entry to the model named on it", () => {
		const summary = parseSession(
			log([
				{
					type: "usage",
					kind: "cache_warm",
					timestamp: moment(2026, 3, 5),
					provider: "anthropic",
					model: "claude-opus-5-5",
					usage: usage(0, 0, 50_000, 0, 0.015),
				},
			]),
			meta,
		);
		assert.deepEqual(Object.keys(summary.buckets), [bucketKey(dayOf(2026, 3, 5), "anthropic", "claude-opus-5-5")]);
	});

	it("groups summaries without a model under tools/summaries", () => {
		const summary = parseSession(
			log([
				{ type: "model_change", timestamp: moment(2026, 3, 5), provider: "zai", modelId: "glm-5.3" },
				{
					type: "message",
					timestamp: moment(2026, 3, 5, 13),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(10, 1, 0, 0, 0.01) },
				},
				{ type: "compaction", timestamp: moment(2026, 3, 5, 14), usage: usage(30, 2, 0, 0, 0.03) },
			]),
			meta,
		);
		assert.deepEqual(summary.buckets[bucketKey(dayOf(2026, 3, 5), "zai", "glm-5.3")], {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			calls: 1,
		});
		assert.deepEqual(summary.buckets[bucketKey(dayOf(2026, 3, 5), TOOLS_PROVIDER, TOOLS_MODEL)], {
			input: 30,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.03,
			calls: 1,
		});
	});

	it("groups tool results without model metadata under tools/summaries", () => {
		const summary = parseSession(
			log([
				{ type: "model_change", timestamp: moment(2026, 3, 5), provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
				{ type: "message", timestamp: moment(2026, 3, 5), message: { role: "toolResult", usage: usage(5, 1, 0, 0, 0.001) } },
			]),
			meta,
		);
		assert.deepEqual(Object.keys(summary.buckets), [bucketKey(dayOf(2026, 3, 5), TOOLS_PROVIDER, TOOLS_MODEL)]);
	});

	it("keeps an explicit nested model on a tool result without changing the session model", () => {
		const summary = parseSession(
			log([
				{ type: "model_change", timestamp: moment(2026, 3, 5), provider: "openai", modelId: "outer-model" },
				{
					type: "message",
					timestamp: moment(2026, 3, 5, 13),
					message: {
						role: "toolResult",
						provider: "anthropic",
						model: "nested-model",
						usage: usage(5, 1, 0, 0, 0.001),
					},
				},
				{ type: "compaction", timestamp: moment(2026, 3, 5, 14), usage: usage(30, 2, 0, 0, 0.03) },
			]),
			meta,
		);
		assert.ok(summary.buckets[bucketKey(dayOf(2026, 3, 5), "anthropic", "nested-model")]);
		// The nested call must not make the outer OpenAI model sticky for summaries.
		assert.ok(summary.buckets[bucketKey(dayOf(2026, 3, 5), TOOLS_PROVIDER, TOOLS_MODEL)]);
		assert.equal(summary.buckets[bucketKey(dayOf(2026, 3, 5), "openai", "outer-model")], undefined);
	});

	it("labels usage that names no model as unknown", () => {
		const summary = parseSession(
			log([{ type: "message", timestamp: moment(2026, 3, 5), message: { role: "assistant", usage: usage(1, 1, 0, 0, 0) } }]),
			meta,
		);
		assert.deepEqual(Object.keys(summary.buckets), [bucketKey(dayOf(2026, 3, 5), UNKNOWN, UNKNOWN)]);
	});

	it("ignores all-zero usage records instead of counting empty calls", () => {
		const summary = parseSession(
			log([
				{
					type: "message",
					timestamp: moment(2026, 3, 5),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(0, 0, 0, 0, 0) },
				},
			]),
			meta,
		);
		assert.deepEqual(summary.buckets, {});
	});

	it("survives a torn line, junk lines, and non-object lines", () => {
		const text = [
			JSON.stringify({ type: "session", timestamp: moment(2026, 3, 5), cwd: "/projects/atlas" }),
			'{"type":"message",',
			"null",
			"42",
			JSON.stringify({
				type: "message",
				timestamp: moment(2026, 3, 5),
				message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(10, 1, 0, 0, 0.01) },
			}),
		].join("\n");
		const summary = parseSession(text, meta);
		assert.equal(summary.cwd, "/projects/atlas");
		assert.equal(Object.values(summary.buckets).length, 1);
	});

	it("accepts a legacy message timestamp when the entry has none", () => {
		const messageTimestamp = new Date(2026, 2, 4, 9).getTime();
		const summary = parseSession(
			log([
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "zai",
						model: "glm-5.3",
						timestamp: messageTimestamp,
						usage: usage(1, 1, 0, 0, 0),
					},
				},
			]),
			meta,
		);
		assert.ok(summary.buckets[bucketKey(dayOf(2026, 3, 4), "zai", "glm-5.3")]);
	});

	it("dates an undated entry by the session header before the file mtime", () => {
		const summary = parseSession(
			log([
				{ type: "session", timestamp: moment(2026, 3, 5), cwd: "/projects/atlas" },
				{ type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(1, 1, 0, 0, 0) } },
			]),
			meta,
		);
		assert.ok(summary.buckets[bucketKey(dayOf(2026, 3, 5), "zai", "glm-5.3")]);
	});

	it("dates an undated entry by the file mtime when there is no header", () => {
		const summary = parseSession(
			log([{ type: "message", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(1, 1, 0, 0, 0) } }]),
			meta,
		);
		const expected = localDay(new Date(meta.mtimeMs));
		assert.ok(summary.buckets[bucketKey(expected, "zai", "glm-5.3")]);
	});

	it("attributes a provider fallback to the response model", () => {
		const summary = parseSession(
			log([
				{
					type: "message",
					timestamp: moment(2026, 3, 5),
					message: {
						role: "assistant",
						provider: "zai",
						model: "glm-5.3",
						responseModel: "glm-5.3-flash",
						usage: usage(1, 1, 0, 0, 0.01),
					},
				},
			]),
			meta,
		);
		assert.ok(summary.buckets[bucketKey(dayOf(2026, 3, 5), "zai", "glm-5.3-flash")]);
		assert.equal(summary.buckets[bucketKey(dayOf(2026, 3, 5), "zai", "glm-5.3")], undefined);
	});

	it("reads a legacy model field on model_change", () => {
		const summary = parseSession(
			log([
				{ type: "model_change", timestamp: moment(2026, 3, 5), provider: "zai", model: "glm-5.2" },
				{
					type: "message",
					timestamp: moment(2026, 3, 5),
					message: { role: "assistant", usage: usage(1, 1, 0, 0, 0.01) },
				},
			]),
			meta,
		);
		assert.ok(summary.buckets[bucketKey(dayOf(2026, 3, 5), "zai", "glm-5.2")]);
	});

	it("strips a UTF-8 BOM before parsing the session header", () => {
		const summary = parseSession(
			`\uFEFF${log([{ type: "session", timestamp: moment(2026, 3, 5), cwd: "/projects/atlas" }])}`,
			meta,
		);
		assert.equal(summary.cwd, "/projects/atlas");
	});

	it("keeps usage entry ids and fork provenance for cross-file deduplication", () => {
		const summary = parseSession(
			log([
				{
					type: "session",
					id: "s",
					timestamp: moment(2026, 3, 5),
					cwd: "/projects/atlas",
					parentSession: "/projects/atlas/source.jsonl",
				},
				{
					type: "message",
					id: "m1",
					timestamp: moment(2026, 3, 5),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(1, 1, 0, 0, 0.01) },
				},
			]),
			meta,
		);
		assert.equal(summary.sessionId, "s");
		assert.equal(summary.parentSession, "/projects/atlas/source.jsonl");
		assert.equal(summary.records?.[0]?.id, "m1");
		assert.equal(summary.records?.[0]?.total.calls, 1);
	});

	it("carries the file stat so the index can detect changes", () => {
		const summary = parseSession("", meta);
		assert.equal(summary.mtimeMs, meta.mtimeMs);
		assert.equal(summary.size, meta.size);
		assert.deepEqual(summary.buckets, {});
		assert.equal(summary.cwd, undefined);
	});
});

describe("splitBucketKey", () => {
	it("round-trips a well-formed key", () => {
		assert.deepEqual(splitBucketKey(bucketKey("2026-03-05", "zai", "glm-5.3")), {
			day: "2026-03-05",
			provider: "zai",
			model: "glm-5.3",
		});
	});

	it("keeps pipes inside a model id", () => {
		assert.deepEqual(splitBucketKey("2026-03-05|anthropic|claude-opus-5-5|extra"), {
			day: "2026-03-05",
			provider: "anthropic",
			model: "claude-opus-5-5|extra",
		});
	});

	it("degrades instead of throwing on a corrupted key", () => {
		assert.deepEqual(splitBucketKey("2026-03-05"), { day: "2026-03-05", provider: UNKNOWN, model: UNKNOWN });
		assert.deepEqual(splitBucketKey("2026-03-05|zai"), { day: "2026-03-05", provider: "zai", model: UNKNOWN });
	});
});

describe("parseSession bucket totals", () => {
	it("keeps a bucket's shape intact", () => {
		const summary = parseSession(
			log([
				{
					type: "message",
					timestamp: moment(2026, 3, 5),
					message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: usage(1, 2, 3, 4, 0.5) },
				},
			]),
			meta,
		);
		const [bucket] = Object.values(summary.buckets);
		assert.deepEqual(bucket, { ...emptyTotal(), input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, calls: 1 });
	});
});
