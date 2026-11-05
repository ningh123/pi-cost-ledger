/**
 * The interactive `/cost` view.
 *
 * One scoped table answers the current range without page switching or detail
 * screens. A project or provider scope lists providers and models; a model scope
 * lists every project where that model ran. Pickers and `/` search share the
 * table's responsive columns, and the panel keeps one height by padding short
 * reports rather than resizing the editor dock.
 */

import { Key, type KeyId, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	aggregate,
	aggregateSelection,
	RANGES,
	type RangeKey,
	type Report,
	rangeWindow,
	type Selection,
	scopeToProject,
	type Window,
} from "./ledger.ts";
import type { SessionSummary } from "./parse.ts";
import { abbreviatePath, formatTokens, formatUsd, sanitizeLabel } from "./render.ts";
import { cacheHitRate, emptyTotal, hasUsage, type UsageTotal } from "./usage.ts";

/** The theme colors this view uses; a subset of pi's Theme, so tests can pass a plain-style stand-in. */
export type DashColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

export interface DashStyle {
	fg(color: DashColor, text: string): string;
	bold(text: string): string;
}

export interface KeyMatcher {
	matches(data: string, action: string): boolean;
}

/** Minimal TUI surface: the terminal height bounds the viewport. */
export interface DashTui {
	requestRender(): void;
	terminal: { rows: number };
}

export type RowKind = "provider" | "model" | "project";

/** The metric the list is ordered by. All orders are descending. */
export type SortKey = "cost" | "input" | "output" | "cacheRead" | "cacheWrite" | "hit" | "calls";

/** What the table is scoped to: one project, one provider, or one provider/model pair. */
export type DashboardScope =
	| { kind: "project"; project?: string }
	| { kind: "provider"; provider: string }
	| { kind: "model"; provider: string; model: string };

/** Which option list the inline filter is showing. */
export type FilterKind = "project" | "provider" | "search";

/** How the table groups the scoped report. */
export type Grouping = "provider" | "project";

export interface DashboardState {
	range: RangeKey;
	scope: DashboardScope;
	/** Explicit grouping; model scope always groups by project. */
	grouping?: Grouping;
	filterOpen?: boolean;
	filterKind?: FilterKind;
	filterSelected?: number;
	filterQuery?: string;
	filterSearch?: boolean;
	selected: number;
	scroll: number;
	sort: SortKey;
	status?: string;
}

/** One report row, tied to the provider, model, or project it represents. */
export interface DashRow {
	key: string;
	selection: Selection;
	kind: RowKind;
	provider: string;
	model: string;
	label: string;
	total: UsageTotal;
}

const TAB_LABELS: Record<RangeKey, string> = { today: "today", "7d": "7d", "30d": "30d", all: "all" };
const SORT_KEYS: readonly SortKey[] = ["cost", "hit", "calls", "output", "input", "cacheRead", "cacheWrite"];
const SORT_LABELS: Record<SortKey, string> = {
	cost: "cost",
	calls: "calls",
	hit: "hit",
	input: "in",
	output: "out",
	cacheRead: "cache r",
	cacheWrite: "cache w",
};

const SELECTION_PAGE = 8;
const MIN_VIEW_HEIGHT = 12;
const MAX_VIEW_HEIGHT = 20;
const CHROME_HEIGHT = 7;
const MIN_WIDTH = 18;
const GAP = "  ";
const TABLE_PREFIX_WIDTH = 2;
const FILTER_PREFIX_WIDTH = 4;
const IN_WIDTH = 6;
const OUT_WIDTH = 6;
const CALLS_WIDTH = 6;
const CACHE_IO_WIDTH = 12;
const CACHE_WIDTH = 6;
const MIN_LABEL_WIDTH = 18;
const COST_WIDTH = 8;

/** The stable identity a row keeps across ranges, sorting, and refreshed data. */
export function rowKey(selection: Selection): string {
	if (selection.kind === "model") return `model|${selection.provider}|${selection.model}`;
	if (selection.kind === "provider") return `provider|${selection.provider}`;
	return `project|${selection.project}`;
}

/** Flatten one report dimension into the rows a table or picker shows. */
export function buildRows(report: Report, kind: RowKind): DashRow[] {
	if (kind === "project") {
		return report.byProject.map((row) => ({
			key: rowKey({ kind: "project", project: row.project }),
			selection: { kind: "project", project: row.project },
			kind,
			provider: "",
			model: "",
			label: row.project,
			total: row.total,
		}));
	}
	if (kind === "provider") {
		return report.byProvider.map((row) => ({
			key: rowKey({ kind: "provider", provider: row.provider }),
			selection: { kind: "provider", provider: row.provider },
			kind,
			provider: row.provider,
			model: "",
			label: row.provider,
			total: row.total,
		}));
	}
	return report.byModel.map((row) => ({
		key: rowKey({ kind: "model", provider: row.provider, model: row.model }),
		selection: { kind: "model", provider: row.provider, model: row.model },
		kind,
		provider: row.provider,
		model: row.model,
		label: row.model,
		total: row.total,
	}));
}

export interface ComposeInput {
	report: Report;
	state: DashboardState;
	width: number;
	/** Maximum panel height; short reports return only their content lines. */
	height: number;
	home?: string;
	style: DashStyle;
	/** Visible picker/search rows; the scroll index is relative to this list. */
	filterRows?: readonly DashRow[];
}

export interface ComposeResult {
	lines: string[];
	scroll: number;
	/** Selectable rows currently visible, used for page navigation. */
	selectionPage: number;
}

/** Render a complete panel with a fixed header and a scrolling table body. */
export function composeDashboard(input: ComposeInput): ComposeResult {
	const { report, state, width, height, home, style } = input;
	const viewHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : MAX_VIEW_HEIGHT;
	if (width < MIN_WIDTH) {
		const lines = Array.from({ length: viewHeight }, () => "");
		lines[0] = truncateToWidth(`need ${MIN_WIDTH} cols`, Math.max(1, width));
		return { lines, scroll: 0, selectionPage: 1 };
	}
	const compactLayout = viewHeight < 10 || width < 40;
	const rows = state.filterOpen
		? (input.filterRows ?? [])
		: sortRows(buildRows(report, rowKindForGrouping(effectiveGrouping(state))), state.sort);
	const layout = tableLayout(width, TABLE_PREFIX_WIDTH);
	const top = headerLines(report, state, style, width, home);
	if (!compactLayout) top.push(rule(width, style));
	const bottom: string[] = [];
	if (!state.filterOpen && hasUsage(report.totals)) {
		if (!compactLayout) bottom.push(rule(width, style, "═"));
		bottom.push(...totalLines(report.totals, layout, style, compactLayout));
	}
	bottom.push(style.fg("dim", hintFor(width, state, "")));
	if (top.length + bottom.length >= viewHeight) top.length = Math.max(1, viewHeight - bottom.length - 1);
	const available = Math.max(1, viewHeight - top.length - bottom.length);

	const body = bodyLines(report, state, rows, style, home, width);
	const scroll = keepSelectionVisible(
		body,
		{ ...state, selected: state.filterOpen ? (state.filterSelected ?? 0) : state.selected },
		available,
	);
	const visibleBody = body.slice(scroll, scroll + available);
	const visible = visibleBody.map((line) => line.text);
	while (visible.length < available) visible.push("");
	const selectionPage = Math.max(1, new Set(visibleBody.filter((line) => line.row >= 0).map((line) => line.row)).size);

	const hiddenAbove = scroll > 0;
	const hiddenBelow = scroll + available < body.length;
	const more = hiddenAbove && hiddenBelow ? " · ↑↓ more" : hiddenBelow ? " · ↓ more" : hiddenAbove ? " · ↑ more" : "";
	if (more) bottom[bottom.length - 1] = style.fg("dim", hintFor(width, state, more));

	const lines = [...top, ...visible, ...bottom].slice(0, viewHeight);
	return {
		lines: lines.map((line) => truncateToWidth(line, width)),
		scroll,
		selectionPage,
	};
}

function rule(width: number, style: DashStyle, glyph: "─" | "═" = "─"): string {
	return style.fg("dim", glyph.repeat(Math.max(0, width)));
}

/** Scope and range lead; all usage metrics live in the table and its total. */
function headerLines(report: Report, state: DashboardState, style: DashStyle, width: number, home: string | undefined): string[] {
	const lines = scopeAndRangeLines(state, style, width, home);
	const status = state.status === undefined ? undefined : sanitizeLabel(state.status);
	if (!hasUsage(report.totals)) {
		lines.push(withStatusRight(style.fg("dim", `no usage recorded in ${report.window.label}`), status, width, style));
	} else if (status) {
		lines.push(style.fg("dim", status));
	}
	return lines;
}

function withStatusRight(line: string, status: string | undefined, width: number, style: DashStyle): string {
	if (!status) return line;
	const styled = style.fg("dim", status);
	const gap = width - visibleWidth(line) - visibleWidth(styled);
	return gap > 1 ? `${line}${" ".repeat(gap)}${styled}` : line;
}

const SCOPE_PREFIX: Record<DashboardScope["kind"], string> = {
	project: "Project:",
	provider: "Provider:",
	model: "Model:",
};

function scopeText(scope: DashboardScope, home: string | undefined, width: number): string {
	if (scope.kind === "project") {
		const label = scope.project === undefined ? "all projects" : abbreviatePath(scope.project, home, width);
		return truncateToWidth(label, Math.max(1, width));
	}
	const label = scope.kind === "provider" ? scope.provider : `${scope.provider} · ${scope.model}`;
	return truncateToWidth(sanitizeLabel(label), Math.max(1, width));
}

function scopeAndRangeLines(state: DashboardState, style: DashStyle, width: number, home: string | undefined): string[] {
	const activeRange = (key: RangeKey): string =>
		key === state.range ? style.fg("accent", style.bold(TAB_LABELS[key])) : style.fg("dim", TAB_LABELS[key]);
	const ranges = RANGES.map((key, index) => `${index + 1} ${activeRange(key)}`).join("  ");
	const prefix = `${style.fg("muted", SCOPE_PREFIX[state.scope.kind])} `;
	const arrow = style.fg("dim", state.filterOpen ? " ▴" : " ▾");
	const pathWidth = width - visibleWidth(ranges) - visibleWidth(prefix) - visibleWidth(arrow) - 2;
	// "all projects" is longer than a short path tail. Require enough room for
	// the whole label before choosing the one-line layout; otherwise the range
	// tabs would be clipped to make space for a label that cannot fit.
	const requiredPathWidth = state.scope.kind === "project" && state.scope.project === undefined ? 12 : 8;
	if (pathWidth >= requiredPathWidth) {
		const label = scopeText(state.scope, home, pathWidth);
		const left = `${prefix}${label}${arrow}`;
		return [`${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(ranges)))}${ranges}`];
	}
	const label = scopeText(state.scope, home, Math.max(4, width - visibleWidth(prefix) - 2));
	const compactRanges = RANGES.map((key, index) =>
		key === state.range ? style.fg("accent", style.bold(`${index + 1}`)) : style.fg("dim", `${index + 1}`),
	).join(" · ");
	return [`${prefix}${label}${arrow}`, visibleWidth(ranges) <= width ? ranges : compactRanges];
}

interface TableLayout {
	/** -1 is cost only; each level adds one metric measured against the real width. */
	level: -1 | 0 | 1 | 2 | 3 | 4;
	/** Width available to the row prefix and label, before the gap and metric block. */
	leftWidth: number;
}

type Metric = "input" | "output" | "cacheIo" | "hit" | "calls" | "cost";
const METRICS: readonly { key: Metric; minLevel: TableLayout["level"]; width: number; label: string }[] = [
	{ key: "input", minLevel: 4, width: IN_WIDTH, label: "in" },
	{ key: "output", minLevel: 3, width: OUT_WIDTH, label: "out" },
	{ key: "cacheIo", minLevel: 2, width: CACHE_IO_WIDTH, label: "cache r(w)" },
	{ key: "hit", minLevel: 0, width: CACHE_WIDTH, label: "hit%" },
	{ key: "calls", minLevel: 1, width: CALLS_WIDTH, label: "calls" },
	{ key: "cost", minLevel: -1, width: COST_WIDTH, label: "cost" },
];

function metricWidth(level: TableLayout["level"]): number {
	const columns = METRICS.filter((metric) => metric.minLevel <= level);
	return columns.reduce((width, metric) => width + metric.width, GAP.length * Math.max(0, columns.length - 1));
}

/** Add columns only when their measured width and a useful label both fit the given prefix. */
function tableLayout(width: number, fixedLeft: number): TableLayout {
	for (const level of [4, 3, 2, 1, 0, -1] as const) {
		const leftWidth = width - metricWidth(level) - GAP.length;
		if (leftWidth >= fixedLeft + MIN_LABEL_WIDTH) return { level, leftWidth };
	}
	const leftWidth = Math.max(fixedLeft + 4, width - metricWidth(-1) - GAP.length);
	return { level: -1, leftWidth };
}

function right(value: string, width: number): string {
	return value.padStart(width);
}

function hitText(total: UsageTotal): string {
	const rate = cacheHitRate(total);
	if (rate === undefined) return "—";
	const percent = rate * 100;
	if (percent > 0 && percent < 0.1) return "<0.1%";
	return `${percent.toFixed(1)}%`;
}

function cacheIoText(total: UsageTotal): string {
	const read = formatTokens(total.cacheRead);
	return total.cacheWrite > 0 ? `${read}(${formatTokens(total.cacheWrite)})` : read;
}

function metricValue(total: UsageTotal, metric: Metric): string {
	switch (metric) {
		case "input":
			return formatTokens(total.input);
		case "output":
			return formatTokens(total.output);
		case "cacheIo":
			return cacheIoText(total);
		case "hit":
			return hitText(total);
		case "calls":
			return formatTokens(total.calls);
		case "cost":
			return formatUsd(total.cost);
	}
}

function rightBlock(total: UsageTotal, layout: TableLayout): string {
	return METRICS.filter((metric) => metric.minLevel <= layout.level)
		.map((metric) => right(metricValue(total, metric.key), metric.width))
		.join(GAP);
}

function detailParts(total: UsageTotal, layout: TableLayout): string[] {
	if (layout.level === 4) return [];
	const parts: string[] = [];
	if (layout.level < 3) parts.push(`${formatTokens(total.output)} out`);
	if (layout.level < 2) parts.push(`${cacheIoText(total)} cache r(w)`);
	if (layout.level < 1) parts.push(`${formatTokens(total.calls)} ${total.calls === 1 ? "call" : "calls"}`);
	parts.push(`${formatTokens(total.input)} in`);
	if (layout.level < 0) parts.push(`${hitText(total)} hit`);
	return parts;
}

/** Split one over-wide part on spaces; token and cost numbers stay intact. */
function splitByWidth(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (current !== "" && visibleWidth(candidate) > width) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}

/** Join detail parts with the standard separator, wrapping only when a line would overflow. */
function wrapDetail(parts: readonly string[], width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const part of parts) {
		if (visibleWidth(part) > width) {
			if (current !== "") {
				lines.push(current);
				current = "";
			}
			lines.push(...splitByWidth(part, width));
			continue;
		}
		const candidate = current === "" ? part : `${current} · ${part}`;
		if (current !== "" && visibleWidth(candidate) > width) {
			lines.push(current);
			current = part;
		} else {
			current = candidate;
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}

function detailLines(total: UsageTotal, layout: TableLayout, width: number): string[] {
	return layout.level === 4 ? [] : wrapDetail(detailParts(total, layout), Math.max(1, width));
}

function totalLines(total: UsageTotal, layout: TableLayout, style: DashStyle, compact = false): string[] {
	const prefix = "  ";
	const width = layout.leftWidth + GAP.length + metricWidth(layout.level);
	const label = fitText("total", Math.max(4, layout.leftWidth - visibleWidth(prefix)));
	const lines = [style.bold(`${prefix}${label}${GAP}${rightBlock(total, layout)}`)];
	if (compact) return lines;
	for (const detail of detailLines(total, layout, width - visibleWidth(prefix))) {
		lines.push(style.fg("dim", `${prefix}${detail}`));
	}
	return lines;
}

function headerBlock(layout: TableLayout): string {
	return METRICS.filter((metric) => metric.minLevel <= layout.level)
		.map((metric) => right(metric.label, metric.width))
		.join(GAP);
}

function tableHeaderLine(layout: TableLayout, count: number, state: DashboardState, style: DashStyle, width: number): string {
	const sectionName = effectiveGrouping(state) === "project" ? "projects" : "providers";
	const section = style.fg("muted", style.bold(`${sectionName} (${count})`));
	const sortSuffix = style.fg("dim", ` · ${SORT_LABELS[state.sort]}↓`);
	const rightText = style.fg("dim", headerBlock(layout));
	const showSort = visibleWidth(section) + visibleWidth(sortSuffix) + visibleWidth(rightText) + 1 <= width;
	return joinLeftRight(showSort ? `${section}${sortSuffix}` : section, rightText, width);
}

/** Preserve the right-hand metrics and truncate only the label. */
function joinLeftRight(left: string, rightText: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(rightText);
	if (leftWidth + rightWidth + 1 <= width) return left + " ".repeat(width - leftWidth - rightWidth) + rightText;
	const allowed = Math.max(0, width - rightWidth - 1);
	const clipped = truncateToWidth(left, allowed);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped) - rightWidth)) + rightText;
}

interface BodyLine {
	text: string;
	/** A provider and its read-only models share this scroll-block index. */
	row: number;
}

function fitText(text: string, width: number): string {
	const safeText = sanitizeLabel(text);
	const textWidth = visibleWidth(safeText);
	if (textWidth <= width) return safeText + " ".repeat(width - textWidth);
	if (width <= 0) return "";
	const clippedWidth = Math.max(0, width - 1);
	const clipped = sliceByColumn(safeText, 0, clippedWidth);
	return `${clipped}${" ".repeat(Math.max(0, clippedWidth - visibleWidth(clipped)))}…`;
}

function rowLabel(row: DashRow, home: string | undefined, width: number): string {
	if (row.kind === "project") return abbreviatePath(row.label, home, width);
	return row.label;
}

/** `nav` owns the selection marker; `block` keeps read-only children with their parent. */
function appendRow(
	body: BodyLine[],
	row: DashRow,
	nav: number,
	selected: boolean,
	indent: number,
	layout: TableLayout,
	style: DashStyle,
	home: string | undefined,
	block = nav,
): void {
	const selectable = nav >= 0;
	const marker = selectable ? (selected ? style.fg("accent", "▸ ") : "  ") : "";
	const prefix = `${" ".repeat(indent)}${marker}`;
	const width = layout.leftWidth + GAP.length + metricWidth(layout.level);
	const labelWidth = Math.max(4, layout.leftWidth - visibleWidth(prefix));
	const label = fitText(rowLabel(row, home, labelWidth), labelWidth);
	const text = `${prefix}${label}${GAP}${rightBlock(row.total, layout)}`;
	body.push({ text: selected ? style.bold(text) : text, row: block });
	for (const detail of detailLines(row.total, layout, width - indent - 2)) {
		body.push({ text: `${" ".repeat(indent + 2)}${style.fg("dim", detail)}`, row: block });
	}
}

/** Project options share the table's metric columns; the number shortcut costs two extra columns. */
function appendFilterRow(
	body: BodyLine[],
	row: DashRow,
	index: number,
	selected: boolean,
	layout: TableLayout,
	style: DashStyle,
	home: string | undefined,
): void {
	const marker = selected ? style.fg("accent", "▸ ") : "  ";
	const shortcut = index < 9 ? `${index + 1} ` : "  ";
	const prefix = `${marker}${shortcut}`;
	const labelWidth = Math.max(4, layout.leftWidth - visibleWidth(prefix));
	const label = fitText(rowLabel(row, home, labelWidth), labelWidth);
	const text = `${prefix}${label}${GAP}${rightBlock(row.total, layout)}`;
	body.push({ text: selected ? style.bold(text) : text, row: index });
	const width = layout.leftWidth + GAP.length + metricWidth(layout.level);
	for (const detail of detailLines(row.total, layout, width - visibleWidth(prefix))) {
		body.push({ text: `${" ".repeat(visibleWidth(prefix))}${style.fg("dim", detail)}`, row: index });
	}
}

function bodyLines(
	report: Report,
	state: DashboardState,
	rows: readonly DashRow[],
	style: DashStyle,
	home: string | undefined,
	width: number,
): BodyLine[] {
	const body: BodyLine[] = [];
	if (state.filterOpen) {
		const layout = tableLayout(width, FILTER_PREFIX_WIDTH);
		const kind = state.filterKind ?? "project";
		const isSearch = kind === "search" || state.filterSearch === true;
		const query = state.filterQuery === undefined ? "" : sanitizeLabel(state.filterQuery);
		const title = isSearch
			? `search${query ? `: ${query}` : ""}`
			: kind === "provider"
				? "provider/model filter"
				: "project filter";
		const section = style.fg("muted", style.bold(`${title} (${rows.length})`));
		const suffix = style.fg("dim", " · cost↓");
		const rightText = style.fg("dim", headerBlock(layout));
		const showSort = visibleWidth(section) + visibleWidth(suffix) + visibleWidth(rightText) + 1 <= width;
		body.push({ text: joinLeftRight(showSort ? `${section}${suffix}` : section, rightText, width), row: -1 });
		for (let index = 0; index < rows.length; index++) {
			appendFilterRow(body, rows[index] as DashRow, index, index === state.filterSelected, layout, style, home);
		}
		return body;
	}
	if (!hasUsage(report.totals)) return body;

	const layout = tableLayout(width, TABLE_PREFIX_WIDTH);
	body.push({ text: tableHeaderLine(layout, rows.length, state, style, width), row: -1 });
	if (effectiveGrouping(state) === "project") {
		for (let index = 0; index < rows.length; index++) {
			appendRow(body, rows[index] as DashRow, index, index === state.selected, 0, layout, style, home);
		}
		return body;
	}
	const models = sortRows(buildRows(report, "model"), state.sort);
	for (let index = 0; index < rows.length; index++) {
		const provider = rows[index] as DashRow;
		appendRow(body, provider, index, index === state.selected, 0, layout, style, home);
		for (const model of models.filter((row) => row.provider === provider.provider)) {
			appendRow(body, model, -1, false, 4, layout, style, home, index);
		}
	}
	return body;
}

function hintFor(width: number, state: DashboardState, extra: string): string {
	if (state.filterOpen) {
		const hint =
			state.filterSearch === true || state.filterKind === "search"
				? `type to filter · ←→ range · ↑↓ · enter · esc`
				: `←→ range · ↑↓ · 1–9/enter · / search · esc`;
		return `${hint}${extra}`;
	}
	const full = `↑↓ select · ←→ range · p project · m model · v group · / search · esc quit`;
	if (width >= visibleWidth(full) + visibleWidth(extra)) return `${full}${extra}`;
	return `↑↓ · ←→ · p · m · v · / · esc${extra}`;
}

function keepSelectionVisible(body: readonly BodyLine[], state: DashboardState, available: number): number {
	const maxScroll = Math.max(0, body.length - available);
	let scroll = Math.min(Math.max(0, state.scroll), maxScroll);
	const selectedLines = body.flatMap((line, index) => (line.row === state.selected && line.row >= 0 ? [index] : []));
	const first = selectedLines[0];
	const last = selectedLines.at(-1);
	if (first === undefined || last === undefined) return scroll;
	if (first < scroll) scroll = first;
	if (last >= scroll + available) scroll = last - available + 1;
	if (first < scroll) scroll = first;
	return Math.min(Math.max(0, scroll), maxScroll);
}

export interface DashboardOptions {
	summaries: SessionSummary[];
	range: RangeKey;
	/** The working directory used by the initial project scope; undefined starts with all projects. */
	project?: string;
	home?: string;
	theme: DashStyle;
	tui: DashTui;
	keybindings?: KeyMatcher;
	now?: () => Date;
	onRefresh?: () => Promise<SessionSummary[]>;
	onClose: () => void;
}

interface SavedPosition {
	key?: string;
	index: number;
	scroll: number;
}

/** Keyboard-driven state for the scoped table and its inline pickers. */
export class DashboardView {
	private summaries: SessionSummary[];
	private range: RangeKey;
	private scope: DashboardScope;
	private grouping: Grouping | undefined;
	private sort: SortKey = "cost";
	private selected = 0;
	private scroll = 0;
	private selectionPage = SELECTION_PAGE;
	private status: string | undefined;
	private busy = false;
	private closed = false;
	private fixedHeight?: { rows: number; height: number };
	private cached?: { summaries: SessionSummary[]; key: string; report: Report };
	private savedPosition: SavedPosition | undefined;
	private restorePosition = false;
	private filterOpen = false;
	private filterKind: FilterKind = "project";
	private filterSelected = 0;
	private filterRows: DashRow[] = [];
	private filterQuery = "";
	private filterSearch = false;
	private filterReturnScroll = 0;
	private readonly options: DashboardOptions;

	constructor(options: DashboardOptions) {
		this.options = options;
		this.summaries = options.summaries;
		this.range = options.range;
		this.scope = { kind: "project", project: options.project };
		if (options.project === undefined) this.status = "no working directory — showing all projects";
	}

	render(width: number): string[] {
		const now = this.options.now?.() ?? new Date();
		const report = this.reportNow(now);
		const filterRows = this.filterOpen ? this.visibleFilterRows() : this.filterRows;
		const rows = this.filterOpen
			? filterRows
			: sortRows(
					buildRows(report, rowKindForGrouping(effectiveGrouping({ scope: this.scope, grouping: this.grouping }))),
					this.sort,
				);
		if (this.restorePosition && !this.filterOpen) {
			const saved = this.savedPosition;
			const found = saved?.key === undefined ? -1 : rows.findIndex((row) => row.key === saved.key);
			this.selected = found >= 0 ? found : Math.min(saved?.index ?? 0, Math.max(0, rows.length - 1));
			this.scroll = saved?.scroll ?? 0;
			this.restorePosition = false;
		}
		if (!this.filterOpen) this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		this.filterSelected = Math.min(this.filterSelected, Math.max(0, filterRows.length - 1));
		const result = composeDashboard({
			report,
			state: {
				range: this.range,
				scope: this.scope,
				grouping: this.grouping,
				filterOpen: this.filterOpen,
				filterKind: this.filterKind,
				filterSelected: this.filterSelected,
				filterQuery: this.filterQuery,
				filterSearch: this.filterSearch,
				selected: this.selected,
				scroll: this.scroll,
				sort: this.sort,
				status: this.status,
			},
			width,
			height: this.viewHeight(now),
			home: this.options.home,
			style: this.options.theme,
			filterRows,
		});
		this.scroll = result.scroll;
		this.selectionPage = result.selectionPage;
		return result.lines;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.filterOpen) {
			this.handleFilterInput(data);
			return;
		}
		if (data === "q") {
			this.close();
			return;
		}
		if (this.matches(data, "tui.select.cancel", Key.escape)) {
			this.close();
			return;
		}
		if (this.matches(data, "tui.select.down", Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (this.matches(data, "tui.select.up", Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (this.matches(data, "tui.select.pageDown", Key.pageDown)) {
			this.moveSelection(this.selectionPage);
			return;
		}
		if (this.matches(data, "tui.select.pageUp", Key.pageUp)) {
			this.moveSelection(-this.selectionPage);
			return;
		}
		if (this.matches(data, "tui.select.confirm", Key.enter)) {
			this.drillIntoProject();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.stepRange(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.stepRange(1);
			return;
		}
		const digit = Number.parseInt(data, 10);
		if (data.length === 1 && digit >= 1 && digit <= RANGES.length) {
			this.setRange(RANGES[digit - 1] as RangeKey);
			return;
		}
		if (data === "p" || data === "P") {
			this.openFilter("project");
			return;
		}
		if (data === "m") {
			this.openFilter("provider");
			return;
		}
		if (data === "v") {
			this.toggleGrouping();
			return;
		}
		if (data === "/") {
			this.openSearch();
			return;
		}
		if (data === "s") {
			this.cycleSort();
			return;
		}
		if (data === "r") void this.refresh();
	}

	invalidate(): void {
		// Reports contain no themed strings; styles are applied on every render.
		// Ask for a repaint so a theme change is reflected even when no data changed.
		this.requestRender();
	}

	private matches(data: string, action: string, key: KeyId): boolean {
		return this.options.keybindings?.matches(data, action) ?? matchesKey(data, key);
	}

	private reportNow(now: Date = this.options.now?.() ?? new Date()): Report {
		const window = rangeWindow(this.range, now);
		const key = `${this.range}|${window.untilDay}|${scopeKey(this.scope)}`;
		if (this.cached && this.cached.summaries === this.summaries && this.cached.key === key) return this.cached.report;
		const report = this.aggregateFor(this.scope, window, now);
		this.cached = { summaries: this.summaries, key, report };
		return report;
	}

	private aggregateFor(scope: DashboardScope, window: Window, now: Date): Report {
		const scoped = scopeToProject(this.summaries, scope.kind === "project" ? scope.project : undefined);
		if (scope.kind === "provider") {
			return aggregateSelection(scoped, window, { kind: "provider", provider: scope.provider }, now);
		}
		if (scope.kind === "model") {
			return aggregateSelection(scoped, window, { kind: "model", provider: scope.provider, model: scope.model }, now);
		}
		return aggregate(scoped, window, now);
	}

	private rowsNow(): DashRow[] {
		return sortRows(
			buildRows(this.reportNow(), rowKindForGrouping(effectiveGrouping({ scope: this.scope, grouping: this.grouping }))),
			this.sort,
		);
	}

	/** One panel height for the whole session; short reports are padded, not collapsed. */
	private viewHeight(now: Date): number {
		const rows = this.options.tui.terminal?.rows ?? 0;
		if (this.fixedHeight && this.fixedHeight.rows === rows) return this.fixedHeight.height;
		const all = aggregate(this.summaries, rangeWindow("all", now), now);
		const bodyRows = Math.max(all.byProvider.length + all.byModel.length + 1, all.byProject.length + 1);
		const height = Math.min(heightOf(this.options.tui), Math.max(MIN_VIEW_HEIGHT, bodyRows + CHROME_HEIGHT));
		this.fixedHeight = { rows, height };
		return height;
	}

	private drillIntoProject(): void {
		if (effectiveGrouping({ scope: this.scope, grouping: this.grouping }) !== "project") return;
		const row = this.rowsNow()[this.selected];
		if (row?.selection.kind === "project") this.setScope({ kind: "project", project: row.selection.project || undefined }, false);
	}

	private toggleGrouping(): void {
		if (this.scope.kind === "model") return;
		const next: Grouping =
			effectiveGrouping({ scope: this.scope, grouping: this.grouping }) === "provider" ? "project" : "provider";
		this.grouping = next;
		this.selected = 0;
		this.scroll = 0;
		this.status = `grouping → ${next === "project" ? "projects" : "providers"}`;
		this.requestRender();
	}

	private setScope(scope: DashboardScope, restore: boolean): void {
		this.scope = scope;
		this.grouping = undefined;
		this.selected = 0;
		this.scroll = 0;
		this.restorePosition = restore;
		this.status = undefined;
		this.requestRender();
	}

	private moveSelection(delta: number): void {
		const rows = this.rowsNow();
		const next = Math.min(Math.max(0, this.selected + delta), Math.max(0, rows.length - 1));
		if (next === this.selected) return;
		this.selected = next;
		this.status = undefined;
		this.savedPosition = { key: rows[next]?.key, index: next, scroll: this.scroll };
		this.requestRender();
	}

	private rememberPosition(): void {
		const rows = this.rowsNow();
		this.savedPosition = { key: rows[this.selected]?.key, index: this.selected, scroll: this.scroll };
	}

	private stepRange(delta: number): void {
		const index = RANGES.indexOf(this.range);
		this.setRange(RANGES[(index + delta + RANGES.length) % RANGES.length] as RangeKey);
	}

	private setRange(range: RangeKey): void {
		if (range === this.range) return;
		this.rememberPosition();
		this.range = range;
		this.selected = 0;
		this.scroll = 0;
		this.restorePosition = true;
		this.status = undefined;
		this.requestRender();
	}

	private cycleSort(): void {
		const selectedKey = this.rowsNow()[this.selected]?.key;
		const index = SORT_KEYS.indexOf(this.sort);
		this.sort = SORT_KEYS[(index + 1) % SORT_KEYS.length] as SortKey;
		const rows = this.rowsNow();
		const next = selectedKey === undefined ? 0 : rows.findIndex((row) => row.key === selectedKey);
		this.selected = Math.max(next, 0);
		this.status = `sort → ${SORT_LABELS[this.sort]}`;
		this.requestRender();
	}

	/** Rebuild the open picker's options against the current range. */
	private buildFilterRows(kind: FilterKind): DashRow[] {
		const now = this.options.now?.() ?? new Date();
		const current = aggregate(this.summaries, rangeWindow(this.range, now), now);
		const all = aggregate(this.summaries, rangeWindow("all", now), now);
		if (kind === "project") return buildProjectOptions(current, all, this.options.project, this.scope);
		if (kind === "provider") return buildProviderModelOptions(current, all, this.scope);
		const projects = buildProjectOptions(current, all, this.options.project, this.scope);
		const providerModels = buildProviderModelOptions(current, all, this.scope);
		return sortOptions([...projects, ...providerModels.slice(1)]);
	}

	private openFilter(kind: Exclude<FilterKind, "search">): void {
		this.rememberPosition();
		const rows = this.buildFilterRows(kind);
		this.filterRows = rows;
		this.filterKind = kind;
		this.filterQuery = "";
		this.filterSearch = false;
		this.filterSelected = rows.findIndex((row) => rowMatchesScope(row, this.scope));
		if (this.filterSelected < 0) this.filterSelected = Math.min(1, rows.length - 1);
		this.filterOpen = true;
		this.filterReturnScroll = this.scroll;
		this.scroll = 0;
		this.status = undefined;
		this.requestRender();
	}

	private openSearch(): void {
		this.rememberPosition();
		this.filterRows = this.buildFilterRows("search");
		this.filterKind = "search";
		this.filterQuery = "";
		this.filterSearch = true;
		const selected = this.filterRows.findIndex((row) => rowMatchesScope(row, this.scope));
		this.filterSelected = Math.max(selected, 0);
		this.filterOpen = true;
		this.filterReturnScroll = this.scroll;
		this.scroll = 0;
		this.status = undefined;
		this.requestRender();
	}

	/** Switch the range without closing the picker; option costs follow the new range. */
	private stepFilterRange(delta: number): void {
		const index = RANGES.indexOf(this.range);
		const next = RANGES[(index + delta + RANGES.length) % RANGES.length] as RangeKey;
		if (next === this.range) return;
		const selectedKey = this.visibleFilterRows()[this.filterSelected]?.key;
		this.range = next;
		this.filterRows = this.buildFilterRows(this.filterKind);
		const rows = this.visibleFilterRows();
		const found = selectedKey === undefined ? -1 : rows.findIndex((row) => row.key === selectedKey);
		this.filterSelected = found >= 0 ? found : Math.min(this.filterSelected, Math.max(0, rows.length - 1));
		this.restorePosition = true;
		this.status = undefined;
		this.requestRender();
	}

	private visibleFilterRows(): DashRow[] {
		if (!this.filterSearch || this.filterQuery === "") return this.filterRows;
		const query = this.filterQuery.toLowerCase();
		return this.filterRows.filter((row) => filterMatches(row, query));
	}

	private handleFilterInput(data: string): void {
		const rows = this.visibleFilterRows();
		if (matchesKey(data, Key.left)) {
			this.stepFilterRange(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.stepFilterRange(1);
			return;
		}
		if (this.filterSearch) {
			if (this.matches(data, "tui.select.cancel", Key.escape)) {
				if (this.filterQuery !== "") {
					this.filterQuery = "";
					this.filterSelected = 0;
					this.requestRender();
				} else {
					this.closeFilter(false);
				}
				return;
			}
			if (this.matches(data, "tui.select.confirm", Key.enter)) {
				if (rows.length > 0) this.closeFilter(true);
				return;
			}
			if (data === "\x7f" || data === "\b") {
				this.filterQuery = Array.from(this.filterQuery).slice(0, -1).join("");
				this.filterSelected = 0;
				this.requestRender();
				return;
			}
			let delta = 0;
			if (this.matches(data, "tui.select.down", Key.down)) delta = 1;
			else if (this.matches(data, "tui.select.up", Key.up)) delta = -1;
			else if (this.matches(data, "tui.select.pageDown", Key.pageDown)) delta = this.selectionPage;
			else if (this.matches(data, "tui.select.pageUp", Key.pageUp)) delta = -this.selectionPage;
			if (delta !== 0) {
				this.filterSelected = Math.min(Math.max(0, this.filterSelected + delta), Math.max(0, rows.length - 1));
				this.requestRender();
				return;
			}
			if (data.length > 0 && !hasControlCharacter(data)) {
				this.filterQuery += data;
				this.filterSelected = 0;
				this.requestRender();
			}
			return;
		}
		if (this.matches(data, "tui.select.cancel", Key.escape)) {
			this.closeFilter(false);
			return;
		}
		if (this.matches(data, "tui.select.confirm", Key.enter)) {
			if (rows.length > 0) this.closeFilter(true);
			return;
		}
		if (data === "/") {
			this.filterSearch = true;
			this.filterQuery = "";
			this.filterSelected = 0;
			this.requestRender();
			return;
		}
		const digit = Number.parseInt(data, 10);
		if (data.length === 1 && digit >= 1 && digit <= Math.min(9, rows.length)) {
			this.filterSelected = digit - 1;
			this.closeFilter(true);
			return;
		}
		let delta = 0;
		if (this.matches(data, "tui.select.down", Key.down)) delta = 1;
		else if (this.matches(data, "tui.select.up", Key.up)) delta = -1;
		else if (this.matches(data, "tui.select.pageDown", Key.pageDown)) delta = this.selectionPage;
		else if (this.matches(data, "tui.select.pageUp", Key.pageUp)) delta = -this.selectionPage;
		if (delta === 0) return;
		this.filterSelected = Math.min(Math.max(0, this.filterSelected + delta), Math.max(0, rows.length - 1));
		this.requestRender();
	}

	private closeFilter(apply: boolean): void {
		const rows = this.visibleFilterRows();
		if (apply && rows.length > 0) {
			const row = rows[this.filterSelected];
			if (row !== undefined) this.scope = scopeFromFilterRow(row);
			this.grouping = undefined;
			this.selected = 0;
			this.scroll = 0;
			this.restorePosition = true;
		} else {
			this.scroll = this.filterReturnScroll;
		}
		this.filterOpen = false;
		this.filterRows = [];
		this.filterQuery = "";
		this.filterSearch = false;
		this.status = undefined;
		this.requestRender();
	}

	private async refresh(): Promise<void> {
		if (this.closed || this.busy || !this.options.onRefresh) return;
		this.rememberPosition();
		this.busy = true;
		this.status = "refreshing…";
		this.requestRender();
		try {
			this.summaries = await this.options.onRefresh();
			if (this.closed) return;
			this.restorePosition = true;
			this.status = "refreshed from disk";
		} catch (error) {
			if (this.closed) return;
			this.status = `refresh failed: ${messageOf(error)}`;
		} finally {
			this.busy = false;
			this.requestRender();
		}
	}

	/** Close once; a late refresh must not render into a disposed view. */
	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.options.onClose();
	}

	private requestRender(): void {
		if (this.closed) return;
		this.options.tui.requestRender();
	}
}

function scopeKey(scope: DashboardScope): string {
	if (scope.kind === "project") return `project|${scope.project ?? ""}`;
	if (scope.kind === "provider") return `provider|${scope.provider}`;
	return `model|${scope.provider}|${scope.model}`;
}

function effectiveGrouping(state: Pick<DashboardState, "scope" | "grouping">): Grouping {
	return state.scope.kind === "model" ? "project" : (state.grouping ?? "provider");
}

function rowKindForGrouping(grouping: Grouping): RowKind {
	return grouping === "project" ? "project" : "provider";
}

function scopeFromFilterRow(row: DashRow): DashboardScope {
	if (row.selection.kind === "project") return { kind: "project", project: row.selection.project || undefined };
	if (row.selection.kind === "provider") {
		return row.selection.provider === "" ? { kind: "project" } : { kind: "provider", provider: row.selection.provider };
	}
	return row.selection.provider === ""
		? { kind: "project" }
		: { kind: "model", provider: row.selection.provider, model: row.selection.model };
}

function rowMatchesScope(row: DashRow, scope: DashboardScope): boolean {
	if (scope.kind === "project") {
		return row.selection.kind === "project" && (row.selection.project || undefined) === scope.project;
	}
	if (scope.kind === "provider") return row.selection.kind === "provider" && row.selection.provider === scope.provider;
	return row.selection.kind === "model" && row.selection.provider === scope.provider && row.selection.model === scope.model;
}

function optionRow(kind: RowKind, label: string, total: UsageTotal, selection: Selection): DashRow {
	return {
		key: rowKey(selection),
		selection,
		kind,
		provider: selection.kind === "provider" || selection.kind === "model" ? selection.provider : "",
		model: selection.kind === "model" ? selection.model : "",
		label,
		total,
	};
}

function sortOptions(rows: readonly DashRow[]): DashRow[] {
	return [...rows].sort((a, b) => {
		const difference = b.total.cost - a.total.cost;
		if (difference !== 0) return difference;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

function hasControlCharacter(text: string): boolean {
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

function filterMatches(row: DashRow, query: string): boolean {
	const label = row.label.toLowerCase();
	if (label.includes(query)) return true;
	if (row.selection.kind === "project" && row.selection.project !== "") {
		const path = row.selection.project.toLowerCase();
		if (path.includes(query)) return true;
		const leaf = path.split(/[\\/]/).at(-1) ?? "";
		if (leaf.includes(query)) return true;
	}
	if (row.kind === "model") return `${row.provider}/${row.model}`.toLowerCase().includes(query);
	return false;
}

function buildProjectOptions(current: Report, all: Report, cwd: string | undefined, scope: DashboardScope): DashRow[] {
	const currentTotals = new Map(current.byProject.map((row) => [row.project, row.total]));
	const rows: DashRow[] = [optionRow("project", "all projects", current.totals, { kind: "project", project: "" })];
	if (cwd !== undefined) {
		rows.push(optionRow("project", "this project", currentTotals.get(cwd) ?? emptyTotal(), { kind: "project", project: cwd }));
	}
	if (scope.kind === "project" && scope.project !== undefined && scope.project !== cwd) {
		rows.push(
			optionRow("project", scope.project, currentTotals.get(scope.project) ?? emptyTotal(), {
				kind: "project",
				project: scope.project,
			}),
		);
	}
	const pinned = new Set(rows.map((row) => (row.selection.kind === "project" ? row.selection.project : undefined)));
	const rest = all.byProject
		.filter((row) => !pinned.has(row.project))
		.map((row) =>
			optionRow("project", row.project, currentTotals.get(row.project) ?? emptyTotal(), {
				kind: "project",
				project: row.project,
			}),
		);
	rows.push(...sortOptions(rest));
	return rows;
}

function buildProviderOptions(current: Report, all: Report, scope: DashboardScope): DashRow[] {
	const currentTotals = new Map(current.byProvider.map((row) => [row.provider, row.total]));
	const rows: DashRow[] = [optionRow("provider", "all providers", current.totals, { kind: "provider", provider: "" })];
	const activeProvider = scope.kind === "provider" ? scope.provider : scope.kind === "model" ? scope.provider : undefined;
	if (activeProvider !== undefined) {
		rows.push(
			optionRow("provider", activeProvider, currentTotals.get(activeProvider) ?? emptyTotal(), {
				kind: "provider",
				provider: activeProvider,
			}),
		);
	}
	const pinned = new Set(rows.map((row) => row.provider));
	const rest = all.byProvider
		.filter((row) => !pinned.has(row.provider))
		.map((row) =>
			optionRow("provider", row.provider, currentTotals.get(row.provider) ?? emptyTotal(), {
				kind: "provider",
				provider: row.provider,
			}),
		);
	rows.push(...sortOptions(rest));
	return rows;
}

/** One picker for provider and provider/model scopes, mirroring the project picker. */
function buildProviderModelOptions(current: Report, all: Report, scope: DashboardScope): DashRow[] {
	const providers = buildProviderOptions(current, all, scope);
	const models = buildModelOptions(current, all, scope);
	return [...providers, ...models.slice(1)];
}

function buildModelOptions(current: Report, all: Report, scope: DashboardScope): DashRow[] {
	const currentTotals = new Map(current.byModel.map((row) => [`${row.provider}|${row.model}`, row.total]));
	const rows: DashRow[] = [optionRow("model", "all models", current.totals, { kind: "model", provider: "", model: "" })];
	if (scope.kind === "model") {
		const key = `${scope.provider}|${scope.model}`;
		rows.push(
			optionRow("model", `${scope.provider} · ${scope.model}`, currentTotals.get(key) ?? emptyTotal(), {
				kind: "model",
				provider: scope.provider,
				model: scope.model,
			}),
		);
	}
	const pinned = new Set(rows.map((row) => `${row.provider}|${row.model}`));
	const rest = all.byModel
		.filter((row) => !pinned.has(`${row.provider}|${row.model}`))
		.map((row) =>
			optionRow("model", `${row.provider} · ${row.model}`, currentTotals.get(`${row.provider}|${row.model}`) ?? emptyTotal(), {
				kind: "model",
				provider: row.provider,
				model: row.model,
			}),
		);
	rows.push(...sortOptions(rest));
	return rows;
}

function sortRows(rows: readonly DashRow[], sort: SortKey): DashRow[] {
	return [...rows].sort((a, b) => {
		const difference = sortValue(b.total, sort) - sortValue(a.total, sort);
		if (difference !== 0) return difference;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

function sortValue(total: UsageTotal, sort: SortKey): number {
	switch (sort) {
		case "cost":
			return total.cost;
		case "input":
			return total.input;
		case "output":
			return total.output;
		case "cacheRead":
			return total.cacheRead;
		case "cacheWrite":
			return total.cacheWrite;
		case "hit":
			return cacheHitRate(total) ?? -1;
		case "calls":
			return total.calls;
	}
}

/**
 * Keep the dock visible on small terminals: cap the panel at about 60% of the
 * terminal, leave four rows for the transcript/editor when they fit, and never
 * occupy the last row. A 5-line floor keeps the table useful, but a terminal
 * shorter than six rows gets a smaller panel rather than losing the editor
 * entirely.
 */
function heightOf(tui: DashTui): number {
	const rows = tui.terminal?.rows;
	if (typeof rows !== "number" || rows <= 0) return MAX_VIEW_HEIGHT;
	const proportional = Math.max(5, Math.floor(rows * 0.6));
	const withMargin = Math.max(5, rows - 4);
	const height = Math.min(MAX_VIEW_HEIGHT, proportional, withMargin);
	return Math.max(1, Math.min(height, rows - 1));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
