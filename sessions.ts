/**
 * Session discovery and the on-disk index.
 *
 * Pi writes one append-only JSONL log per session under
 * `<agent-dir>/sessions/<encoded-cwd>/`. The ledger keeps a small index of
 * per-file summaries and re-reads only files whose size or mtime changed, so a
 * `/cost` after months of history costs a few hundred stat calls, not a
 * re-parse of every log.
 *
 * The index is a cache, never a source of truth: a missing, corrupted, or
 * outdated file degrades to a full rescan, and a failed write only costs that
 * rescan on the next invocation.
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { parseSession, type SessionSummary, type UsageRecord } from "./parse.ts";
import { emptyTotal, mergeTotals, type UsageTotal } from "./usage.ts";

/**
 * Bumped whenever parsing or bucket semantics change, so an older index is
 * discarded instead of mixing summaries produced by different rules.
 */
export const INDEX_VERSION = 4;

export interface LedgerIndex {
	version: number;
	/**
	 * The local time zone the day keys were computed in. Day keys are local
	 * dates, so a zone change silently re-buckets every session — the index has
	 * to be rebuilt rather than partially reused.
	 */
	timeZone: string;
	/** Absolute session path → summary. */
	files: Record<string, SessionSummary>;
}

export function currentTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
}

export function emptyIndex(timeZone: string = currentTimeZone()): LedgerIndex {
	return { version: INDEX_VERSION, timeZone, files: {} };
}

/**
 * Parse an index file. Returns `undefined` — never partial data — when the
 * shape is wrong, so the caller falls back to a scan instead of trusting a
 * half-torn index. Individual invalid file entries are dropped.
 */
export function parseIndex(text: string | undefined): LedgerIndex | undefined {
	if (!text) return undefined;
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return undefined;
		const file = raw as { version?: unknown; timeZone?: unknown; files?: unknown };
		if (file.version !== INDEX_VERSION || typeof file.timeZone !== "string") return undefined;
		if (typeof file.files !== "object" || file.files === null) return undefined;

		const files: Record<string, SessionSummary> = {};
		for (const [path, summary] of Object.entries(file.files)) {
			if (!isSummary(summary)) continue;
			// Define instead of assigning so a crafted "__proto__" key cannot
			// mutate the prototype of the files map.
			Object.defineProperty(files, path, { value: summary, enumerable: true, configurable: true, writable: true });
		}
		return { version: INDEX_VERSION, timeZone: file.timeZone, files };
	} catch {
		return undefined;
	}
}

export function serializeIndex(index: LedgerIndex): string {
	return JSON.stringify(index);
}

/** Every `.jsonl` file directly under a sessions root or one directory below it, sorted and deduplicated. */
export async function discover(root: string | readonly string[]): Promise<string[]> {
	return (await discoverWithFailures(root)).paths;
}

/**
 * Discovery plus a count of roots/subdirectories that failed for a reason other
 * than "does not exist". A missing sessions directory is normal on a fresh
 * install; a permission error or an unavailable mount is not.
 */
export async function discoverWithFailures(root: string | readonly string[]): Promise<{ paths: string[]; failures: number }> {
	const paths = new Set<string>();
	let failures = 0;
	for (const base of typeof root === "string" ? [root] : root) {
		failures += await discoverRoot(base, paths);
	}
	return { paths: [...paths].sort(), failures };
}

function isMissing(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

async function discoverRoot(root: string, paths: Set<string>): Promise<number> {
	let failures = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		// A fresh install has no sessions directory yet; anything else means the
		// caller should know that cached history could not be checked.
		return isMissing(error) ? 0 : 1;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			// A custom --session-dir stores files directly in the directory.
			paths.add(join(root, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const directory = join(root, entry.name);
		let files: Dirent[];
		try {
			files = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (!isMissing(error)) failures += 1;
			continue; // removed between the two reads
		}
		for (const file of files) {
			if (file.isFile() && file.name.endsWith(".jsonl")) paths.add(join(directory, file.name));
		}
	}
	return failures;
}

export interface ScanResult {
	index: LedgerIndex;
	/** Files read and parsed in this scan. */
	parsed: number;
	/** Files taken from the previous index because their stat did not change. */
	reused: number;
	/** Files that disappeared from disk since the previous index. */
	removed: number;
	/**
	 * Sources that exist but could not be read now (permission, mount, or IO
	 * errors). Their cached summaries are kept so a transient failure does not
	 * make history disappear from the report.
	 */
	unreadable: number;
}

/** True when `path` is inside one of the configured session roots. */
function underAnyRoot(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const rel = relative(root, path);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	});
}

/**
 * Bring the index up to date with disk. `force` re-reads every file, which is
 * the escape hatch for a file whose content changed without its size or mtime
 * changing — rare, and cheaper to support than to explain away.
 */
export async function scanSessions(
	root: string | readonly string[],
	previous: LedgerIndex | undefined,
	options: { force?: boolean } = {},
): Promise<ScanResult> {
	const timeZone = currentTimeZone();
	const reusable = previous !== undefined && previous.timeZone === timeZone ? previous.files : {};
	const index = emptyIndex(timeZone);
	const roots = typeof root === "string" ? [root] : [...root];
	const discovery = await discoverWithFailures(root);
	let parsed = 0;
	let reused = 0;
	let unreadable = discovery.failures;

	// Discovery can miss files when a directory read fails temporarily or a
	// dirent's type is unavailable. Retrying every previously indexed path that
	// still belongs to a configured root recovers those files, while a path that
	// was removed from the configuration is dropped instead of being scanned
	// forever.
	const candidates = new Set(discovery.paths);
	for (const path of Object.keys(reusable)) {
		if (underAnyRoot(path, roots)) candidates.add(path);
	}

	for (const path of candidates) {
		const cached = reusable[path];
		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(path);
		} catch (error) {
			if (cached !== undefined && !isMissing(error)) {
				// Keep the last known summary across a transient stat failure; a
				// genuinely deleted file fails with ENOENT and is pruned below.
				index.files[path] = cached;
				unreadable += 1;
			} else if (!isMissing(error)) {
				unreadable += 1;
			}
			continue;
		}
		if (!stats.isFile()) continue;

		if (!options.force && cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			index.files[path] = cached;
			reused += 1;
			continue;
		}

		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (cached !== undefined && !isMissing(error)) {
				// The file exists but cannot be read right now. Keeping the cached
				// totals is closer to the truth than dropping the session.
				index.files[path] = cached;
				unreadable += 1;
			} else if (!isMissing(error)) {
				unreadable += 1;
			}
			continue; // a file deleted between stat and read is simply gone
		}
		index.files[path] = parseSession(text, { mtimeMs: stats.mtimeMs, size: stats.size });
		parsed += 1;
	}

	const removed = previous === undefined ? 0 : Object.keys(previous.files).filter((path) => !(path in index.files)).length;
	return { index, parsed, reused, removed, unreadable };
}

/**
 * Collapse copied usage records across fork and branch-extraction files.
 *
 * Pi copies entries (including their ids and usage) when a session is forked or
 * a branch is extracted into a new file. The copied records are not new spend,
 * so each copy may contribute only once to the ledger. Files are visited in
 * provenance order: an original session before its children, then by header
 * creation time and path. That keeps copied history attributed to the original
 * project whenever the original file is still on disk.
 *
 * The dedupe key is the entry id **plus its bucket and totals**, and comparison
 * is scoped to one provenance tree. Pi's ids are only eight hex characters and
 * are collision-checked within one session, not across the machine, so an id
 * alone is not a safe global key: two unrelated entries can share one. A real
 * fork copy repeats the bucket and totals exactly. Independent sessions share
 * no parent chain and are therefore never compared, even in the vanishingly
 * unlikely case that an id and all totals collide.
 */
export function dedupeSummaries(files: Record<string, SessionSummary>): SessionSummary[] {
	const entries = Object.entries(files);
	const ranks = new Map<string, number>();
	const rank = (path: string, visiting: Set<string>): number => {
		const cached = ranks.get(path);
		if (cached !== undefined) return cached;
		const parent = files[path]?.parentSession;
		if (parent === undefined || !(parent in files) || visiting.has(parent)) {
			ranks.set(path, 0);
			return 0;
		}
		visiting.add(path);
		const value = 1 + rank(parent, visiting);
		visiting.delete(path);
		ranks.set(path, value);
		return value;
	};

	entries.sort(([pathA, a], [pathB, b]) => {
		const rankDifference = rank(pathA, new Set()) - rank(pathB, new Set());
		if (rankDifference !== 0) return rankDifference;
		const createdDifference = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
		if (createdDifference !== 0) return createdDifference;
		return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
	});

	// A file may only dedupe against its own provenance tree. A missing parent
	// still names the tree, so two forks of a deleted original share one root and
	// their copied entries still collapse; two unrelated sessions never do. A
	// session header id groups byte-identical copies of the same file reached
	// through different paths (symlinks, hard links, or two roots).
	const roots = new Map<string, string>();
	const provenanceRoot = (path: string, visiting: Set<string>): string => {
		const cached = roots.get(path);
		if (cached !== undefined) return cached;
		const summary = files[path];
		const parent = summary?.parentSession;
		const ownRoot = summary?.sessionId === undefined ? `path:${path}` : `session:${summary.sessionId}`;
		if (parent === undefined || parent === "" || parent === path || visiting.has(path)) {
			roots.set(path, ownRoot);
			return ownRoot;
		}
		let root: string;
		if (!(parent in files)) {
			root = `parent:${parent}`;
		} else {
			visiting.add(path);
			root = provenanceRoot(parent, visiting);
			visiting.delete(path);
		}
		roots.set(path, root);
		return root;
	};

	const seenByRoot = new Map<string, Set<string>>();
	const result: SessionSummary[] = [];
	for (const [path, summary] of entries) {
		if (summary.records === undefined) {
			// A hand-written or pre-dedupe summary has no entry ids to compare.
			result.push(summary);
			continue;
		}

		const root = provenanceRoot(path, new Set());
		let seen = seenByRoot.get(root);
		if (seen === undefined) {
			seen = new Set<string>();
			seenByRoot.set(root, seen);
		}

		const unique: UsageRecord[] = [];
		let changed = false;
		for (const record of summary.records) {
			const signature = recordSignature(record);
			if (signature !== undefined) {
				if (seen.has(signature)) {
					changed = true;
					continue;
				}
				seen.add(signature);
			}
			unique.push(record);
		}
		if (!changed) {
			result.push(summary);
			continue;
		}

		const buckets: Record<string, UsageTotal> = {};
		for (const record of unique) {
			const bucket = buckets[record.bucket] ?? emptyTotal();
			mergeTotals(bucket, record.total);
			buckets[record.bucket] = bucket;
		}
		result.push({ ...summary, buckets, records: unique });
	}
	return result;
}

/**
 * Identity of a copied usage record. Includes the content, not just the id,
 * because pi ids are short and only unique within a session. Returns undefined
 * for very old entries without an id, which cannot be deduplicated safely.
 */
function recordSignature(record: UsageRecord): string | undefined {
	if (record.id === undefined) return undefined;
	return [
		record.id,
		record.bucket,
		record.total.input,
		record.total.output,
		record.total.cacheRead,
		record.total.cacheWrite,
		record.total.cost,
		record.total.calls,
	].join("|");
}

/**
 * Write the index atomically. Another pi process may scan and write at the same
 * time; the rename means a reader always sees one complete index, and the last
 * writer wins with an equally valid one.
 */
export async function writeIndex(path: string, index: LedgerIndex): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	// A unique suffix keeps two concurrent scans in the same process from
	// overwriting each other's temporary file before either rename runs.
	const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, serializeIndex(index), "utf8");
	await rename(temporary, path);
}

function isSummary(value: unknown): value is SessionSummary {
	if (typeof value !== "object" || value === null) return false;
	const summary = value as {
		mtimeMs?: unknown;
		size?: unknown;
		sessionId?: unknown;
		cwd?: unknown;
		parentSession?: unknown;
		createdAt?: unknown;
		buckets?: unknown;
		records?: unknown;
	};
	if (typeof summary.mtimeMs !== "number" || !Number.isFinite(summary.mtimeMs)) return false;
	if (typeof summary.size !== "number" || !Number.isFinite(summary.size)) return false;
	if (summary.sessionId !== undefined && (typeof summary.sessionId !== "string" || summary.sessionId === "")) return false;
	if (summary.cwd !== undefined && typeof summary.cwd !== "string") return false;
	if (summary.parentSession !== undefined && typeof summary.parentSession !== "string") return false;
	if (summary.createdAt !== undefined && typeof summary.createdAt !== "string") return false;
	if (typeof summary.buckets !== "object" || summary.buckets === null) return false;
	if (!Object.entries(summary.buckets).every(([key, total]) => isBucketKey(key) && isTotal(total))) return false;
	if (summary.records !== undefined) {
		if (!Array.isArray(summary.records) || !summary.records.every(isUsageRecord)) return false;
	}
	return true;
}

/** The ledger always writes `<YYYY-MM-DD>|<provider>|<model>` keys. */
function isBucketKey(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}\|/.test(value);
}

function isUsageRecord(value: unknown): value is UsageRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { id?: unknown; bucket?: unknown; total?: unknown };
	if (record.id !== undefined && (typeof record.id !== "string" || record.id === "")) return false;
	return isBucketKey(record.bucket) && isTotal(record.total);
}

function isTotal(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const total = value as Record<string, unknown>;
	return ["input", "output", "cacheRead", "cacheWrite", "cost", "calls"].every(
		(field) => typeof total[field] === "number" && Number.isFinite(total[field]) && (total[field] as number) >= 0,
	);
}
