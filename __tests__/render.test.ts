import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aggregate, type Report, rangeWindow } from "../ledger.ts";
import { bucketKey, type SessionSummary } from "../parse.ts";

import { abbreviatePath, formatCwd, formatPercent, formatTokens, formatUsd, renderPanel } from "../render.ts";
import { addDays, localDay } from "../time.ts";
import { emptyTotal, type UsageTotal } from "../usage.ts";

/** Assert that every rendered line is free of C0/C1 controls (newlines separate lines). */
function assertNoControlCharacters(text: string): void {
	for (const line of text.split("\n")) {
		for (const character of line) {
			const code = character.codePointAt(0) ?? 0;
			assert.ok(code >= 0x20 && !(code >= 0x7f && code <= 0x9f), `control character U+${code.toString(16)}`);
		}
	}
}

const NOW = new Date(2026, 2, 15, 10);
const day = (offset: number) => addDays(localDay(NOW), offset);

function summary(cwd: string | undefined, rows: [string, string, string, Partial<UsageTotal>][]): SessionSummary {
	const buckets: Record<string, UsageTotal> = {};
	for (const [when, provider, model, total] of rows) buckets[bucketKey(when, provider, model)] = { ...emptyTotal(), ...total };
	return { mtimeMs: 0, size: 0, cwd, buckets };
}

function reportFor(summaries: SessionSummary[], range: "today" | "7d" | "30d" | "all" = "30d"): Report {
	return aggregate(summaries, rangeWindow(range, NOW), NOW);
}

describe("formatUsd", () => {
	it("scales precision to magnitude", () => {
		assert.equal(formatUsd(0), "$0");
		assert.equal(formatUsd(-1), "$0");
		assert.equal(formatUsd(0.000049), "$0");
		assert.equal(formatUsd(0.00005), "$0.0001");
		assert.equal(formatUsd(0.0042), "$0.0042");
		assert.equal(formatUsd(0.0432), "$0.043");
		assert.equal(formatUsd(1), "$1.00");
		assert.equal(formatUsd(12.345), "$12.35");
		assert.equal(formatUsd(999.994), "$999.99");
		assert.equal(formatUsd(999.995), "$1.0k");
		assert.equal(formatUsd(1500), "$1.5k");
		assert.equal(formatUsd(999_949), "$999.9k");
		assert.equal(formatUsd(999_950), "$1.0M");
		assert.equal(formatUsd(1_000_000), "$1.0M");
		assert.equal(formatUsd(999_950_000), "$1.0B");
		assert.equal(formatUsd(1_000_000_000_000), "$1.0T");
	});
});

describe("formatTokens", () => {
	it("matches the built-in footer's compaction", () => {
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(12_345), "12k");
		assert.equal(formatTokens(999_999), "1000k");
		assert.equal(formatTokens(1_234_567), "1.2M");
		assert.equal(formatTokens(12_345_678), "12M");
	});
});

describe("formatPercent", () => {
	it("marks a real but tiny share instead of rounding it to zero", () => {
		assert.equal(formatPercent(0), "0%");
		assert.equal(formatPercent(0.004), "<1%");
		assert.equal(formatPercent(0.0149), "1%");
		assert.equal(formatPercent(0.784), "78%");
	});
});

describe("paths", () => {
	it("collapses the home prefix only on a path boundary", () => {
		assert.equal(formatCwd("/home/tester/atlas", "/home/tester"), "~/atlas");
		assert.equal(formatCwd("/home/tester", "/home/tester"), "~");
		assert.equal(formatCwd("/home/tester-alt/atlas", "/home/tester"), "/home/tester-alt/atlas");
		assert.equal(formatCwd("/srv/atlas", undefined), "/srv/atlas");
		assert.equal(formatCwd("/projects/atlas", "/"), "~/projects/atlas");
		assert.equal(formatCwd("/", "/"), "~");
	});

	it("strips terminal controls from labels", () => {
		const unsafe = formatCwd("/tmp/\u001b[2Jatlas\u0007", undefined);
		assert.equal(unsafe, "/tmp/atlas ");
		assertNoControlCharacters(unsafe);
	});

	it("collapses a Windows home prefix too", () => {
		assert.equal(formatCwd("C:\\Users\\tester\\atlas", "C:\\Users\\tester"), "~\\atlas");
		assert.equal(formatCwd("C:\\Users\\tester", "C:\\Users\\tester"), "~");
		assert.equal(formatCwd("C:\\Users\\tester-alt\\atlas", "C:\\Users\\tester"), "C:\\Users\\tester-alt\\atlas");
	});

	it("keeps the leaf of a long path", () => {
		const long = `/home/tester/${"deep/".repeat(12)}atlas`;
		const short = abbreviatePath(long, "/home/tester", 30);
		assert.equal(short.length, 30);
		assert.ok(short.startsWith("…"));
		assert.ok(short.endsWith("/atlas"));
	});

	it("keeps wide characters intact when it abbreviates a path", () => {
		const short = abbreviatePath("/home/tester/阿特拉斯/示例目录/另一个很长的示例项目", "/home/tester", 12);
		assert.ok(visibleWidth(short) <= 12);
		assert.ok(short.startsWith("…"));
		assert.doesNotMatch(short, /\uFFFD/);
	});
});

describe("renderPanel", () => {
	it("puts the window, headline, ranges, breakdowns, trend, and hint in order", () => {
		const report = reportFor([
			summary("/home/tester/atlas", [
				[day(0), "zai", "glm-5.3", { input: 120_000, output: 31_000, cacheRead: 400_000, cost: 4.2, calls: 12 }],
				[day(-3), "deepseek", "deepseek-v4-pro", { input: 80_000, output: 12_000, cacheRead: 100_000, cost: 1.1, calls: 3 }],
			]),
		]);
		const text = renderPanel(report, {
			home: "/home/tester",
			overview: [
				{ label: "today", total: report.totals },
				{ label: "last 7 days", total: { ...emptyTotal(), cost: 9.5, calls: 20 } },
				{ label: "last 30 days", total: report.totals },
			],
			hint: "/cost help",
		});
		const lines = text.split("\n");
		assert.equal(lines[0], "Cost — last 30 days");
		assert.match(text, /^\$5\.30 · 200k in \/ 43k out · cache 71% · 15 calls$/m);
		assert.match(text, /^today\s+\$5\.30/m);
		assert.match(text, /^last 30 days\s+\$5\.30/m);
		assert.match(text, /^models$/m);
		assert.match(text, /glm-5\.3\s+\$4\.20\s+79%/m);
		assert.match(text, /^projects$/m);
		assert.match(text, /~\/atlas\s+\$5\.30/m);
		assert.match(text, /^daily\s+[·▁▂▃▄▅▆▇█]+ {2}peak \$4\.20/m);
		assert.equal(lines.at(-1), "/cost help");
	});

	it("says so when the window has no usage", () => {
		const report = reportFor([]);
		const text = renderPanel(report);
		assert.match(text, /no usage recorded in last 30 days/);
		assert.doesNotMatch(text, /^models$/m);
	});

	it("keeps the range overview when only the selected range is empty", () => {
		const report = reportFor([summary("/home/tester/atlas", [[day(-2), "zai", "glm-5.3", { cost: 3, calls: 1 }]])], "today");
		const text = renderPanel(report, {
			overview: [
				{ label: "today", total: report.totals },
				{ label: "last 30 days", total: { ...emptyTotal(), cost: 3, calls: 1 } },
			],
		});
		assert.match(text, /no usage recorded in today/);
		assert.match(text, /last 30 days\s+\$3\.00/);
	});

	it("always names the provider, so equal model ids from different providers never merge", () => {
		const report = reportFor([
			summary("/home/tester/atlas", [
				[day(0), "deepseek", "deepseek-v4-pro", { cost: 1 }],
				[day(0), "opencode-go", "deepseek-v4-pro", { cost: 1 }],
			]),
		]);
		const text = renderPanel(report);
		assert.match(text, /^ {2}deepseek +deepseek-v4-pro +\$1\.00 +50%/m);
		assert.match(text, /^ {2}opencode-go +deepseek-v4-pro +\$1\.00 +50%/m);
	});

	it("strips control characters from model labels", () => {
		const report = reportFor([summary("/home/tester/atlas", [[day(0), "zai\u001b[2J", "glm\u0007", { cost: 1 }]])]);
		const text = renderPanel(report);
		assertNoControlCharacters(text);
		assert.match(text, /zai/);
	});

	it("keeps at least one project row even with a zero limit", () => {
		const text = renderPanel(
			reportFor([
				summary("/home/tester/atlas", [[day(0), "zai", "glm-5.3", { cost: 2 }]]),
				summary("/home/tester/beacon", [[day(0), "zai", "glm-5.3", { cost: 1 }]]),
			]),
			{ limitProjects: 0, home: "/home/tester" },
		);
		assert.match(text, /^ {2}~\/atlas /m);
		assert.match(text, /^ {2}1 more$/m);
	});

	it("keeps at least one model row even with a zero limit", () => {
		const text = renderPanel(
			reportFor([
				summary("/home/tester/atlas", [
					[day(0), "openai", "gpt-5.4", { cost: 2 }],
					[day(0), "openai", "gpt-5.4-mini", { cost: 1 }],
				]),
			]),
			{ limitModels: 0 },
		);
		assert.match(text, /^ {2}openai +gpt-5\.4 /m);
		assert.match(text, /^ {2}1 more$/m);
	});

	it("summarizes hidden rows instead of truncating silently", () => {
		const models = [
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.4-nano",
			"gpt-5.4-pro",
			"gpt-5.5",
			"gpt-5.5-pro",
			"gpt-5.3-codex",
			"gpt-5.3-codex-spark",
			"gpt-5.2",
		];
		const rows = models.map((model, index): [string, string, string, Partial<UsageTotal>] => [
			day(0),
			"openai",
			model,
			{ cost: 10 - index },
		]);
		const text = renderPanel(reportFor([summary("/home/tester/atlas", rows)]), { limitModels: 6 });
		assert.match(text, /^ {2}3 more$/m);
	});

	it("omits the trend when nothing in the span was priced", () => {
		const text = renderPanel(
			reportFor([summary("/home/tester/atlas", [[day(0), "opencode-go", "beam-free", { input: 5000, output: 1000, calls: 1 }]])]),
		);
		assert.match(text, /\$0 · 5\.0k in \/ 1\.0k out/);
		assert.doesNotMatch(text, /^daily/m);
	});

	it("falls back to token shares when nothing has a price", () => {
		const text = renderPanel(
			reportFor([
				summary("/home/tester/atlas", [
					[day(0), "opencode-go", "beam-free", { input: 9000, calls: 1 }],
					[day(0), "opencode-go", "iceman-contributor-free", { input: 1000, calls: 1 }],
				]),
			]),
		);
		assert.match(text, /beam-free\s+\$0\s+90%/);
		assert.match(text, /iceman-contributor-free\s+\$0\s+10%/);
	});

	it("aligns cost columns when project paths contain wide characters", () => {
		const text = renderPanel(
			reportFor([
				summary("/home/tester/阿特拉斯", [[day(0), "zai", "glm-5.3", { cost: 1 }]]),
				summary("/home/tester/beacon", [[day(0), "zai", "glm-5.3", { cost: 2 }]]),
			]),
		);
		const rows = text.split("\n").filter((line) => line.includes("/home/tester/"));
		assert.equal(rows.length, 2);
		const costColumns = rows.map((line) => visibleWidth(line.slice(0, line.indexOf("$"))));
		assert.equal(costColumns[0], costColumns[1]);
	});
});
