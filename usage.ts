/**
 * The ledger's money-and-tokens vocabulary.
 *
 * Kept apart from parsing and rendering so every layer agrees on what a total
 * is: one `UsageTotal` per bucket, merged upward without ever re-deriving a
 * number. Costs are read from pi's own usage records, which price each call
 * against the model table at call time — the ledger never re-prices history,
 * because a later price change would otherwise silently rewrite past months.
 */

/** Cumulative usage: provider-reported tokens, pi-priced cost, and a call count. */
export interface UsageTotal {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Number of model calls that produced a usage record. */
	calls: number;
}

export function emptyTotal(): UsageTotal {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
}

/** Add `source` into `target` in place; the only way totals ever combine. */
export function mergeTotals(target: UsageTotal, source: UsageTotal): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.calls += source.calls;
}

/** Every token that entered the prompt, the denominator of the cache hit rate. */
export function promptTokens(total: UsageTotal): number {
	return total.input + total.cacheRead + total.cacheWrite;
}

/** Every token the provider counted, on either side of the call. */
export function totalTokens(total: UsageTotal): number {
	return total.input + total.output + total.cacheRead + total.cacheWrite;
}

/** True when a total records anything at all: tokens, money, or both. */
export function hasUsage(total: UsageTotal): boolean {
	return totalTokens(total) > 0 || total.cost > 0;
}

/**
 * Share of prompt tokens served from the prompt cache, 0–1. `undefined` when
 * nothing was ever prompted, which is different from a genuine 0% and is
 * rendered as "no cache data" rather than as a miss.
 */
export function cacheHitRate(total: UsageTotal): number | undefined {
	const prompt = promptTokens(total);
	if (prompt <= 0) return undefined;
	return total.cacheRead / prompt;
}
