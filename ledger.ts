/**
 * Aggregation: ranges in, a report out.
 *
 * Everything here is pure. The index supplies session summaries, a range
 * window selects which day buckets count, and the report groups the same
 * buckets three ways — by model, by project, and by day — plus a zero-filled
 * trend so a gap in usage reads as a gap instead of as a missing bar.
 */

import { type SessionSummary, splitBucketKey, UNKNOWN } from "./parse.ts";
import { addDays, localDay } from "./time.ts";
import { emptyTotal, mergeTotals, type UsageTotal } from "./usage.ts";

export const RANGES = ["today", "7d", "30d", "all"] as const;

export type RangeKey = (typeof RANGES)[number];

export const DEFAULT_RANGE: RangeKey = "today";

/** How many days of history the trend line draws, even for `all`. */
const TREND_DAYS = 30;

/** A range resolved against a specific moment: the day window its buckets must fall in. */
export interface Window {
	key: RangeKey;
	/** Human label for the panel: "today", "last 7 days", "all time". */
	label: string;
	/** First day included, inclusive; `undefined` for all time. */
	sinceDay?: string;
	/** Last day included, inclusive: today for every range. */
	untilDay: string;
}

/** Resolve a range key to whole local days. Windows are calendar days, not rolling hours, so "last 7 days" means seven day buckets. */
export function rangeWindow(key: RangeKey, now: Date = new Date()): Window {
	const today = localDay(now);
	switch (key) {
		case "today":
			return { key, label: "today", sinceDay: today, untilDay: today };
		case "7d":
			return { key, label: "last 7 days", sinceDay: addDays(today, -6), untilDay: today };
		case "30d":
			return { key, label: "last 30 days", sinceDay: addDays(today, -29), untilDay: today };
		case "all":
			return { key, label: "all time", untilDay: today };
	}
}

export function isRangeKey(value: string): value is RangeKey {
	return (RANGES as readonly string[]).includes(value);
}

/** Which projects a report covers: the one pi is running in, or every project on the machine. */
export type Scope = "project" | "all";

export const SCOPES = ["project", "all"] as const;

export function isScope(value: string): value is Scope {
	return (SCOPES as readonly string[]).includes(value);
}

/**
 * Narrow the input to one project before aggregating. Scoping by filtering
 * summaries (rather than by a predicate inside the aggregation) keeps totals,
 * breakdowns, and the trend automatically consistent with each other.
 */
export function scopeToProject(summaries: readonly SessionSummary[], project: string | undefined): SessionSummary[] {
	if (project === undefined) return [...summaries];
	return summaries.filter((summary) => (summary.cwd ?? UNKNOWN) === project);
}

export interface ModelRow {
	provider: string;
	model: string;
	total: UsageTotal;
}

export interface ProjectRow {
	project: string;
	total: UsageTotal;
}

export interface ProviderRow {
	provider: string;
	total: UsageTotal;
}

export interface TrendPoint {
	day: string;
	total: UsageTotal;
}

export interface Report {
	window: Window;
	totals: UsageTotal;
	byModel: ModelRow[];
	byProject: ProjectRow[];
	byProvider: ProviderRow[];
	/** One point per day in the window's trend span, zero-filled and ascending. */
	trend: TrendPoint[];
}

/**
 * Aggregate every session whose buckets fall inside the window. Buckets dated
 * after the window's last day are dropped: a session written by a machine with
 * a clock ahead must not book spend into days that have not started yet.
 */
export function aggregate(summaries: Iterable<SessionSummary>, window: Window, now: Date = new Date()): Report {
	return aggregateWhere(summaries, window, now, () => true);
}

/**
 * What a drill-down narrows to: one model, or one project. Both are answered
 * from the same buckets, so a detail view costs one more pass over the index
 * and needs no second data model.
 */
export type Selection =
	| { kind: "model"; provider: string; model: string }
	| { kind: "project"; project: string }
	| { kind: "provider"; provider: string };

/** The aggregate narrowed to one model or one project: its totals and cross-breakdown. */
export function aggregateSelection(
	summaries: Iterable<SessionSummary>,
	window: Window,
	selection: Selection,
	now: Date = new Date(),
): Report {
	const include = (provider: string, model: string, project: string): boolean => {
		if (selection.kind === "model") return provider === selection.provider && model === selection.model;
		if (selection.kind === "provider") return provider === selection.provider;
		return project === selection.project;
	};
	return aggregateWhere(summaries, window, now, include);
}

function aggregateWhere(
	summaries: Iterable<SessionSummary>,
	window: Window,
	now: Date,
	include: (provider: string, model: string, project: string) => boolean,
): Report {
	const totals = emptyTotal();
	const models = new Map<string, ModelRow>();
	const projects = new Map<string, ProjectRow>();
	const providers = new Map<string, ProviderRow>();
	const days = new Map<string, UsageTotal>();

	for (const summary of summaries) {
		const project = summary.cwd ?? UNKNOWN;
		for (const [key, total] of Object.entries(summary.buckets)) {
			const { day, provider, model } = splitBucketKey(key);
			if (window.sinceDay !== undefined && day < window.sinceDay) continue;
			if (day > window.untilDay) continue;
			if (!include(provider, model, project)) continue;

			mergeTotals(totals, total);

			const modelKey = `${provider}|${model}`;
			const modelRow = models.get(modelKey) ?? { provider, model, total: emptyTotal() };
			mergeTotals(modelRow.total, total);
			models.set(modelKey, modelRow);

			const projectRow = projects.get(project) ?? { project, total: emptyTotal() };
			mergeTotals(projectRow.total, total);
			projects.set(project, projectRow);

			const providerRow = providers.get(provider) ?? { provider, total: emptyTotal() };
			mergeTotals(providerRow.total, total);
			providers.set(provider, providerRow);

			const dayRow = days.get(day) ?? emptyTotal();
			mergeTotals(dayRow, total);
			days.set(day, dayRow);
		}
	}

	return {
		window,
		totals,
		byModel: [...models.values()].sort((a, b) =>
			compareRows(a.total, b.total, `${a.provider}/${a.model}`, `${b.provider}/${b.model}`),
		),
		byProject: [...projects.values()].sort((a, b) => compareRows(a.total, b.total, a.project, b.project)),
		byProvider: [...providers.values()].sort((a, b) => compareRows(a.total, b.total, a.provider, b.provider)),
		trend: buildTrend(days, window, now),
	};
}

function compareRows(a: UsageTotal, b: UsageTotal, aLabel: string, bLabel: string): number {
	if (a.cost !== b.cost) return b.cost - a.cost;
	const aTokens = a.input + a.output + a.cacheRead + a.cacheWrite;
	const bTokens = b.input + b.output + b.cacheRead + b.cacheWrite;
	if (aTokens !== bTokens) return bTokens - aTokens;
	return aLabel < bLabel ? -1 : aLabel > bLabel ? 1 : 0;
}

/**
 * The trend span always ends today and covers at most `TREND_DAYS`, so a year
 * of history still renders one readable line. `all` starts at the first day
 * that has usage within that cap; fixed windows start at their own first day.
 */
function buildTrend(days: ReadonlyMap<string, UsageTotal>, window: Window, now: Date): TrendPoint[] {
	const today = localDay(now);
	const capStart = addDays(today, -(TREND_DAYS - 1));
	let start = window.sinceDay !== undefined && window.sinceDay > capStart ? window.sinceDay : capStart;
	if (window.key === "all") {
		// All-time has no first day of its own; start where the visible history
		// does, so a ledger that began last week does not open with 23 empty
		// bars. Usage entirely older than the span leaves the full span.
		const firstVisible = [...days.keys()].filter((day) => day >= start && day <= today).sort()[0];
		if (firstVisible !== undefined) start = firstVisible;
	}

	const trend: TrendPoint[] = [];
	for (let day = start; day <= today; day = addDays(day, 1)) {
		trend.push({ day, total: days.get(day) ?? emptyTotal() });
	}
	return trend;
}
