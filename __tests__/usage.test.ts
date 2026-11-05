import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cacheHitRate, emptyTotal, mergeTotals, promptTokens, totalTokens, type UsageTotal } from "../usage.ts";

function total(partial: Partial<UsageTotal>): UsageTotal {
	return { ...emptyTotal(), ...partial };
}

describe("mergeTotals", () => {
	it("adds every field in place", () => {
		const target = total({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40, cost: 0.5, calls: 2 });
		mergeTotals(target, total({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25, calls: 1 }));
		assert.deepEqual(target, { input: 101, output: 22, cacheRead: 303, cacheWrite: 44, cost: 0.75, calls: 3 });
	});
});

describe("promptTokens / totalTokens", () => {
	it("counts cache traffic on the prompt side", () => {
		const sample = total({ input: 10, output: 5, cacheRead: 90, cacheWrite: 5 });
		assert.equal(promptTokens(sample), 105);
		assert.equal(totalTokens(sample), 110);
	});
});

describe("cacheHitRate", () => {
	it("is the cached share of every prompt token", () => {
		assert.equal(cacheHitRate(total({ input: 25, cacheRead: 75 })), 0.75);
		assert.equal(cacheHitRate(total({ input: 50, cacheRead: 0 })), 0);
	});

	it("is undefined when nothing was ever prompted", () => {
		// Output-only usage (a cache-warming record with no prompt) has no
		// meaningful hit rate; rendering it as 0% would look like a miss.
		assert.equal(cacheHitRate(total({ output: 100 })), undefined);
		assert.equal(cacheHitRate(emptyTotal()), undefined);
	});
});
