/**
 * Persisted preferences (`<agent-dir>/cost-settings.json`).
 *
 * Parsing and serialization are pure so they can be tested; file I/O lives in
 * the extension entry. An unreadable file is not an error: it falls back to the
 * defaults, because a ledger with a lost preference should still open.
 *
 * The defaults answer the question a ledger is opened for most often — what am
 * I spending *right now, in this repo* — and every wider view is one key away.
 */

import { DEFAULT_RANGE, isRangeKey, isScope, type RangeKey, type Scope } from "./ledger.ts";

export interface LedgerSettings {
	/** The range `/cost` opens with. */
	range: RangeKey;
	/** The plain-text scope; interactive `/cost` always starts with the current-project scope. */
	scope: Scope;
}

export const DEFAULT_SCOPE: Scope = "project";

export function defaultSettings(): LedgerSettings {
	return { range: DEFAULT_RANGE, scope: DEFAULT_SCOPE };
}

export function parseSettings(text: string | undefined): LedgerSettings {
	if (!text) return defaultSettings();
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return defaultSettings();
		const { range, scope } = raw as { range?: unknown; scope?: unknown };
		// Settings written before scope existed keep their range and use the
		// project scope for plain-text reports.
		return {
			range: typeof range === "string" && isRangeKey(range) ? range : DEFAULT_RANGE,
			scope: typeof scope === "string" && isScope(scope) ? scope : DEFAULT_SCOPE,
		};
	} catch {
		return defaultSettings();
	}
}

export function serializeSettings(settings: LedgerSettings): string {
	return `${JSON.stringify(settings, null, "\t")}\n`;
}
