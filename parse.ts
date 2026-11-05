/**
 * Session-log parsing for the cost ledger.
 *
 * A pi session file is a JSONL log, and usage appears in four shapes in it:
 * assistant messages (the bulk of the spend), tool results of nested model
 * calls, standalone `usage` entries (cache warming is recorded separately), and
 * the summaries pi writes for compaction and `/tree` branch switches. All four
 * count toward pi's own session totals, so the ledger counts them too — a
 * report that disagrees with `/session` would be worse than no report.
 *
 * Parsing folds every record into a bucket keyed by local day, provider, and
 * model, and keeps a compact per-entry usage record so forked or branch-copied
 * history can be counted once. The index stores usage only — not transcript
 * content — while every query remains a pure aggregation over buckets.
 *
 * Tool results from nested calls and compaction/branch summaries record usage
 * without a provider or model, so they are grouped under the synthetic
 * `tools` / `summaries` bucket. Inventing the outer session model for them
 * would silently move spend between models even though the log never says
 * which model produced it. Pi's own cost breakdown groups the same entries as
 * "Tools/summaries" for the same reason.
 */

import { localDay } from "./time.ts";
import { emptyTotal, mergeTotals, type UsageTotal } from "./usage.ts";

export const UNKNOWN = "unknown";

/** Synthetic provider for usage whose entry records no provider/model. */
export const TOOLS_PROVIDER = "tools";

/** Synthetic model for tool results and compaction/branch summaries. */
export const TOOLS_MODEL = "summaries";

/** One usage-bearing session entry, kept so forked history can be counted once across files. */
export interface UsageRecord {
	/** Session entry id; fork and branch extraction preserve it. Missing in very old logs. */
	id?: string;
	/** `"<day>|<provider>|<model>"` bucket this entry contributes to. */
	bucket: string;
	/** The entry's totals; `calls` is 1 for one usage record. */
	total: UsageTotal;
}

/** Folded form of one session file, stored in the index and reused until the file changes. */
export interface SessionSummary {
	/** File stat at parse time; a mismatch means the file changed and must be re-read. */
	mtimeMs: number;
	size: number;
	/** Session header id; duplicated or copied files share it and are deduplicated once. */
	sessionId?: string;
	/** Working directory from the session header, the ledger's project key. */
	cwd?: string;
	/** Source session path for a fork or branch extraction; used to prefer the original history. */
	parentSession?: string;
	/** Session header timestamp; a stable tie-breaker when several files share copied entries. */
	createdAt?: string;
	/** `"<day>|<provider>|<model>"` → totals. */
	buckets: Record<string, UsageTotal>;
	/** Per-entry usage records; absent only in hand-written or legacy summaries. */
	records?: UsageRecord[];
}

/**
 * Loose entry shape, matched structurally: the ledger has to read logs written
 * by older pi versions, so unknown fields are ignored and missing ones fall
 * back rather than failing the parse.
 */
interface RawEntry {
	type?: unknown;
	timestamp?: unknown;
	provider?: unknown;
	model?: unknown;
	modelId?: unknown;
	responseModel?: unknown;
	usage?: unknown;
	cwd?: unknown;
	id?: unknown;
	parentSession?: unknown;
	message?: {
		role?: unknown;
		provider?: unknown;
		model?: unknown;
		responseModel?: unknown;
		usage?: unknown;
		timestamp?: unknown;
	};
}

/** One usage record reduced to numbers; `calls` is added by the caller. */
type UsageNumbers = Omit<UsageTotal, "calls">;

/**
 * Parse one session log into a summary. Never throws: a torn final line is
 * normal (pi appends while the file is read), and a corrupted middle line
 * should cost that entry, not the whole session.
 */
export function parseSession(text: string, meta: { mtimeMs: number; size: number }): SessionSummary {
	const buckets: Record<string, UsageTotal> = {};
	const records: UsageRecord[] = [];
	let sessionId: string | undefined;
	let cwd: string | undefined;
	let parentSession: string | undefined;
	let createdAt: string | undefined;
	let headerMomentMs: number | undefined;
	// The session's current model, tracked chronologically. Very old assistant
	// messages and usage entries may omit their attribution; only those fall
	// back to this. Tool results and summaries never do: the log gives no basis
	// for claiming the outer session model produced a nested call.
	let provider: string = UNKNOWN;
	let model: string = UNKNOWN;

	for (const rawLine of text.split("\n")) {
		// trim() also drops a UTF-8 BOM on the first line, which JSON.parse rejects.
		const line = rawLine.trim();
		if (line === "") continue;
		let entry: RawEntry;
		try {
			entry = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;

		if (entry.type === "session") {
			if (typeof entry.id === "string" && entry.id !== "") sessionId = entry.id;
			if (typeof entry.cwd === "string" && entry.cwd !== "") cwd = entry.cwd;
			if (typeof entry.parentSession === "string" && entry.parentSession !== "") parentSession = entry.parentSession;
			if (typeof entry.timestamp === "string") {
				createdAt = entry.timestamp;
				const parsed = Date.parse(entry.timestamp);
				if (Number.isFinite(parsed)) headerMomentMs = parsed;
			}
			continue;
		}
		if (entry.type === "model_change") {
			if (typeof entry.provider === "string") provider = entry.provider;
			const changedModel = modelOf(entry);
			if (changedModel !== undefined) model = changedModel;
			continue;
		}

		const record = readUsageEntry(entry);
		if (!record) continue;

		// Only assistant messages and `usage` entries describe the session's
		// current model. A tool result with explicit metadata describes a nested
		// call, so it must not change the sticky model used by later legacy
		// entries.
		const fromSessionModel = record.source === "assistant" || record.source === "usage";
		if (fromSessionModel) {
			if (record.provider !== undefined) provider = record.provider;
			if (record.model !== undefined) model = record.model;
		}

		let bucketProvider = record.provider;
		let bucketModel = record.model;
		if (bucketProvider === undefined && bucketModel === undefined) {
			if (fromSessionModel) {
				bucketProvider = provider;
				bucketModel = model;
			} else {
				bucketProvider = TOOLS_PROVIDER;
				bucketModel = TOOLS_MODEL;
			}
		} else {
			// Never pair one half of an entry's attribution with the sticky
			// model: an unknown half is more honest than a plausible mismatch.
			bucketProvider ??= UNKNOWN;
			bucketModel ??= UNKNOWN;
		}

		const day = localDay(entryMoment(entry, headerMomentMs ?? meta.mtimeMs));
		const key = bucketKey(day, bucketProvider, bucketModel);
		const total: UsageTotal = { ...record.numbers, calls: 1 };
		const bucket = buckets[key] ?? emptyTotal();
		mergeTotals(bucket, total);
		buckets[key] = bucket;
		const usageRecord: UsageRecord = { bucket: key, total: { ...total } };
		if (typeof entry.id === "string" && entry.id !== "") usageRecord.id = entry.id;
		records.push(usageRecord);
	}

	return {
		mtimeMs: meta.mtimeMs,
		size: meta.size,
		...(sessionId !== undefined ? { sessionId } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		...(parentSession !== undefined ? { parentSession } : {}),
		...(createdAt !== undefined ? { createdAt } : {}),
		buckets,
		records,
	};
}

/** Which kind of entry produced a usage record; controls attribution fallback. */
type UsageSource = "assistant" | "tool" | "usage" | "summary";

/** A usage-bearing entry: its numbers, source, and the model it names when it names one. */
function readUsageEntry(
	entry: RawEntry,
): { numbers: UsageNumbers; source: UsageSource; provider?: string; model?: string } | undefined {
	const message = entry.message;
	let value: unknown;
	let source: UsageSource;

	if (message && (message.role === "assistant" || message.role === "toolResult") && message.usage) {
		value = message.usage;
		source = message.role === "assistant" ? "assistant" : "tool";
	} else if (entry.type === "usage" && entry.usage) {
		value = entry.usage;
		source = "usage";
	} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
		value = entry.usage;
		source = "summary";
	} else {
		return undefined;
	}

	const numbers = readUsageNumbers(value);
	if (!numbers) return undefined;

	// Assistant messages and usage entries name their provider and model. Tool
	// results of nested calls usually do not, and summaries never do; the
	// caller groups those unattributed records under `tools/summaries`.
	const owner = message && message.usage === value ? message : entry;
	return {
		numbers,
		source,
		provider: typeof owner.provider === "string" && owner.provider !== "" ? owner.provider : undefined,
		model: modelOf(owner),
	};
}

function modelOf(owner: { model?: unknown; modelId?: unknown; responseModel?: unknown }): string | undefined {
	// responseModel is what the provider actually served. A fallback or alias
	// therefore belongs to the model that billed the call, not the request id.
	if (typeof owner.responseModel === "string" && owner.responseModel !== "") return owner.responseModel;
	if (typeof owner.model === "string" && owner.model !== "") return owner.model;
	if (typeof owner.modelId === "string" && owner.modelId !== "") return owner.modelId;
	return undefined;
}

/**
 * Reduce a raw usage object to finite numbers. Returns `undefined` for an
 * all-zero record: providers emit one for some failed calls, and counting it
 * would inflate the call count and create empty buckets.
 */
function readUsageNumbers(value: unknown): UsageNumbers | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: unknown };
	const numbers: UsageNumbers = {
		input: count(raw.input),
		output: count(raw.output),
		cacheRead: count(raw.cacheRead),
		cacheWrite: count(raw.cacheWrite),
		cost: costOf(raw.cost),
	};
	const spent = numbers.input + numbers.output + numbers.cacheRead + numbers.cacheWrite + numbers.cost;
	return spent === 0 ? undefined : numbers;
}

/** `cost` is `{ total }` in pi's records; a bare number is accepted as a legacy shape. */
function costOf(cost: unknown): number {
	if (typeof cost === "number") return count(cost);
	if (typeof cost === "object" && cost !== null) return count((cost as { total?: unknown }).total);
	return 0;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * When the entry was written. The entry timestamp is authoritative; older
 * entries only stamped the message, and anything older still falls back to the
 * file's mtime so its tokens land on some day instead of being dropped.
 */
function entryMoment(entry: RawEntry, fallbackMs: number): Date {
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return new Date(parsed);
	}
	if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return new Date(entry.timestamp);
	const messageTimestamp = entry.message?.timestamp;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return new Date(messageTimestamp);
	return new Date(fallbackMs);
}

/** The index bucket key. Days and model ids never contain `|`; providers do not either. */
export function bucketKey(day: string, provider: string, model: string): string {
	return `${day}|${provider}|${model}`;
}

/**
 * Split a bucket key back into its parts. A malformed key degrades to the
 * unknown model instead of throwing: the index is a cache file that a user may
 * edit or a crashed write may truncate.
 */
export function splitBucketKey(key: string): { day: string; provider: string; model: string } {
	const first = key.indexOf("|");
	if (first < 0) return { day: key, provider: UNKNOWN, model: UNKNOWN };
	const second = key.indexOf("|", first + 1);
	if (second < 0) return { day: key.slice(0, first), provider: key.slice(first + 1), model: UNKNOWN };
	return { day: key.slice(0, first), provider: key.slice(first + 1, second), model: key.slice(second + 1) };
}
