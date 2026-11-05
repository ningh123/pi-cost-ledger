/**
 * Plain-text rendering: one report, one block of monospace text.
 *
 * This is what `/cost <range>` prints and what every non-interactive mode gets.
 * It goes through `ctx.ui.notify`, which every pi mode renders, so the text
 * stays copy-pasteable. Columns are computed from the content, so a three-digit
 * month and a half-cent day line up without a fixed layout drifting.
 */

import { replaceControlCharacters, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type { Report, TrendPoint } from "./ledger.ts";
import { cacheHitRate, hasUsage, totalTokens, type UsageTotal } from "./usage.ts";

export interface RenderOptions {
	/** Overrides the header line, which otherwise reads `Cost — <range>`. */
	title?: string;
	/** Home directory for `~`-collapsing project paths; unset renders absolute paths. */
	home?: string;
	/** Hide the project table when the report is already scoped to one project. */
	showProjects?: boolean;
	/** Range overview rows shown above the breakdowns. */
	overview?: readonly { label: string; total: UsageTotal }[];
	/** Footer line, usually the command hints. */
	hint?: string;
	limitModels?: number;
	limitProjects?: number;
}

const DEFAULT_MODEL_ROWS = 6;
const DEFAULT_PROJECT_ROWS = 5;
const BAR_CELLS = 8;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function renderPanel(report: Report, options: RenderOptions = {}): string {
	const lines = [options.title ?? `Cost — ${report.window.label}`];

	if (!hasUsage(report.totals)) {
		lines.push("", `no usage recorded in ${report.window.label}`);
	} else {
		lines.push("", headline(report.totals));
	}

	// The overview is range context, so it stays even when the selected range
	// itself is empty — "nothing today, $12 this month" is the useful answer.
	if (options.overview && options.overview.length > 1) {
		lines.push("", ...overviewLines(options.overview));
	}

	if (hasUsage(report.totals)) {
		if (report.byModel.length > 0) {
			lines.push("", "models", ...modelLines(report.byModel, report.totals, options.limitModels ?? DEFAULT_MODEL_ROWS));
		}
		if (options.showProjects !== false && report.byProject.length > 0) {
			lines.push("", "projects", ...projectLines(report.byProject, options.home, options.limitProjects ?? DEFAULT_PROJECT_ROWS));
		}
		// A one-day span is already summarized by the headline; a bar of it
		// would only repeat the number.
		const trend = report.trend.length > 1 ? trendLine(report.trend) : undefined;
		if (trend !== undefined) lines.push("", trend);
	}

	if (options.hint) lines.push("", options.hint);
	return lines.join("\n");
}

/** `$12.34 · ↑1.2M ↓340k · cache 78% · 842 calls` */
export function headline(total: UsageTotal): string {
	const parts = [formatUsd(total.cost), `${formatTokens(total.input)} in / ${formatTokens(total.output)} out`];
	const cache = cacheHitRate(total);
	if (cache !== undefined) parts.push(`cache ${formatPercent(cache)}`);
	parts.push(`${formatTokens(total.calls)} ${total.calls === 1 ? "call" : "calls"}`);
	return parts.join(" · ");
}

function padEndVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function overviewLines(rows: readonly { label: string; total: UsageTotal }[]): string[] {
	const labelWidth = Math.max(...rows.map((row) => visibleWidth(row.label)));
	const moneyWidth = Math.max(...rows.map((row) => formatUsd(row.total.cost).length));
	const flowWidth = Math.max(...rows.map((row) => visibleWidth(flow(row.total))));
	return rows.map((row) => {
		const cache = cacheHitRate(row.total);
		const suffix = cache === undefined ? "" : `  ${formatPercent(cache)}`;
		return `${padEndVisible(row.label, labelWidth)}  ${formatUsd(row.total.cost).padStart(moneyWidth)}  ${padEndVisible(flow(row.total), flowWidth)}${suffix}`;
	});
}

/**
 * The model table always names the provider. Model ids are not unique across
 * providers: the same model can be listed under two providers with different
 * casing, an extra prefix, or another version suffix, and a bare model column
 * would silently merge two different bills into one row.
 */
function modelLines(rows: Report["byModel"], totals: UsageTotal, limit: number): string[] {
	const shown = rows.slice(0, Math.max(1, limit));
	const labels = shown.map((row) => ({ provider: sanitizeLabel(row.provider), model: sanitizeLabel(row.model) }));
	const providerWidth = Math.max(...labels.map((label) => visibleWidth(label.provider)));
	const modelWidth = Math.max(...labels.map((label) => visibleWidth(label.model)));
	const moneyWidth = Math.max(...shown.map((row) => formatUsd(row.total.cost).length));
	const shareWidth = Math.max(...shown.map((row) => formatShare(shareOf(row.total, totals)).length));
	const cacheWidth = 4;

	const lines = shown.map((row, index) => {
		const share = shareOf(row.total, totals);
		const cache = cacheHitRate(row.total);
		const cacheText = cache === undefined ? "—" : formatPercent(cache);
		const label = labels[index] as { provider: string; model: string };
		return `  ${padEndVisible(label.provider, providerWidth)}  ${padEndVisible(label.model, modelWidth)}  ${formatUsd(row.total.cost).padStart(moneyWidth)}  ${formatShare(share).padStart(shareWidth)}  ${cacheText.padStart(cacheWidth)}  ${bar(share)}`.trimEnd();
	});
	if (rows.length > shown.length) lines.push(`  ${rows.length - shown.length} more`);
	return lines;
}

function projectLines(rows: Report["byProject"], home: string | undefined, limit: number): string[] {
	const shown = rows.slice(0, Math.max(1, limit));
	const labels = shown.map((row) => abbreviatePath(row.project, home, 44));
	const labelWidth = Math.max(...labels.map((label) => visibleWidth(label)));
	const moneyWidth = Math.max(...shown.map((row) => formatUsd(row.total.cost).length));
	const lines = shown.map(
		(row, index) => `  ${padEndVisible(labels[index] as string, labelWidth)}  ${formatUsd(row.total.cost).padStart(moneyWidth)}`,
	);
	if (rows.length > shown.length) lines.push(`  ${rows.length - shown.length} more`);
	return lines;
}

/** `daily  ▁▂▃·▅▆██▆▅▃▂  peak $1.20`; undefined when the span has no spend at all. */
export function trendLine(trend: readonly TrendPoint[]): string | undefined {
	const peak = Math.max(...trend.map((point) => point.total.cost));
	if (peak <= 0) return undefined;
	const bars = trend.map((point) => trendBar(point.total.cost / peak)).join("");
	return `${"daily".padEnd(6)}  ${bars}  peak ${formatUsd(peak)}`;
}

/** Eight levels plus a dot for a day with no spend, so gaps stay visible. */
export function trendBar(ratio: number): string {
	if (ratio <= 0) return "·";
	const level = Math.min(BLOCKS.length - 1, Math.max(0, Math.ceil(ratio * BLOCKS.length) - 1));
	return BLOCKS[level] as string;
}

/** A row's share of the window, in cost when anything was priced and in tokens otherwise (free and local models). */
export function shareOf(row: UsageTotal, totals: UsageTotal): number {
	if (totals.cost > 0) return row.cost / totals.cost;
	const tokens = totalTokens(totals);
	return tokens > 0 ? totalTokens(row) / tokens : 0;
}

function bar(share: number): string {
	if (share <= 0) return "";
	return "█".repeat(Math.max(1, Math.round(share * BAR_CELLS)));
}

/** The `↑input ↓output` cell, shared with the interactive view. */
export function flow(total: UsageTotal): string {
	return `↑${formatTokens(total.input)} ↓${formatTokens(total.output)}`;
}

/** Whole percents, with a floor mark so a real but tiny share never reads as zero. */
export function formatPercent(rate: number): string {
	const percent = Math.round(rate * 100);
	return percent === 0 && rate > 0 ? "<1%" : `${percent}%`;
}

function formatShare(share: number): string {
	return formatPercent(share);
}

/**
 * Strip terminal escape sequences and replace remaining control characters, so
 * a crafted directory name or index entry cannot move the cursor, clear the
 * screen, or reach the clipboard through the rendered report. Data stays raw in
 * the index; sanitizing belongs at the presentation boundary.
 */
export function sanitizeLabel(text: string): string {
	return replaceControlCharacters(stripTerminalSequences(text));
}

/**
 * Money with a precision that follows the magnitude: four decimals below a
 * cent (a single cached call), three below a dollar, two above, then k/M/B/T
 * suffixes. Each threshold is where the shorter format would otherwise round
 * to `1000.0`, so $999.995 reads as $1.0k rather than $1000.00 and large
 * totals promote instead of showing `$1000.0k`.
 */
export function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	for (const unit of [
		{ threshold: 999_950_000_000, divisor: 1_000_000_000_000, suffix: "T" },
		{ threshold: 999_950_000, divisor: 1_000_000_000, suffix: "B" },
		{ threshold: 999_950, divisor: 1_000_000, suffix: "M" },
		{ threshold: 999.995, divisor: 1_000, suffix: "k" },
	] as const) {
		if (value >= unit.threshold) return `$${(value / unit.divisor).toFixed(1)}${unit.suffix}`;
	}
	if (value >= 1) return `$${value.toFixed(2)}`;
	if (value >= 0.01) return `$${value.toFixed(3)}`;
	if (value >= 0.00005) return `$${value.toFixed(4)}`;
	return "$0";
}

/** Compact token counts, matching pi's built-in footer: 999, 9.9k, 123k, 1.2M, 12M. */
export function formatTokens(count: number): string {
	if (count < 1000) return Math.round(count).toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Collapse the home directory prefix to `~`, like the built-in footer's pwd line. */
export function formatCwd(cwd: string, home: string | undefined): string {
	const safeCwd = sanitizeLabel(cwd);
	if (!home) return safeCwd;
	const safeHome = sanitizeLabel(home);
	// Strip a trailing separator so `~/projects/` and `~/projects` behave the same.
	const normalizedHome = safeHome.length > 1 ? safeHome.replace(/[\\/]+$/, "") : safeHome;
	if (normalizedHome === "/") {
		// A root home contains every absolute path. Keeping the leading slash after
		// `~` avoids turning `/projects` into `~projects`.
		if (safeCwd === "/") return "~";
		return safeCwd.startsWith("/") ? `~${safeCwd}` : safeCwd;
	}
	if (safeCwd === normalizedHome) return "~";
	// The separator guard keeps sibling paths that merely share the prefix
	// (home "/home/tester", cwd "/home/tester-alt") unshortened. Both POSIX and
	// Windows separators are accepted so a Windows home collapses too.
	for (const separator of ["/", "\\"]) {
		if (safeCwd.startsWith(`${normalizedHome}${separator}`)) {
			return `~${safeCwd.slice(normalizedHome.length)}`;
		}
	}
	return safeCwd;
}

/** What a scoped report is scoped to: the project path, or "all projects". */
export function scopeLabel(project: string | undefined, home: string | undefined): string {
	return project === undefined ? "all projects" : abbreviatePath(project, home, 40);
}

/** Keep the tail of a long path: the leaf is what identifies a project, not its root. */
export function abbreviatePath(path: string, home: string | undefined, max: number): string {
	const collapsed = formatCwd(path, home);
	const width = visibleWidth(collapsed);
	if (width <= max) return collapsed;
	// Slice by terminal columns, not UTF-16 units: a CJK or emoji path segment
	// must not be cut in the middle of a grapheme.
	const tailWidth = Math.max(0, max - 1);
	const tail = sliceByColumn(collapsed, Math.max(0, width - tailWidth), tailWidth);
	return `…${tail}`;
}
