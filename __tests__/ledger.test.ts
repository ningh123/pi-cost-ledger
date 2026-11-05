import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregate, aggregateSelection, isRangeKey, RANGES, rangeWindow } from "../ledger.ts";
import { bucketKey, type SessionSummary, UNKNOWN } from "../parse.ts";
import { addDays, localDay } from "../time.ts";
import { emptyTotal, type UsageTotal } from "../usage.ts";

const NOW = new Date(2026, 2, 15, 10, 0);

/** A session summary whose buckets are given as (day, provider, model, partial totals). */
function summary(
	cwd: string | undefined,
	rows: [day: string, provider: string, model: string, total: Partial<UsageTotal>][],
): SessionSummary {
	const buckets: Record<string, UsageTotal> = {};
	for (const [day, provider, model, total] of rows) {
		buckets[bucketKey(day, provider, model)] = { ...emptyTotal(), ...total };
	}
	return { mtimeMs: 0, size: 0, cwd, buckets };
}

const day = (offset: number) => addDays(localDay(NOW), offset);

describe("rangeWindow", () => {
	it("resolves every range to whole local days ending today", () => {
		assert.deepEqual(rangeWindow("today", NOW), {
			key: "today",
			label: "today",
			sinceDay: "2026-03-15",
			untilDay: "2026-03-15",
		});
		assert.deepEqual(rangeWindow("7d", NOW), {
			key: "7d",
			label: "last 7 days",
			sinceDay: "2026-03-09",
			untilDay: "2026-03-15",
		});
		assert.deepEqual(rangeWindow("30d", NOW), {
			key: "30d",
			label: "last 30 days",
			sinceDay: "2026-02-14",
			untilDay: "2026-03-15",
		});
		assert.deepEqual(rangeWindow("all", NOW), { key: "all", label: "all time", untilDay: "2026-03-15" });
	});

	it("recognizes only the supported range keys", () => {
		for (const key of RANGES) assert.equal(isRangeKey(key), true);
		assert.equal(isRangeKey("90d"), false);
		assert.equal(isRangeKey(""), false);
	});
});

describe("aggregate", () => {
	it("sums the window and groups the same buckets by model and project", () => {
		const report = aggregate(
			[
				summary("/projects/atlas", [
					[day(0), "zai", "glm-5.3", { input: 10, output: 2, cacheRead: 90, cost: 1, calls: 1 }],
					[day(-3), "zai", "glm-5.3", { input: 5, output: 1, cacheRead: 0, cost: 0.5, calls: 1 }],
				]),
				summary("/projects/atlas", [[day(-1), "deepseek", "deepseek-v4-pro", { input: 1, output: 1, cost: 0.25, calls: 1 }]]),
				summary("/projects/beacon", [[day(-10), "zai", "glm-5.3", { input: 2, output: 0, cost: 0.1, calls: 1 }]]),
			],
			rangeWindow("30d", NOW),
			NOW,
		);

		assert.deepEqual(report.totals, { input: 18, output: 4, cacheRead: 90, cacheWrite: 0, cost: 1.85, calls: 4 });
		assert.deepEqual(
			report.byModel.map((row) => [row.provider, row.model, row.total.cost]),
			[
				["zai", "glm-5.3", 1.6],
				["deepseek", "deepseek-v4-pro", 0.25],
			],
		);
		assert.deepEqual(
			report.byProject.map((row) => [row.project, row.total.cost]),
			[
				["/projects/atlas", 1.75],
				["/projects/beacon", 0.1],
			],
		);
		assert.deepEqual(
			report.byProvider.map((row) => [row.provider, row.total.cost]),
			[
				["zai", 1.6],
				["deepseek", 0.25],
			],
		);
	});

	it("narrows a report to one provider without merging models or projects", () => {
		const summaries = [
			summary("/projects/atlas", [
				[day(0), "zai", "glm-5.3", { cost: 2 }],
				[day(0), "openai", "gpt-5.4", { cost: 20 }],
			]),
			summary("/projects/beacon", [[day(0), "zai", "glm-5.3", { cost: 1 }]]),
		];
		const report = aggregateSelection(summaries, rangeWindow("today", NOW), { kind: "provider", provider: "zai" }, NOW);
		assert.equal(report.totals.cost, 3);
		assert.deepEqual(
			report.byProvider.map((row) => row.provider),
			["zai"],
		);
		assert.deepEqual(
			report.byProject.map((row) => row.project),
			["/projects/atlas", "/projects/beacon"],
		);
	});

	it("excludes days outside the window on both sides", () => {
		const rows: [string, string, string, Partial<UsageTotal>][] = [
			[day(0), "zai", "glm-5.3", { cost: 1 }],
			[day(-29), "zai", "glm-5.3", { cost: 1 }],
			[day(-30), "zai", "glm-5.3", { cost: 100 }],
			[day(1), "zai", "glm-5.3", { cost: 100 }],
		];
		const report = aggregate([summary("/projects/atlas", rows)], rangeWindow("30d", NOW), NOW);
		assert.equal(report.totals.cost, 2);
	});

	it("includes everything for all time", () => {
		const report = aggregate(
			[
				summary("/projects/atlas", [[day(-400), "zai", "glm-5.3", { cost: 7 }]]),
				summary("/projects/atlas", [[day(0), "zai", "glm-5.3", { cost: 1 }]]),
			],
			rangeWindow("all", NOW),
			NOW,
		);
		assert.equal(report.totals.cost, 8);
		assert.equal(report.byModel[0]?.total.cost, 8);
	});

	it("groups sessions without a cwd under the unknown project", () => {
		const report = aggregate(
			[summary(undefined, [[day(0), "zai", "glm-5.3", { cost: 1, calls: 1 }]])],
			rangeWindow("today", NOW),
			NOW,
		);
		assert.deepEqual(report.byProject, [{ project: UNKNOWN, total: { ...emptyTotal(), cost: 1, calls: 1 } }]);
	});

	it("breaks cost ties by token volume, then by name", () => {
		const report = aggregate(
			[
				summary("/projects/atlas", [
					[day(0), "openai", "gpt-5.4", { input: 200, cost: 1 }],
					[day(0), "openai", "gpt-5.4-mini", { input: 300, cost: 1 }],
					[day(0), "openai", "gpt-5.4-nano", { input: 100, cost: 1 }],
				]),
			],
			rangeWindow("today", NOW),
			NOW,
		);
		assert.deepEqual(
			report.byModel.map((row) => row.model),
			["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano"],
		);
	});

	it("breaks a full tie by name so the order never flickers", () => {
		const report = aggregate(
			[
				summary("/projects/atlas", [
					[day(0), "openai", "gpt-5.4-mini", { cost: 1 }],
					[day(0), "openai", "gpt-5.4", { cost: 1 }],
				]),
			],
			rangeWindow("today", NOW),
			NOW,
		);
		assert.deepEqual(
			report.byModel.map((row) => row.model),
			["gpt-5.4", "gpt-5.4-mini"],
		);
	});

	it("reports an empty window without inventing rows", () => {
		const report = aggregate([], rangeWindow("today", NOW), NOW);
		assert.deepEqual(report.totals, emptyTotal());
		assert.deepEqual(report.byModel, []);
		assert.deepEqual(report.byProject, []);
		assert.equal(report.trend.length, 1);
		assert.deepEqual(report.trend[0]?.total, emptyTotal());
	});
});

describe("trend", () => {
	it("zero-fills every day of the window, ascending", () => {
		const report = aggregate(
			[summary("/projects/atlas", [[day(-2), "openai", "gpt-5.4", { cost: 2 }]])],
			rangeWindow("7d", NOW),
			NOW,
		);
		assert.equal(report.trend.length, 7);
		assert.deepEqual(
			report.trend.map((point) => point.total.cost),
			[0, 0, 0, 0, 2, 0, 0],
		);
		assert.equal(report.trend.at(-1)?.day, "2026-03-15");
	});

	it("caps all-time at the trend span and starts where visible usage starts", () => {
		const report = aggregate(
			[
				summary("/projects/atlas", [
					[day(-400), "openai", "gpt-5.4", { cost: 1 }],
					[day(-100), "openai", "gpt-5.4", { cost: 1 }],
					[day(-5), "openai", "gpt-5.4", { cost: 1 }],
				]),
			],
			rangeWindow("all", NOW),
			NOW,
		);
		assert.equal(report.trend.length, 6);
		assert.equal(report.trend[0]?.day, day(-5));
	});

	it("spans the full trend cap when the first usage is older than it", () => {
		const report = aggregate(
			[summary("/projects/atlas", [[day(-400), "openai", "gpt-5.4", { cost: 1 }]])],
			rangeWindow("all", NOW),
			NOW,
		);
		assert.equal(report.trend.length, 30);
		assert.equal(report.trend[0]?.total.cost, 0);
	});
});
