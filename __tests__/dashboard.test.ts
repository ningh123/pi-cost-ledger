import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { composeDashboard, type DashboardState, DashboardView, type DashRow, type DashStyle } from "../dashboard.ts";
import { aggregate, type RangeKey, rangeWindow } from "../ledger.ts";
import { bucketKey, type SessionSummary } from "../parse.ts";
import { addDays, localDay } from "../time.ts";
import { emptyTotal, type UsageTotal } from "../usage.ts";

/** Assert that every rendered line is free of C0/C1 controls. */
function assertNoControlCharacters(lines: readonly string[]): void {
	for (const line of lines) {
		for (const character of line) {
			const code = character.codePointAt(0) ?? 0;
			assert.ok(code >= 0x20 && !(code >= 0x7f && code <= 0x9f), `control character U+${code.toString(16)}`);
		}
	}
}

const NOW = new Date(2026, 2, 15, 10);
const TODAY = localDay(NOW);
const PLAIN: DashStyle = { fg: (_color, text) => text, bold: (text) => text };
const KEY_SEQUENCES: Record<string, string> = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\x1b",
	"tui.select.pageUp": "\x1b[5~",
	"tui.select.pageDown": "\x1b[6~",
};
const keybindings = { matches: (data: string, action: string) => KEY_SEQUENCES[action] === data };

/** Built-in pi provider/model pairs used by the synthetic fixtures. */
const PROVIDER_MODELS = [
	["zai", "glm-5.3"],
	["openai", "gpt-5.4"],
	["anthropic", "claude-opus-5-5"],
	["deepseek", "deepseek-v4-pro"],
	["opencode-go", "deepseek-v4.1-flash"],
	["google", "gemini-3.5-flash"],
	["huggingface", "deepseek-ai/DeepSeek-V4-Pro"],
	["mistral", "devstral-latest"],
	["moonshotai", "kimi-k3"],
	["minimax", "MiniMax-M3"],
	["cerebras", "gpt-oss-120b"],
	["together", "openai/gpt-oss-120b"],
	["nvidia", "deepseek-ai/deepseek-v4.1-flash"],
	["xai", "grok-4.7"],
] as const;

/** Built-in OpenAI ids, enough distinct rows to exercise scrolling. */
const OPENAI_MODELS = [
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.2",
	"gpt-5.2-pro",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
];

function summary(
	cwd: string,
	rows: [provider: string, model: string, total: Partial<UsageTotal>][],
	day = TODAY,
): SessionSummary {
	const buckets: Record<string, UsageTotal> = {};
	for (const [provider, model, total] of rows) buckets[bucketKey(day, provider, model)] = { ...emptyTotal(), ...total };
	return { mtimeMs: 0, size: 0, cwd, buckets };
}

const FIXTURE = [
	summary("/home/tester/atlas", [
		["zai", "glm-5.3", { input: 1_200_000, output: 300_000, cacheRead: 9_000_000, cacheWrite: 1_000_000, cost: 9.5, calls: 40 }],
		[
			"opencode-go",
			"deepseek-v4.1-flash",
			{ input: 100_000, output: 20_000, cacheRead: 80_000, cacheWrite: 10_000, cost: 0.5, calls: 3 },
		],
	]),
	summary("/home/tester/beacon", [
		["zai", "glm-5.3", { input: 10_000, output: 1_000, cacheRead: 2_000, cacheWrite: 500, cost: 0.02, calls: 1 }],
	]),
];

function state(overrides: Partial<DashboardState> = {}): DashboardState {
	return {
		range: "30d",
		scope: { kind: "project", project: "/home/tester/atlas" },
		selected: 0,
		scroll: 0,
		sort: "cost",
		...overrides,
	};
}

function reportFor(summaries: SessionSummary[], range: RangeKey = "30d", project?: string) {
	const scoped = project === undefined ? summaries : summaries.filter((summary) => summary.cwd === project);
	return aggregate(scoped, rangeWindow(range, NOW), NOW);
}

function compose(overrides: Partial<Parameters<typeof composeDashboard>[0]> = {}) {
	const page = overrides.state ?? state();
	const project = page.scope.kind === "project" ? page.scope.project : undefined;
	return composeDashboard({
		report: overrides.report ?? reportFor(FIXTURE, page.range, project),
		state: page,
		width: 100,
		height: 20,
		home: "/home/tester",
		style: PLAIN,
		...overrides,
	});
}

function harness(
	options: {
		rows?: number;
		range?: RangeKey;
		project?: string;
		noProject?: boolean;
		summaries?: SessionSummary[];
		refreshed?: SessionSummary[];
	} = {},
) {
	let closed = false;
	let refreshes = 0;
	const tui = { requestRender: () => {}, terminal: { rows: options.rows ?? 30 } };
	const view = new DashboardView({
		summaries: options.summaries ?? FIXTURE,
		range: options.range ?? "30d",
		project: options.noProject ? undefined : (options.project ?? "/home/tester/atlas"),
		home: "/home/tester",
		theme: PLAIN,
		tui,
		keybindings,
		now: () => NOW,
		onRefresh: async () => {
			refreshes += 1;
			return options.refreshed ?? options.summaries ?? FIXTURE;
		},
		onClose: () => {
			closed = true;
		},
	});
	return {
		view,
		render: (width = 100) => view.render(width),
		refreshes: () => refreshes,
		closed: () => closed,
	};
}

function projectOption(label: string, project: string, total: Partial<UsageTotal>): DashRow {
	return {
		key: `project|${project}`,
		selection: { kind: "project", project },
		kind: "project",
		provider: "",
		model: "",
		label,
		total: { ...emptyTotal(), ...total },
	};
}

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("composeDashboard", () => {
	it("keeps only project and range above the table", () => {
		for (const width of [80, 100]) {
			const lines = compose({ width }).lines;
			assert.match(lines[0] ?? "", /^Project: ~\/atlas ▾ .*1 today/);
			assert.match(lines[1] ?? "", /^─+$/);
			assert.doesNotMatch(lines.join("\n"), /Providers \/ Models|enter details/);
		}
	});

	it("wraps only project and range controls on narrow screens", () => {
		const lines = compose({ width: 40 }).lines;
		assert.match(lines[0] ?? "", /^Project:/);
		assert.match(lines[1] ?? "", /^1 today/);
		assert.match(lines[2] ?? "", /^─+$/);
	});

	it("renders providers with four-column-indented models and a conventional column order", () => {
		const text = compose().lines.join("\n");
		assert.match(text, /^providers \(2\) · cost↓.*in +out +cache r\(w\) +hit% +calls +cost$/m);
		assert.match(text, /^▸ zai .*1\.2M +300k +9\.0M\(1\.0M\) +80\.4% +40 +\$9\.50$/m);
		assert.match(text, /^ {4}glm-5\.3 .*1\.2M +300k +9\.0M\(1\.0M\) +80\.4% +40 +\$9\.50$/m);
		assert.match(text, /^ {2}opencode-go .*100k +20k +80k\(10k\) +42\.1% +3 +\$0\.500$/m);
		assert.match(text, /^ {4}deepseek-v4\.1-flash /m);
		assert.match(text, /^ {2}total .*1\.3M +320k +9\.1M\(1\.0M\) +79\.7% +43 +\$10\.00$/m);
		assert.doesNotMatch(text, /share/);
	});

	it("folds lower-priority metrics without dropping cache reads or writes", () => {
		const medium = compose({ width: 60, state: state({ scope: { kind: "project" } }) }).lines.join("\n");
		assert.match(medium, /^providers \(2\) · cost↓.*cache r\(w\) +hit% +calls +cost$/m);
		assert.match(medium, /^▸ zai .*9\.0M\(1\.0M\) +80\.3% +41 +\$9\.52$/m);
		assert.match(medium, /^ {2}301k out · 1\.2M in$/m);

		const compact = compose({ width: 50, state: state({ scope: { kind: "project" } }) }).lines.join("\n");
		assert.match(compact, /^providers \(2\)(?: · cost↓)? +hit% +calls +cost$/m);
		assert.match(compact, /^▸ zai .*80\.3% +41 +\$9\.52$/m);
		assert.match(compact, /^ {2}301k out · 9\.0M\(1\.0M\) cache r\(w\) · 1\.2M in$/m);

		const tight = compose({ width: 40, state: state({ scope: { kind: "project" } }) }).lines.join("\n");
		assert.match(tight, /^providers \(2\)(?: · cost↓)? +hit% +cost$/m);
		assert.match(tight, /^▸ zai .*80\.3% +\$9\.52$/m);
		assert.match(tight, /^ {2}301k out · 9\.0M\(1\.0M\) cache r\(w\)$/m);
		assert.match(tight, /^ {2}41 calls · 1\.2M in$/m);
		for (const text of [medium, compact, tight]) {
			assert.equal(text.match(/glm-5\.3/g)?.length, 1);
			assert.doesNotMatch(text, /share/);
		}
	});

	it("adds and removes columns at their measured boundaries", () => {
		const full = compose({ width: 76, state: state({ scope: { kind: "project" } }) }).lines.join("\n");
		assert.match(full, /^providers \(2\)(?: · cost↓)?.*in +out +cache r\(w\) +hit% +calls +cost$/m);

		const withoutInput = compose({ width: 75, state: state({ scope: { kind: "project" } }) }).lines.join("\n");
		assert.match(withoutInput, /^providers \(2\) · cost↓.*out +cache r\(w\) +hit% +calls +cost$/m);
		assert.match(withoutInput, /^ {2}1\.2M in$/m);
	});

	it("applies the same column priority to project filter rows", () => {
		const report = reportFor(FIXTURE);
		const filterRows = [
			projectOption("all projects", "", report.totals),
			projectOption("this project", "/home/tester/atlas", reportFor(FIXTURE, "30d", "/home/tester/atlas").totals),
			projectOption("/home/tester/beacon", "/home/tester/beacon", reportFor(FIXTURE, "30d", "/home/tester/beacon").totals),
		];
		const linesAt = (width: number): string[] =>
			compose({
				width,
				report,
				state: state({ scope: { kind: "project" }, filterOpen: true, filterSelected: 0 }),
				filterRows,
			}).lines;

		const medium = linesAt(60);
		const mediumText = medium.join("\n");
		const mediumHeader = medium.find((line) => line.startsWith("project filter")) ?? "";
		assert.match(mediumHeader, /^project filter \(3\) · cost↓ .*hit% +calls +cost$/);
		assert.doesNotMatch(mediumHeader, /cache r\(w\)/);
		assert.match(mediumText, /cache r\(w\)/);

		const narrow = linesAt(40);
		const narrowText = narrow.join("\n");
		const narrowHeader = narrow.find((line) => line.startsWith("project filter")) ?? "";
		assert.match(narrowHeader, /^project filter \(3\)(?: · cost↓)? .*hit% +cost$/);
		assert.doesNotMatch(narrowHeader, /calls/);
		assert.match(narrowText, /calls/);

		const tiny = linesAt(36);
		const tinyHeader = tiny.find((line) => line.startsWith("project filter")) ?? "";
		assert.match(tinyHeader, /^project filter \(3\)(?: · cost↓)? +cost$/);
		assert.match(tiny.join("\n"), /calls/);

		for (const width of [36, 40, 60, 100]) {
			for (const line of linesAt(width)) assert.ok(visibleWidth(line) <= width, `"${line}" exceeds ${width}`);
		}
	});

	it("keeps cost on the row and moves the rest into details at very narrow widths", () => {
		const lines = compose({
			width: 30,
			height: 40,
			report: reportFor(FIXTURE),
			state: state({ scope: { kind: "project" } }),
		}).lines;
		const text = lines.join("\n");
		assert.match(text, /^providers \(2\)(?: · cost↓)? +cost$/m);
		assert.doesNotMatch(text, /hit%/);
		assert.match(text, / hit/m);
		for (const line of lines) assert.ok(visibleWidth(line) <= 30, `"${line}" exceeds 30`);
	});

	it("uses one decimal for cache rates without rounding small rates to zero", () => {
		const tiny = summary("/home/tester/tiny", [["zai", "glm-5.3", { input: 100_000, cacheRead: 1, cost: 1 }]]);
		const text = compose({ report: reportFor([tiny]), state: state({ scope: { kind: "project" } }) }).lines.join("\n");
		assert.match(text, /<0\.1%/);
	});

	it("shows a minimum-width message instead of clipping metrics", () => {
		const result = compose({ width: 12 });
		assert.equal(result.lines.length, 20);
		assert.match(result.lines[0] ?? "", /need 18 cols/);
	});

	it("keeps every line within the terminal width", () => {
		for (const width of [40, 41, 42, 55, 56, 60, 75, 76, 80, 100, 140]) {
			for (const line of compose({ width }).lines) assert.ok(visibleWidth(line) <= width, `"${line}" exceeds ${width}`);
		}
	});

	it("keeps the range tabs visible for all projects at narrow widths", () => {
		for (const width of [18, 20, 48, 49, 50, 51, 52, 60]) {
			const lines = compose({ width, state: state({ scope: { kind: "project" } }) }).lines;
			const text = lines.join("\n");
			assert.match(text, /(4 all|1 · 2 · 3 · 4)/, `range tabs missing at ${width}`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `"${line}" exceeds ${width}`);
		}
	});

	it("pads short reports to the requested height and shows empty ranges without a table", () => {
		const result = compose();
		assert.equal(result.lines.length, 20);
		assert.ok(result.lines.some((line) => line.length === 0));
		const empty = compose({ report: reportFor([], "today"), state: state({ range: "today" }) }).lines.join("\n");
		assert.match(empty, /no usage recorded in today/);
		assert.doesNotMatch(empty, /providers \(/);
	});

	it("keeps the selected provider and its model group visible", () => {
		const many = summary(
			"/home/tester/many",
			PROVIDER_MODELS.map(([provider, model], index): [string, string, Partial<UsageTotal>] => [
				provider,
				model,
				{ cost: 100 - index, calls: 1 },
			]),
		);
		const result = compose({
			report: reportFor([many]),
			state: state({ scope: { kind: "project" }, selected: 13 }),
			height: 16,
			width: 60,
		});
		const selected = result.lines.findIndex((line) => line.startsWith("▸"));
		const [lastProvider, lastModel] = PROVIDER_MODELS[PROVIDER_MODELS.length - 1] as [string, string];
		assert.ok(result.lines[selected]?.includes(lastProvider), "selected provider should be visible");
		const modelLine = result.lines.findIndex((line) => line.includes(`    ${lastModel} `));
		assert.ok(modelLine > selected, "selected provider model should stay visible");
		const total = result.lines.find((line) => line.startsWith("  total"));
		assert.match(total ?? "", /\$1\.3k$/);
		assert.match(total ?? "", /14 +\$1\.3k$/);
	});

	it("renders project filter rows with the table's responsive columns", () => {
		const report = reportFor(FIXTURE);
		const atlas = reportFor(FIXTURE, "30d", "/home/tester/atlas").totals;
		const beacon = reportFor(FIXTURE, "30d", "/home/tester/beacon").totals;
		const filterRows = [
			projectOption("all projects", "", report.totals),
			projectOption("this project", "/home/tester/atlas", atlas),
			projectOption("/home/tester/beacon", "/home/tester/beacon", beacon),
		];
		const text = compose({
			report,
			state: state({ scope: { kind: "project" }, filterOpen: true, filterSelected: 1 }),
			filterRows,
		}).lines.join("\n");
		assert.match(text, /^project filter \(3\) · cost↓ .*in +out +cache r\(w\) +hit% +calls +cost$/m);
		assert.match(text, /^ {2}1 all projects .*1\.3M +321k +9\.1M\(1\.0M\) +79\.6% +44 +\$10\.02$/m);
		assert.match(text, /^▸ 2 this project .*1\.3M +320k +9\.1M\(1\.0M\) +79\.7% +43 +\$10\.00$/m);
		assert.match(text, /^ {2}3 ~\/beacon .*10k +1\.0k +2\.0k\(500\) +16\.0% +1 +\$0\.020$/m);
		assert.doesNotMatch(text, /^ {2}total /m);
	});
});

describe("DashboardView", () => {
	it("opens the current project hierarchy without view tabs or detail actions", () => {
		const { view, render } = harness();
		const before = render().join("\n");
		assert.match(before, /^Project: ~\/atlas ▾/m);
		assert.match(before, /^ {2}total .*\$10\.00$/m);
		assert.match(before, /^Project: ~\/atlas ▾/m);
		assert.match(before, /^ {4}glm-5\.3 /m);
		assert.doesNotMatch(before, /Providers \/ Models|enter details/);
		view.handleInput("\r");
		view.handleInput("\t");
		assert.equal(render().join("\n"), before);
	});

	it("opens the project filter with p or P", () => {
		for (const key of ["p", "P"]) {
			const { view, render } = harness();
			view.handleInput(key);
			assert.match(render().join("\n"), /^project filter \(3\)/m);
		}
	});

	it("moves the provider selection without changing the static model hierarchy", () => {
		const { view, render } = harness();
		view.handleInput("\x1b[B");
		const text = render().join("\n");
		assert.match(text, /^▸ opencode-go /m);
		assert.match(text, /^ {4}glm-5\.3 /m);
		assert.match(text, /^ {4}deepseek-v4\.1-flash /m);
	});

	it("preserves the selected provider while changing ranges", () => {
		const { view, render } = harness();
		view.handleInput("\x1b[B");
		view.handleInput("4");
		assert.match(render().join("\n"), /^▸ opencode-go /m);
	});

	it("uses left and right arrows for range changes", () => {
		const old = summary("/home/tester/atlas", [["zai", "glm-5.2", { cost: 100 }]], addDays(TODAY, -10));
		const { view, render } = harness({ summaries: [...FIXTURE, old] });
		assert.match(render().join("\n"), /^ {2}total .*\$110\.00/m);
		view.handleInput("\x1b[D");
		assert.match(render().join("\n"), /^ {2}total .*\$10\.00/m);
		view.handleInput("\x1b[C");
		assert.match(render().join("\n"), /^ {2}total .*\$110\.00/m);
	});

	it("switches the range without closing a picker", () => {
		const recent = summary("/home/tester/atlas", [["zai", "glm-5.3", { cost: 1, calls: 1 }]]);
		const old = summary("/home/tester/atlas", [["zai", "glm-5.3", { cost: 5, calls: 1 }]], addDays(TODAY, -1));
		const { view, render } = harness({ summaries: [recent, old], range: "today", project: "/home/tester/atlas" });
		view.handleInput("p");
		assert.match(render().join("\n"), /^project filter/m);
		assert.match(render().join("\n"), /this project .*\$1\.00/);
		view.handleInput("\x1b[C");
		const text = render().join("\n");
		assert.match(text, /^project filter/m);
		assert.match(text, /this project .*\$6\.00/);
		assert.match(text, /1 today {2}2 7d/);
		view.handleInput("\x1b");
		assert.match(render().join("\n"), /^ {2}total .*\$6\.00/m);
	});

	it("keeps the same provider selected when sorting changes its position", () => {
		const fixture = [
			summary("/home/tester/atlas", [
				["openai", "gpt-5.4", { cost: 100, calls: 1 }],
				["zai", "glm-5.3", { cost: 1, calls: 3 }],
			]),
		];
		const { view, render } = harness({ summaries: fixture });
		assert.match(render().join("\n"), /^▸ openai /m);
		view.handleInput("s");
		view.handleInput("s");
		const text = render().join("\n");
		assert.match(text, /sort → calls/);
		assert.match(text, /^ {2}zai /m);
		assert.match(text, /^▸ openai /m);
	});

	it("pins all projects and this project in the filter and applies number shortcuts", () => {
		const { view, render } = harness();
		view.handleInput("p");
		const dropdown = render().join("\n");
		assert.match(dropdown, /^ {2}1 all projects /m);
		assert.match(dropdown, /^▸ 2 this project /m);
		assert.match(dropdown, /^ {2}3 ~\/beacon /m);
		view.handleInput("3");
		const text = render().join("\n");
		assert.match(text, /^Project: ~\/beacon ▾/m);
		assert.match(text, /^ {2}total .*16\.0% +1 +\$0\.020$/m);
		assert.match(text, /^ {4}glm-5\.3 /m);
		assert.doesNotMatch(text, /opencode-go/);
	});

	it("applies the all-projects shortcut without leaving the hierarchy", () => {
		const { view, render } = harness();
		view.handleInput("p");
		view.handleInput("1");
		const text = render().join("\n");
		assert.match(text, /^Project: all projects ▾/m);
		assert.match(text, /^ {2}total .*\$10\.02$/m);
		assert.match(text, /^ {4}glm-5\.3 /m);
	});

	it("cancels the project filter without changing the table", () => {
		const { view, render } = harness();
		const before = render().join("\n");
		view.handleInput("p");
		view.handleInput("\x1b[B");
		view.handleInput("\x1b");
		assert.equal(render().join("\n"), before);
	});

	it("starts with all projects without a cwd and can select one directly", () => {
		const { view, render } = harness({ noProject: true });
		assert.match(render().join("\n"), /no working directory/);
		view.handleInput("p");
		view.handleInput("2");
		assert.match(render().join("\n"), /^Project: ~\/atlas ▾/m);
	});

	it("shows projects with no usage in the current range", () => {
		const recent = summary("/home/tester/atlas", [["zai", "glm-5.3", { cost: 1 }]]);
		const old = summary("/home/tester/beacon", [["zai", "glm-5.3", { cost: 5 }]], addDays(TODAY, -1));
		const { view, render } = harness({ summaries: [recent, old], range: "today", project: "/home/tester/atlas" });
		view.handleInput("p");
		assert.match(render().join("\n"), /^ {2}3 ~\/beacon .*\$0$/m);
		view.handleInput("3");
		const text = render().join("\n");
		assert.match(text, /^Project: ~\/beacon ▾/m);
		assert.match(text, /no usage recorded in today/);
	});

	it("scopes to a provider from m and clears the project filter", () => {
		const { view, render } = harness();
		view.handleInput("m");
		const filter = render().join("\n");
		assert.match(filter, /^provider\/model filter \(5\)/m);
		assert.match(filter, /^(?:▸ | {2})1 all providers /m);
		view.handleInput("2");
		const text = render().join("\n");
		assert.match(text, /^Provider: zai ▾/m);
		assert.match(text, /^providers \(1\)/m);
		assert.match(text, /^ {2}total .*9\.52/m);
		assert.doesNotMatch(text, /opencode-go/);
	});

	it("scopes to a model from m and shows every project using it", () => {
		const { view, render } = harness();
		view.handleInput("m");
		const filter = render().join("\n");
		assert.match(filter, /^provider\/model filter \(5\)/m);
		assert.match(filter, /^(?:▸ | {2})1 all providers /m);
		view.handleInput("4");
		const text = render().join("\n");
		assert.match(text, /^Model: zai · glm-5\.3 ▾/m);
		assert.match(text, /^projects \(2\)/m);
		assert.match(text, /^ {2}total .*9\.52/m);
		assert.match(text, /~\/atlas /m);
		assert.match(text, /~\/beacon /m);
		assert.doesNotMatch(text, /opencode-go/);
		view.handleInput("\r");
		assert.match(render().join("\n"), /^Project: ~\/atlas ▾/m);
	});

	it("toggles project grouping with v and drills back with enter", () => {
		const { view, render } = harness();
		view.handleInput("p");
		view.handleInput("1");
		view.handleInput("v");
		const grouped = render().join("\n");
		assert.match(grouped, /^projects \(2\)/m);
		assert.match(grouped, /~\/atlas/);
		assert.match(grouped, /~\/beacon/);
		view.handleInput("\r");
		assert.match(render().join("\n"), /^Project: ~\/atlas ▾/m);

		view.handleInput("m");
		view.handleInput("2");
		view.handleInput("v");
		const byProvider = render().join("\n");
		assert.match(byProvider, /^Provider: zai ▾/m);
		assert.match(byProvider, /^projects \(2\)/m);
	});

	it("searches filter options with / and applies the match", () => {
		const { view, render } = harness();
		view.handleInput("p");
		view.handleInput("/");
		for (const character of "bea") view.handleInput(character);
		const text = render().join("\n");
		assert.match(text, /^search: bea \(1\)/m);
		assert.match(text, /~\/beacon/);
		view.handleInput("\r");
		assert.match(render().join("\n"), /^Project: ~\/beacon ▾/m);
	});

	it("searches every scope from the table", () => {
		const { view, render } = harness();
		view.handleInput("/");
		for (const character of "deep") view.handleInput(character);
		const text = render().join("\n");
		assert.match(text, /^search: deep \(1\)/m);
		assert.match(text, /opencode-go · deepseek-v4\.1-flash/);
		view.handleInput("\r");
		const after = render().join("\n");
		assert.match(after, /^Model: opencode-go · deepseek-v4\.1-flash ▾/m);
		assert.match(after, /^projects \(1\)/m);
	});

	it("searches the pinned current project by its path", () => {
		const { view, render } = harness();
		view.handleInput("/");
		for (const character of "atlas") view.handleInput(character);
		assert.match(render().join("\n"), /^search: atlas \(1\)/m);
		assert.match(render().join("\n"), /this project/);
		view.handleInput("\r");
		assert.match(render().join("\n"), /^Project: ~\/atlas ▾/m);
	});

	it("accepts pasted text and non-BMP characters in search", () => {
		const { view, render } = harness();
		view.handleInput("/");
		view.handleInput("\u009b");
		assert.match(render().join("\n"), /^search \(/m);
		view.handleInput("🚀");
		assert.match(render().join("\n"), /^search: 🚀 \(0\)/m);
		view.handleInput("ab");
		assert.match(render().join("\n"), /^search: 🚀ab \(0\)/m);
		view.handleInput("\x7f");
		assert.match(render().join("\n"), /^search: 🚀a \(0\)/m);
	});

	it("pages by visible providers and keeps the selected model group together", () => {
		const summaries = PROVIDER_MODELS.slice(0, 12).map(([provider, model], index) =>
			summary(`/home/tester/project-${index}`, [[provider, model, { cost: 100 - index, calls: 1 }]]),
		);
		const { view, render } = harness({ summaries, noProject: true });
		render(80);
		const expectedPage = compose({
			report: reportFor(summaries),
			state: state({ scope: { kind: "project" }, status: "no working directory — showing all projects" }),
			width: 80,
			height: 18,
		}).selectionPage;
		view.handleInput("\x1b[6~");
		const lines = render(80);
		const selected = lines.findIndex((line) => line.startsWith("▸"));
		const [expectedProvider, expectedModel] = PROVIDER_MODELS[expectedPage] as [string, string];
		assert.ok(lines[selected]?.includes(expectedProvider), "selected provider should be visible");
		assert.ok(
			lines
				.slice(selected + 1, selected + 3)
				.join("\n")
				.includes(`    ${expectedModel.slice(0, 8)}`),
			"selected model should stay visible",
		);
	});

	it("pages the project filter by visible options", () => {
		const summaries = Array.from({ length: 30 }, (_, index) =>
			summary(`/home/tester/p${String(index).padStart(2, "0")}`, [["zai", "glm-5.3", { cost: 30 - index }]]),
		);
		const { view, render } = harness({ summaries, noProject: true });
		render(80);
		view.handleInput("p");
		render(80);
		view.handleInput("\x1b[6~");
		assert.match(render(80).join("\n"), /^▸ .*p13 /m);
	});

	it("keeps one fixed height across ranges and short terminals", () => {
		const many = summary(
			"/home/tester/many",
			OPENAI_MODELS.map((model, index): [string, string, Partial<UsageTotal>] => ["openai", model, { cost: index + 1 }]),
		);
		const small = summary("/home/tester/atlas", [["zai", "glm-5.3", { cost: 1 }]]);
		const wide = harness({ summaries: [small, many] });
		const height = wide.render().length;
		assert.equal(height, 18);
		wide.view.handleInput("1");
		assert.equal(wide.render().length, height);
		wide.view.handleInput("p");
		assert.equal(wide.render().length, height);
		assert.equal(harness({ rows: 16 }).render().length, 9);
		assert.equal(harness({ rows: 10 }).render().length, 6);
	});

	it("supports q and escape to close", () => {
		const first = harness();
		first.view.handleInput("q");
		assert.equal(first.closed(), true);
		const second = harness();
		second.view.handleInput("\x1b");
		assert.equal(second.closed(), true);
	});

	it("uses compact ranges and one-line totals on short terminals", () => {
		const lines = harness({ rows: 8 }).render(20);
		assert.equal(lines.length, 5);
		const text = lines.join("\n");
		assert.match(text, /^Project:/m);
		assert.match(text, /1 · 2 · 3 · 4/);
		assert.match(text, /total/);
		for (const line of lines) assert.ok(visibleWidth(line) <= 20, `"${line}" exceeds 20`);
	});

	it("refreshes from disk and reports the result", async () => {
		const { view, render, refreshes } = harness();
		view.handleInput("r");
		assert.match(render().join("\n"), /refreshing…/);
		await settle();
		assert.equal(refreshes(), 1);
		assert.match(render().join("\n"), /refreshed from disk/);
	});

	it("does not render a refresh that finishes after the view closes", async () => {
		const { view, closed } = harness();
		view.handleInput("r");
		view.handleInput("\x1b");
		assert.equal(closed(), true);
		await settle();
	});

	it("cycles every sort key", () => {
		const { view, render } = harness();
		for (const label of ["hit", "calls", "out", "in", "cache r", "cache w", "cost"]) {
			view.handleInput("s");
			assert.match(render().join("\n"), new RegExp(`sort → ${label}`));
		}
	});

	it("pages up to the first visible provider", () => {
		const summaries = PROVIDER_MODELS.slice(0, 12).map(([provider, model], index) =>
			summary(`/home/tester/project-${index}`, [[provider, model, { cost: 100 - index, calls: 1 }]]),
		);
		const { view, render } = harness({ summaries, noProject: true });
		render(80);
		view.handleInput("\x1b[6~");
		view.handleInput("\x1b[5~");
		const [firstProvider] = PROVIDER_MODELS[0] as [string, string];
		assert.match(render(80).join("\n"), new RegExp(`^▸ ${firstProvider} `, "m"));
	});

	it("clears a search query before closing the picker", () => {
		const { view, render } = harness();
		view.handleInput("/");
		for (const character of "zzz") view.handleInput(character);
		assert.match(render().join("\n"), /^search: zzz \(0\)/m);
		view.handleInput("\x1b");
		assert.match(render().join("\n"), /^search \(/m);
		view.handleInput("\x1b");
		assert.match(render().join("\n"), /^providers \(/m);
	});

	it("strips control characters from provider labels", () => {
		const evil = summary("/home/tester/atlas", [["zai\u001b[2J", "glm\u0007", { cost: 1 }]]);
		const { view, render } = harness({ summaries: [evil] });
		const lines = view.render(80);
		assertNoControlCharacters(lines);
		assert.match(lines.join("\n"), /zai/);
		assert.ok(render().length > 0);
	});

	it("never fills the last row of a tiny terminal", () => {
		const five = harness({ rows: 5 }).render(20);
		assert.equal(five.length, 4);
		for (const line of five) assert.ok(visibleWidth(line) <= 20);
		const zero = harness({ rows: 0 }).render(20);
		assert.ok(zero.length > 0 && zero.length <= 20);
	});
});
