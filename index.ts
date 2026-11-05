/**
 * pi-cost-ledger
 *
 * `/cost` answers what the session view cannot: what this month cost, which
 * models and projects the money went to, how fast it is going, and how much of
 * the prompt was served from cache. Everything is derived from the session logs
 * pi already keeps under `<agent-dir>/sessions` — no network, no new data
 * collection, nothing that has not already been written to disk.
 *
 * The extension is deliberately passive: it registers one command and touches
 * disk only when that command runs. There is no footer, no timer, no work on
 * startup, so an idle pi process pays nothing for having it installed.
 *
 * Commands, with the default bracketed:
 *   /cost                     interactive view for the default range [today],
 *                             opening with the current-project scope
 *   /cost today|7d|30d|all    plain-text panel for one range
 *   /cost text [range] [scope] plain-text panel for the default or given range
 *   /cost default <range> [scope] set the opening range and plain-text scope
 *   /cost refresh             re-read every session file, then open the view
 *   /cost help                commands and how the numbers are produced
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

import { DashboardView } from "./dashboard.ts";
import { aggregate, isRangeKey, isScope, type RangeKey, rangeWindow, type Scope, scopeToProject } from "./ledger.ts";
import type { SessionSummary } from "./parse.ts";
import { renderPanel, scopeLabel } from "./render.ts";
import { dedupeSummaries, type LedgerIndex, parseIndex, scanSessions, writeIndex } from "./sessions.ts";
import { type LedgerSettings, parseSettings, serializeSettings } from "./settings.ts";

const HINT = "/cost (interactive) · /cost today|7d|30d|all (text) · /cost help";

const HELP = [
	"Cost ledger — spend recorded by pi across every local session",
	"",
	"/cost                         interactive view (today, current project scope)",
	"/cost today|7d|30d|all        plain-text panel for one range",
	"/cost <range> project|all     widen or narrow the scope",
	"/cost text [range] [scope]    plain-text panel for the default view",
	"/cost default <range> [scope] set the opening range and plain-text scope",
	"/cost refresh                 re-read every session file, then open the view",
	"/cost help                    this list",
	"",
	"The interactive view opens with the current project as its scope. 1-4 and",
	"←/→ switch the range in the table; ←/→ also work while a picker is open.",
	"p/P opens the project picker, m the provider/model picker, v pivots between",
	"provider/model and project rows without changing the scope or total, and /",
	"searches all scopes. ↑/↓ selects, PgUp/PgDn pages, 1-9 applies a picker",
	"option, and Enter applies the selected option or focuses a project in project",
	"grouping. In a search, digits type into the query. Esc clears a search,",
	"cancels a picker, or quits the table; q quits too, s sorts, and r re-reads",
	"the session files.",
	"",
	"Tokens come from provider usage records; cost is what pi recorded when the",
	"call ran (catalog estimate, or provider-reported billed cost where pi has",
	"it). Cache is the cumulative share of prompt tokens served from the prompt",
	"cache. Tool results and summaries whose log entry names no provider or model",
	"are grouped under tools/summaries. Ranges are whole local days. Everything",
	"stays on this machine.",
].join("\n");

interface Subcommand {
	value: string;
	label: string;
	description: string;
}

/** The four ranges, in completion order; also what `/cost default` accepts. */
const RANGE_SUBCOMMANDS: Subcommand[] = [
	{ value: "today", label: "today", description: "spend since local midnight" },
	{ value: "7d", label: "7d", description: "spend for the last 7 days" },
	{ value: "30d", label: "30d", description: "spend for the last 30 days" },
	{ value: "all", label: "all", description: "spend across every recorded session" },
];

const SUBCOMMANDS: Subcommand[] = [
	...RANGE_SUBCOMMANDS,
	{ value: "text", label: "text", description: "plain-text panel instead of the interactive view" },
	{ value: "default", label: "default", description: "set the default range and plain-text scope" },
	{ value: "refresh", label: "refresh", description: "re-read every session file instead of reusing the index" },
	{ value: "help", label: "help", description: "list commands and explain the numbers" },
];

/** The scope words accepted after a range and by `/cost default`. */
const SCOPE_SUBCOMMANDS: Subcommand[] = [
	{ value: "project", label: "project", description: "only the project pi is running in" },
	{ value: "all", label: "all", description: "every project on this machine" },
];

/** The words that can fill argument position `argument` of a subcommand. */
function vocabularyFor(sub: string, argument: number): Subcommand[] {
	// `/cost default <range> [scope]` and `/cost text <range> [scope]` take a
	// range first; a bare `/cost <range> [scope]` starts with one.
	if (sub === "default" || sub === "text") {
		if (argument === 0) return RANGE_SUBCOMMANDS;
		return argument === 1 ? SCOPE_SUBCOMMANDS : [];
	}
	if (isRangeKey(sub)) return argument === 0 ? SCOPE_SUBCOMMANDS : [];
	return [];
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("cost", {
		description: "Spend, tokens, and cache efficiency across every local pi session",
		getArgumentCompletions: (prefix) => {
			const lowered = prefix.toLowerCase();
			const startingWord = /\s$/.test(prefix);
			const words = lowered.trim().split(/\s+/).filter(Boolean);
			const sub = words[0] ?? "";
			const completing = startingWord ? "" : (words[words.length - 1] ?? "");
			// Which argument is being typed: -1 while the subcommand itself is
			// still being completed, 0 for the first argument, and so on. A
			// trailing space means a new argument has started.
			const argument = startingWord ? words.length - 1 : words.length > 1 ? words.length - 2 : -1;
			const head = prefix.slice(0, prefix.length - completing.length);
			const candidates = argument < 0 ? SUBCOMMANDS : vocabularyFor(sub, argument);
			return candidates
				.filter((candidate) => candidate.value.startsWith(completing))
				.map((candidate) => ({
					value: `${head}${candidate.value}`,
					label: candidate.label,
					description: candidate.description,
				}));
		},
		handler: async (args, ctx) => {
			try {
				await run(args, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				emit(ctx, `cost ledger failed: ${message}`, "error");
			}
		},
	});
}

async function run(args: string, ctx: ExtensionContext): Promise<void> {
	const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const [sub = ""] = words;

	if (sub === "help" || sub === "-h" || sub === "--help") {
		emit(ctx, HELP, "info");
		return;
	}
	if (sub === "default") {
		await setDefault(words.slice(1), ctx);
		return;
	}
	if (sub === "refresh") {
		if (words.length > 1) {
			emit(ctx, "/cost refresh takes no arguments", "warning");
			return;
		}
		const settings = await loadSettings();
		// The interactive view is always project-scoped, but a plain-text refresh
		// should use the same saved scope as every other text report.
		const scope: Scope = ctx.mode === "tui" ? "project" : settings.scope;
		await present(ctx, settings.range, scope, { force: true });
		return;
	}
	if (sub === "text") {
		const [rangeArg, scopeArg, ...rest] = words.slice(1);
		if (rest.length > 0) {
			emit(ctx, `too many arguments for /cost text\n${HINT}`, "warning");
			return;
		}
		if (rangeArg !== undefined && !isRangeKey(rangeArg)) {
			emit(ctx, `unknown range "${rangeArg}" — use today, 7d, 30d, or all`, "warning");
			return;
		}
		if (scopeArg !== undefined && !isScope(scopeArg)) {
			emit(ctx, `unknown scope "${scopeArg}" — use project or all`, "warning");
			return;
		}
		const settings = await loadSettings();
		const range = rangeArg !== undefined ? (rangeArg as RangeKey) : settings.range;
		const scope = scopeArg !== undefined ? (scopeArg as Scope) : settings.scope;
		await showPanel(ctx, range, scope);
		return;
	}
	if (sub === "") {
		const settings = await loadSettings();
		// The interactive home is always the current project. The persisted scope
		// remains the default for explicit plain-text reports.
		await present(ctx, settings.range, "project");
		return;
	}
	if (isRangeKey(sub)) {
		// A range argument is the quick, copyable answer: no modal, just text.
		const [requested, ...rest] = words.slice(1);
		if (rest.length > 0) {
			emit(ctx, `too many arguments for /cost ${sub}\n${HINT}`, "warning");
			return;
		}
		if (requested !== undefined && !isScope(requested)) {
			emit(ctx, `unknown scope "${requested}" — use project or all`, "warning");
			return;
		}
		const settings = await loadSettings();
		await showPanel(ctx, sub, requested !== undefined ? (requested as Scope) : settings.scope);
		return;
	}
	emit(ctx, `unknown option "${sub}"\n${HINT}`, "warning");
}

async function setDefault(words: readonly string[], ctx: ExtensionContext): Promise<void> {
	const [range, scope, ...rest] = words;
	if (rest.length > 0) {
		emit(ctx, `too many arguments for /cost default\n${HINT}`, "warning");
		return;
	}
	if (range === undefined || !isRangeKey(range)) {
		emit(
			ctx,
			range === undefined
				? `/cost default <today|7d|30d|all> [project|all]`
				: `unknown range "${range}" — use today, 7d, 30d, or all`,
			"warning",
		);
		return;
	}
	if (scope !== undefined && !isScope(scope)) {
		emit(ctx, `unknown scope "${scope}" — use project or all`, "warning");
		return;
	}
	const current = await loadSettings();
	const next: LedgerSettings = { range, scope: scope === undefined ? current.scope : (scope as Scope) };
	await saveSettings(next);
	const where = next.scope === "project" ? "this project" : "all projects";
	emit(ctx, `default range: ${rangeWindow(range).label} · plain-text scope: ${where}`, "info");
}

/**
 * Open the interactive view when the terminal can host one, the plain panel
 * otherwise. Print, JSON, and RPC modes have no keyboard and no viewport, so
 * they keep getting the text panel there. The TUI always starts with the
 * current-project scope; `scope` applies to the plain-text fallback.
 */
async function present(ctx: ExtensionContext, range: RangeKey, scope: Scope, options: { force?: boolean } = {}): Promise<void> {
	const project = projectCwd(ctx);
	if (ctx.mode !== "tui") {
		await showPanel(ctx, range, scope, options);
		return;
	}

	const summaries = await loadSummaries(ctx, options);
	if (!reportable(ctx, summaries)) return;

	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new DashboardView({
				summaries,
				range,
				project,
				home: homedir(),
				theme,
				tui,
				keybindings,
				onRefresh: () => loadSummaries(ctx, { force: true }),
				onClose: () => done(undefined),
			}),
		{ overlay: false },
	);
}

/**
 * Scan, aggregate, render, notify.
 *
 * The index is loaded and written around the scan, but a failure on either side
 * is not fatal: the scan itself is the source of truth, so an unreadable index
 * only means a full re-read, and an unwritable one only means the next `/cost`
 * re-reads too. Neither is worth interrupting the reader with.
 */
async function showPanel(ctx: ExtensionContext, range: RangeKey, scope: Scope, options: { force?: boolean } = {}): Promise<void> {
	const summaries = await loadSummaries(ctx, options);
	if (!reportable(ctx, summaries)) return;

	const project = scope === "project" ? projectCwd(ctx) : undefined;
	const scoped = scopeToProject(summaries, project);
	const now = new Date();
	const window = rangeWindow(range, now);
	const report = aggregate(scoped, window, now);
	// Three fixed rows of context: the selected range in context of today and
	// the month, which is the comparison the ledger exists for.
	const overview = (["today", "7d", "30d"] as const).map((key) => {
		const overviewWindow = rangeWindow(key, now);
		return { label: overviewWindow.label, total: aggregate(scoped, overviewWindow, now).totals };
	});

	emit(
		ctx,
		renderPanel(report, {
			title: `Cost — ${window.label} · ${scopeLabel(project, homedir())}`,
			home: homedir(),
			overview,
			showProjects: project === undefined,
			hint: HINT,
		}),
		"info",
	);
}

/** True when there is history to report; otherwise pi has no sessions for this agent directory yet. */
function reportable(ctx: ExtensionContext, summaries: readonly SessionSummary[]): boolean {
	if (summaries.length > 0) return true;
	emit(ctx, `no pi sessions recorded under ${sessionRoots(ctx).join(", ")} yet`, "info");
	return false;
}

/** Load the index, bring it up to date with disk, and persist it when the scan changed anything. */
async function loadSummaries(ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<SessionSummary[]> {
	const indexPath = join(getAgentDir(), "cost-ledger.json");
	const previous: LedgerIndex | undefined = parseIndex(await readText(indexPath));
	const scan = await scanSessions(sessionRoots(ctx), previous, options);
	const timeZoneChanged = previous !== undefined && previous.timeZone !== scan.index.timeZone;
	if (scan.parsed > 0 || scan.removed > 0 || timeZoneChanged) {
		await writeIndex(indexPath, scan.index).catch(() => {
			// The index is only a cache; a failed write costs a rescan, not data.
		});
	}
	if (scan.unreadable > 0) {
		const sources = scan.unreadable === 1 ? "source" : "sources";
		emit(
			ctx,
			`cost ledger: ${scan.unreadable} session ${sources} could not be read; results may be incomplete or use cached totals`,
			"warning",
		);
	}
	return dedupeSummaries(scan.index.files);
}

/** The project pi is running in; the session header is the authoritative key when available. */
function projectCwd(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getCwd?.() ?? ctx.cwd;
}

/** Every place pi may keep session logs: the default root plus the current configured directory. */
function sessionRoots(ctx: ExtensionContext): string[] {
	const roots = new Set<string>([join(getAgentDir(), "sessions")]);
	const current = ctx.sessionManager?.getSessionDir?.();
	if (typeof current === "string" && current !== "") {
		roots.add(current);
	} else {
		const configured = process.env.PI_CODING_AGENT_SESSION_DIR;
		if (configured) roots.add(expandHome(configured));
	}
	return [...roots];
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function settingsPath(): string {
	return join(getAgentDir(), "cost-settings.json");
}

async function loadSettings(): Promise<LedgerSettings> {
	return parseSettings(await readText(settingsPath()));
}

async function saveSettings(settings: LedgerSettings): Promise<void> {
	const path = settingsPath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, serializeSettings(settings), "utf8");
	await rename(temporary, path);
}

/** Emit a message through the UI when one exists, or through stderr in non-UI modes. */
function emit(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// pi reserves stdout for the model/JSON stream; command output belongs on stderr.
	process.stderr.write(`${message}\n`);
}

/** Read a file that may legitimately not exist yet: a missing file is `undefined`, not an error. */
async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}
