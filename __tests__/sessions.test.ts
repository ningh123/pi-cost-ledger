import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { aggregate, rangeWindow } from "../ledger.ts";
import {
	currentTimeZone,
	dedupeSummaries,
	discover,
	emptyIndex,
	INDEX_VERSION,
	parseIndex,
	scanSessions,
	serializeIndex,
	writeIndex,
} from "../sessions.ts";

const STAMP = new Date(2026, 2, 5, 12).toISOString();
const REPORT_NOW = new Date(2026, 2, 6, 12);

/** A session file with explicit entry ids, so fork-copied usage can be recognized. */
function usageLog(
	cwd: string,
	entries: readonly { id: string; cost: number }[],
	parentSession?: string,
	createdAt = STAMP,
): string {
	const header = {
		type: "session",
		version: 3,
		id: `session-${cwd.replace(/\W/g, "-")}`,
		timestamp: createdAt,
		cwd,
		...(parentSession === undefined ? {} : { parentSession }),
	};
	const messages = entries.map(({ id, cost }) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: STAMP,
		message: {
			role: "assistant",
			provider: "zai",
			model: "glm-5.3",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
		},
	}));
	return `${[header, ...messages].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function sessionText(cwd: string, cost: number): string {
	return `${[
		JSON.stringify({ type: "session", id: "s1", timestamp: STAMP, cwd }),
		JSON.stringify({
			type: "message",
			timestamp: STAMP,
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5.3",
				usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
			},
		}),
	].join("\n")}\n`;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-cost-ledger-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Create `<root>/<project>/<file>.jsonl` and return its path. */
async function sessionFile(root: string, project: string, file: string, cost = 1): Promise<string> {
	const path = join(root, project, `${file}.jsonl`);
	await mkdir(join(root, project), { recursive: true });
	await writeFile(path, sessionText(`/projects/${project}`, cost), "utf8");
	return path;
}

describe("discover", () => {
	it("returns jsonl files at the root and one level below it, sorted", async () => {
		await withRoot(async (root) => {
			await sessionFile(root, "beacon", "b");
			await sessionFile(root, "atlas", "a");
			await writeFile(join(root, "atlas", "notes.txt"), "ignored", "utf8");
			await writeFile(join(root, "loose.jsonl"), "{}", "utf8");
			const nested = join(root, "atlas", "nested");
			await mkdir(nested, { recursive: true });
			await writeFile(join(nested, "deep.jsonl"), "{}", "utf8");

			const paths = await discover(root);
			assert.deepEqual(
				paths.map((path) => path.slice(root.length + 1)),
				["atlas/a.jsonl", "beacon/b.jsonl", "loose.jsonl"],
			);
			assert.equal(paths.includes(join(nested, "deep.jsonl")), false);
		});
	});

	it("returns nothing for a sessions root that does not exist yet", async () => {
		await withRoot(async (root) => {
			assert.deepEqual(await discover(join(root, "missing")), []);
		});
	});
});

describe("scanSessions", () => {
	it("parses every file on the first scan", async () => {
		await withRoot(async (root) => {
			await sessionFile(root, "atlas", "one", 1);
			await sessionFile(root, "beacon", "two", 2);

			const scan = await scanSessions(root, undefined);
			assert.equal(scan.parsed, 2);
			assert.equal(scan.reused, 0);
			assert.equal(Object.keys(scan.index.files).length, 2);
			assert.equal(scan.index.timeZone, currentTimeZone());

			const costs = Object.values(scan.index.files).flatMap((summary) =>
				Object.values(summary.buckets).map((total) => total.cost),
			);
			assert.deepEqual(costs.sort(), [1, 2]);
		});
	});

	it("re-reads only files whose size changed", async () => {
		await withRoot(async (root) => {
			const first = await sessionFile(root, "atlas", "one", 1);
			const second = await sessionFile(root, "beacon", "two", 2);

			const initial = await scanSessions(root, undefined);
			const unchanged = await scanSessions(root, initial.index);
			assert.equal(unchanged.parsed, 0);
			assert.equal(unchanged.reused, 2);

			await writeFile(first, sessionText("/projects/atlas", 5), "utf8");
			const grown = await scanSessions(root, initial.index);
			assert.equal(grown.parsed, 1);
			assert.equal(grown.reused, 1);
			assert.equal(grown.parsed + grown.reused, 2);

			const costs = Object.values(grown.index.files)
				.flatMap((summary) => Object.values(summary.buckets).map((total) => total.cost))
				.sort();
			assert.deepEqual(costs, [2, 5]);
			assert.ok(Object.hasOwn(grown.index.files, second));
		});
	});

	it("re-reads everything when forced", async () => {
		await withRoot(async (root) => {
			await sessionFile(root, "atlas", "one");
			const initial = await scanSessions(root, undefined);
			const forced = await scanSessions(root, initial.index, { force: true });
			assert.equal(forced.parsed, 1);
			assert.equal(forced.reused, 0);
		});
	});

	it("drops files deleted from disk", async () => {
		await withRoot(async (root) => {
			const first = await sessionFile(root, "atlas", "one");
			await sessionFile(root, "beacon", "two");
			const initial = await scanSessions(root, undefined);

			await unlink(first);
			const after = await scanSessions(root, initial.index);
			assert.equal(Object.keys(after.index.files).length, 1);
			assert.equal(Object.hasOwn(after.index.files, first), false);
		});
	});

	it("rebuilds every day key when the local time zone changed", async () => {
		await withRoot(async (root) => {
			await sessionFile(root, "atlas", "one");
			const initial = await scanSessions(root, undefined);
			// A cached index computed in another zone would put usage on the
			// wrong local day, so nothing from it may be reused. Pick a zone that
			// is definitely foreign even when the suite runs in this one.
			const foreignZone = currentTimeZone() === "Pacific/Kiritimati" ? "UTC" : "Pacific/Kiritimati";
			const foreign = { ...initial.index, timeZone: foreignZone };
			const rescanned = await scanSessions(root, foreign);
			assert.equal(rescanned.parsed, 1);
			assert.equal(rescanned.reused, 0);
		});
	});

	it("keeps scanning past an unreadable file", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
		await withRoot(async (root) => {
			const locked = await sessionFile(root, "atlas", "locked");
			await sessionFile(root, "beacon", "two");
			// A session log the ledger cannot read must cost that file, not the
			// whole report.
			await chmod(locked, 0o000);
			const scan = await scanSessions(root, undefined);
			assert.equal(Object.keys(scan.index.files).length, 1);
			assert.equal(scan.unreadable, 1);
		});
	});

	it("keeps a cached summary when a file becomes unreadable", {
		skip: process.platform === "win32" || process.getuid?.() === 0,
	}, async () => {
		await withRoot(async (root) => {
			const locked = await sessionFile(root, "atlas", "locked", 4);
			const healthy = await sessionFile(root, "beacon", "two", 2);
			const initial = await scanSessions(root, undefined);

			await chmod(locked, 0o000);
			const scan = await scanSessions(root, initial.index, { force: true });
			assert.equal(scan.unreadable, 1);
			assert.ok(Object.hasOwn(scan.index.files, locked));
			assert.ok(Object.hasOwn(scan.index.files, healthy));
			const costs = Object.values(scan.index.files)
				.flatMap((summary) => Object.values(summary.buckets).map((total) => total.cost))
				.sort();
			assert.deepEqual(costs, [2, 4]);
		});
	});

	it("keeps cached summaries when the sessions root becomes unreadable", {
		skip: process.platform === "win32" || process.getuid?.() === 0,
	}, async () => {
		await withRoot(async (root) => {
			const sessions = join(root, "sessions");
			await sessionFile(sessions, "atlas", "one", 3);
			const initial = await scanSessions(sessions, undefined);
			await chmod(sessions, 0o000);
			try {
				const scan = await scanSessions(sessions, initial.index);
				assert.equal(Object.keys(scan.index.files).length, 1);
				assert.equal(scan.removed, 0);
				assert.ok(scan.unreadable >= 1);
			} finally {
				await chmod(sessions, 0o755);
			}
		});
	});

	it("drops a previously indexed path that is outside the configured roots", async () => {
		await withRoot(async (root) => {
			await sessionFile(join(root, "old"), "atlas", "one");
			const initial = await scanSessions(join(root, "old"), undefined);
			const moved = await scanSessions(join(root, "new"), initial.index);
			assert.equal(Object.keys(moved.index.files).length, 0);
			assert.equal(moved.removed, 1);
		});
	});
});

describe("index persistence", () => {
	it("round-trips through serialize and parse", async () => {
		await withRoot(async (root) => {
			await sessionFile(root, "atlas", "one");
			const scan = await scanSessions(root, undefined);
			const text = serializeIndex(scan.index);
			const parsed = parseIndex(text);
			assert.deepEqual(parsed, scan.index);
		});
	});

	it("rejects an unreadable or outdated index wholesale", () => {
		assert.equal(parseIndex(undefined), undefined);
		assert.equal(parseIndex(""), undefined);
		assert.equal(parseIndex("{truncated"), undefined);
		assert.equal(parseIndex("null"), undefined);
		assert.equal(parseIndex(JSON.stringify({ version: 99, timeZone: "UTC", files: {} })), undefined);
		assert.equal(parseIndex(JSON.stringify({ version: 3, timeZone: "UTC", files: {} })), undefined);
		assert.equal(parseIndex(JSON.stringify({ version: 2, timeZone: "UTC", files: {} })), undefined);
		assert.equal(parseIndex(JSON.stringify({ version: 1, timeZone: "UTC", files: {} })), undefined);
		assert.equal(parseIndex(JSON.stringify({ version: INDEX_VERSION, files: {} })), undefined);
	});

	it("drops invalid file entries but keeps the rest", () => {
		const parsed = parseIndex(
			JSON.stringify({
				version: INDEX_VERSION,
				timeZone: "UTC",
				files: {
					"/good.jsonl": { mtimeMs: 1, size: 2, cwd: "/projects/atlas", buckets: {} },
					"/bad-shape.jsonl": { mtimeMs: "yesterday", size: 2, buckets: {} },
					"/bad-bucket.jsonl": { mtimeMs: 1, size: 2, buckets: { key: { input: "x" } } },
					"/bad-key.jsonl": {
						mtimeMs: 1,
						size: 2,
						buckets: { "not-a-day|zai|glm": { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 1 } },
					},
					"/empty-id.jsonl": {
						mtimeMs: 1,
						size: 2,
						buckets: {},
						records: [
							{
								id: "",
								bucket: "2026-03-05|zai|glm",
								total: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 1 },
							},
						],
					},
				},
			}),
		);
		assert.deepEqual(Object.keys(parsed?.files ?? {}), ["/good.jsonl"]);
	});

	it("writes an index that reads back identically", async () => {
		await withRoot(async (root) => {
			const path = join(root, "nested", "cost-ledger.json");
			const index = emptyIndex("UTC");
			index.files["/a.jsonl"] = { mtimeMs: 10, size: 20, cwd: "/projects/atlas", buckets: {} };
			await writeIndex(path, index);
			assert.deepEqual(parseIndex(await readFile(path, "utf8")), index);
			assert.ok((await stat(path)).isFile());
		});
	});
});

describe("fork deduplication", () => {
	async function writeLog(path: string, text: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text, "utf8");
	}

	async function reportFor(root: string) {
		const scan = await scanSessions(join(root, "sessions"), undefined);
		return aggregate(dedupeSummaries(scan.index.files), rangeWindow("all", REPORT_NOW), REPORT_NOW);
	}

	it("counts copied fork usage once and keeps the original project attribution", async () => {
		await withRoot(async (root) => {
			const original = join(root, "sessions", "original", "source.jsonl");
			const fork = join(root, "sessions", "fork", "fork.jsonl");
			await writeLog(original, usageLog("/projects/atlas", [{ id: "m1", cost: 1.25 }]));
			await writeLog(
				fork,
				usageLog(
					"/projects/beacon",
					[
						{ id: "m1", cost: 1.25 },
						{ id: "new", cost: 0.5 },
					],
					original,
				),
			);

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 1.75);
			assert.equal(report.totals.input, 200);
			assert.equal(report.totals.calls, 2);
			assert.deepEqual(
				report.byProject.map((row) => [row.project, row.total.cost]),
				[
					["/projects/atlas", 1.25],
					["/projects/beacon", 0.5],
				],
			);
		});
	});

	it("deduplicates multiple forks that share the same source", async () => {
		await withRoot(async (root) => {
			const original = join(root, "sessions", "atlas", "source.jsonl");
			const forkA = join(root, "sessions", "beacon", "fork-a.jsonl");
			const forkB = join(root, "sessions", "ceres", "fork-b.jsonl");
			await writeLog(original, usageLog("/projects/atlas", [{ id: "m1", cost: 1 }]));
			await writeLog(
				forkA,
				usageLog(
					"/projects/beacon",
					[
						{ id: "m1", cost: 1 },
						{ id: "a", cost: 0.5 },
					],
					original,
				),
			);
			await writeLog(
				forkB,
				usageLog(
					"/projects/ceres",
					[
						{ id: "m1", cost: 1 },
						{ id: "b", cost: 0.25 },
					],
					original,
				),
			);

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 1.75);
			assert.deepEqual(
				report.byProject.map((row) => [row.project, row.total.cost]),
				[
					["/projects/atlas", 1],
					["/projects/beacon", 0.5],
					["/projects/ceres", 0.25],
				],
			);
		});
	});

	it("counts byte-identical copies of one session once", async () => {
		await withRoot(async (root) => {
			const first = join(root, "sessions", "atlas", "one.jsonl");
			const duplicate = join(root, "sessions", "copy", "one.jsonl");
			await writeLog(first, usageLog("/projects/atlas", [{ id: "m1", cost: 1 }]));
			await writeLog(duplicate, usageLog("/projects/atlas", [{ id: "m1", cost: 1 }]));

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 1);
			assert.equal(report.totals.calls, 1);
			assert.deepEqual(
				report.byProject.map((row) => row.project),
				["/projects/atlas"],
			);
		});
	});

	it("keeps a fork's copied history when the original file is gone", async () => {
		await withRoot(async (root) => {
			const fork = join(root, "sessions", "beacon", "fork.jsonl");
			await writeLog(fork, usageLog("/projects/beacon", [{ id: "m1", cost: 1.25 }], join(root, "missing.jsonl")));

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 1.25);
			assert.deepEqual(
				report.byProject.map((row) => row.project),
				["/projects/beacon"],
			);
		});
	});

	it("deduplicates sibling forks even when the original file is gone", async () => {
		await withRoot(async (root) => {
			const missing = join(root, "sessions", "missing.jsonl");
			const forkA = join(root, "sessions", "beacon", "fork-a.jsonl");
			const forkB = join(root, "sessions", "ceres", "fork-b.jsonl");
			await writeLog(
				forkA,
				usageLog(
					"/projects/beacon",
					[
						{ id: "m1", cost: 1 },
						{ id: "a", cost: 0.5 },
					],
					missing,
				),
			);
			await writeLog(
				forkB,
				usageLog(
					"/projects/ceres",
					[
						{ id: "m1", cost: 1 },
						{ id: "b", cost: 0.25 },
					],
					missing,
				),
			);

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 1.75);
			assert.equal(report.totals.calls, 3);
		});
	});

	it("keeps unrelated sessions that share a short entry id", async () => {
		await withRoot(async (root) => {
			const original = join(root, "sessions", "atlas", "one.jsonl");
			const independent = join(root, "sessions", "beacon", "two.jsonl");
			await writeLog(original, usageLog("/projects/atlas", [{ id: "deadbeef", cost: 1 }]));
			await writeLog(independent, usageLog("/projects/beacon", [{ id: "deadbeef", cost: 9 }]));

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 10);
			assert.equal(report.totals.calls, 2);
			assert.deepEqual(
				report.byProject.map((row) => [row.project, row.total.cost]),
				[
					["/projects/beacon", 9],
					["/projects/atlas", 1],
				],
			);
		});
	});

	it("keeps unrelated sessions even when an id and every total collide", async () => {
		await withRoot(async (root) => {
			const original = join(root, "sessions", "atlas", "one.jsonl");
			const independent = join(root, "sessions", "beacon", "two.jsonl");
			await writeLog(original, usageLog("/projects/atlas", [{ id: "deadbeef", cost: 1 }]));
			await writeLog(independent, usageLog("/projects/beacon", [{ id: "deadbeef", cost: 1 }]));

			const report = await reportFor(root);
			assert.equal(report.totals.cost, 2);
			assert.equal(report.totals.calls, 2);
			assert.equal(report.byProject.length, 2);
		});
	});
});
