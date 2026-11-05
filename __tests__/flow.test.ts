import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension from "../index.ts";

interface Notice {
	message: string;
	type: string | undefined;
}

/** The command as pi would call it, captured from a minimal ExtensionAPI stand-in. */
interface Harness {
	notices: Notice[];
	/** Lines the interactive view rendered, when the harness runs as a TUI. */
	captured: { lines?: string[] };
	run: (args: string) => Promise<void>;
	complete: (prefix: string) => Promise<string[]>;
}

/** The plain style stand-ins the interactive view needs; the TUI only calls fg/bold on them. */
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function harness(
	options: { mode?: "tui" | "rpc" | "print" | "json"; cwd?: string; hasUI?: boolean; sessionDir?: string } = {},
): Harness {
	const notices: Notice[] = [];
	const captured: { lines?: string[] } = {};
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let complete: ((prefix: string) => Promise<string[]>) | undefined;

	const pi = {
		registerCommand: (
			_name: string,
			opts: {
				handler: typeof handler;
				getArgumentCompletions?: (prefix: string) => { value: string }[] | null | Promise<{ value: string }[] | null>;
			},
		) => {
			handler = opts.handler;
			complete = async (prefix) => (await opts.getArgumentCompletions?.(prefix))?.map((item) => item.value) ?? [];
		},
	} as unknown as ExtensionAPI;
	extension(pi);

	const ctx = {
		mode: options.mode,
		hasUI: options.hasUI ?? true,
		cwd: options.cwd,
		sessionManager: options.sessionDir
			? { getCwd: () => options.cwd ?? "/", getSessionDir: () => options.sessionDir as string }
			: undefined,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notices.push({ message, type });
			},
			custom: (
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => { render(width: number): string[] },
			) => {
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 30 } },
					PLAIN_THEME,
					{ matches: () => false },
					() => {},
				);
				captured.lines = component.render(100);
				return Promise.resolve(undefined);
			},
		},
	} as unknown as ExtensionContext;

	return {
		notices,
		captured,
		run: async (args) => {
			assert.ok(handler, "the extension must register a command handler");
			await handler(args, ctx);
		},
		complete: async (prefix) => {
			assert.ok(complete, "the extension must register argument completions");
			return complete(prefix);
		},
	};
}

/** Capture a process stream while a command runs, without touching the real terminal. */
async function capture(stream: NodeJS.WriteStream, run: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const original = stream.write;
	stream.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof stream.write;
	try {
		await run();
	} finally {
		stream.write = original;
	}
	return chunks.join("");
}

/** A usage object shaped like pi's, priced so the report has a recognizable number. */
function sessionLog(cwd: string, cost: number, when: Date): string {
	return `${[
		JSON.stringify({ type: "session", id: "s1", timestamp: when.toISOString(), cwd }),
		JSON.stringify({
			type: "message",
			timestamp: when.toISOString(),
			message: {
				role: "assistant",
				provider: "deepseek",
				model: "deepseek-v4-pro",
				usage: { input: 500_000, output: 100_000, cacheRead: 4_000_000, cacheWrite: 0, cost: { total: cost } },
			},
		}),
	].join("\n")}\n`;
}

describe("the /cost command", () => {
	let agentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-cost-ledger-flow-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	async function writeSession(cost: number, when = new Date()): Promise<string> {
		const directory = join(agentDir, "sessions", "--projects-atlas--");
		await mkdir(directory, { recursive: true });
		const path = join(directory, "session.jsonl");
		await writeFile(path, sessionLog("/projects/atlas", cost, when), "utf8");
		return path;
	}

	it("reports the default range and the fixed range overview", async () => {
		await writeSession(1.2345);
		const { notices, run } = harness();
		await run("");

		const [notice] = notices;
		assert.equal(notice?.type, "info");
		assert.match(notice?.message ?? "", /^Cost — today · all projects$/m);
		assert.match(notice?.message ?? "", /^\$1\.23 · 500k in \/ 100k out · cache 89% · 1 call$/m);
		assert.match(notice?.message ?? "", /^today\s+\$1\.23/m);
		assert.match(notice?.message ?? "", /\/projects\/atlas/);
		assert.match(notice?.message ?? "", /deepseek-v4-pro/);
		assert.match(notice?.message ?? "", /\/cost help$/);
	});

	it("honors an explicit range", async () => {
		await writeSession(1.2345);
		const { notices, run } = harness();
		await run("today");
		assert.match(notices[0]?.message ?? "", /^Cost — today · all projects$/m);
	});

	it("persists a new default range and uses it on the next call", async () => {
		await writeSession(1.2345);
		const { notices, run } = harness();

		await run("default today");
		assert.deepEqual(notices[0], { message: "default range: today · plain-text scope: this project", type: "info" });
		assert.match(await readFile(join(agentDir, "cost-settings.json"), "utf8"), /"today"/);

		await run("");
		assert.match(notices[1]?.message ?? "", /^Cost — today · all projects$/m);
	});

	it("rejects an unknown default range without writing settings", async () => {
		const { notices, run } = harness();
		await run("default 90d");
		assert.equal(notices[0]?.type, "warning");
		await assert.rejects(readFile(join(agentDir, "cost-settings.json"), "utf8"));
	});

	it("warns about a missing default range", async () => {
		const { notices, run } = harness();
		await run("default");
		assert.match(notices[0]?.message ?? "", /\/cost default <today\|7d\|30d\|all>/);
	});

	it("refuses an unknown option", async () => {
		const { notices, run } = harness();
		await run("yesterday");
		assert.equal(notices[0]?.type, "warning");
		assert.match(notices[0]?.message ?? "", /unknown option "yesterday"/);
	});

	it("prints help without touching sessions", async () => {
		const { notices, run } = harness();
		await run("help");
		assert.match(notices[0]?.message ?? "", /^Cost ledger — spend recorded by pi/m);
		assert.match(notices[0]?.message ?? "", /\/cost refresh/);
	});

	it("reports an empty history instead of an empty panel", async () => {
		const { notices, run } = harness();
		await run("");
		assert.match(notices[0]?.message ?? "", /no pi sessions recorded under .*sessions yet/);
	});

	it("opens the interactive view in a TUI instead of a notification", async () => {
		await writeSession(1.2345);
		const { notices, captured, run } = harness({ mode: "tui", cwd: "/projects/atlas" });
		await run("");
		assert.deepEqual(notices, []);
		assert.match(captured.lines?.join("\n") ?? "", /^ {2}total .*500k +100k +4\.0M +88\.9% +1 +\$1\.23$/m);
		assert.match(captured.lines?.join("\n") ?? "", /^providers \(1\)/m);
	});

	it("opens the current project even when the plain-text default scope is all", async () => {
		await writeSession(1.2345);
		const { captured, run } = harness({ mode: "tui", cwd: "/projects/atlas" });
		await run("default today all");
		await run("");
		const text = captured.lines?.join("\n") ?? "";
		assert.match(text, /^ {2}total .*\$1\.23/m);
		assert.match(text, /^Project: \/projects\/atlas ▾/m);
		assert.match(text, /^providers \(1\)/m);
		assert.doesNotMatch(text, /^Project: all projects/m);
	});

	it("keeps the interactive refresh on the current project even when the text scope is all", async () => {
		await writeSession(1.2345);
		const { captured, run } = harness({ mode: "tui", cwd: "/projects/atlas" });
		await run("default today all");
		await run("refresh");
		const text = captured.lines?.join("\n") ?? "";
		assert.match(text, /^Project: \/projects\/atlas ▾/m);
		assert.match(text, /^ {2}total .*\$1\.23$/m);
	});

	it("still prints text in a TUI when asked", async () => {
		await writeSession(1.2345);
		const { notices, captured, run } = harness({ mode: "tui" });
		await run("text today");
		assert.equal(captured.lines, undefined);
		assert.match(notices[0]?.message ?? "", /^Cost — today · all projects$/m);
	});

	it("completes subcommands, then ranges, then scopes", async () => {
		const { complete } = harness();
		assert.deepEqual(await complete(""), ["today", "7d", "30d", "all", "text", "default", "refresh", "help"]);
		assert.deepEqual(await complete("7"), ["7d"]);
		assert.deepEqual(await complete("30d "), ["30d project", "30d all"]);
		assert.deepEqual(await complete("30d a"), ["30d all"]);
		assert.deepEqual(await complete("default "), ["default today", "default 7d", "default 30d", "default all"]);
		assert.deepEqual(await complete("default 7d "), ["default 7d project", "default 7d all"]);
		assert.deepEqual(await complete("text 7d "), ["text 7d project", "text 7d all"]);
	});

	it("prints the plain panel to stderr in print mode", async () => {
		await writeSession(1.2345);
		const { run } = harness({ mode: "print", hasUI: false });
		const output = await capture(process.stderr, () => run("today"));
		assert.match(output, /^Cost — today · all projects$/m);
		assert.match(output, /\$1\.23/);
	});

	it("uses the saved plain-text scope for refresh outside the TUI", async () => {
		await writeSession(1.2345);
		const { run } = harness({ mode: "print", hasUI: false, cwd: "/projects/other" });
		await run("default today all");
		const output = await capture(process.stderr, () => run("refresh"));
		assert.match(output, /^Cost — today · all projects$/m);
		assert.match(output, /\$1\.23/);
	});

	it("sends the plain panel as a notification in RPC mode", async () => {
		await writeSession(1.2345);
		const { notices, run } = harness({ mode: "rpc", hasUI: true, cwd: "/projects/atlas" });
		await run("today");
		assert.equal(notices[0]?.type, "info");
		assert.match(notices[0]?.message ?? "", /^Cost — today · \/projects\/atlas$/m);
		assert.match(notices[0]?.message ?? "", /\$1\.23/);
	});

	it("scans a PI_CODING_AGENT_SESSION_DIR directory when no session manager is provided", async () => {
		const custom = join(agentDir, "env-sessions");
		await mkdir(custom, { recursive: true });
		await writeFile(join(custom, "session.jsonl"), sessionLog("/projects/atlas", 1.2345, new Date()), "utf8");
		process.env.PI_CODING_AGENT_SESSION_DIR = custom;
		const { notices, run } = harness({ cwd: "/projects/atlas" });
		await run("today");
		assert.match(notices[0]?.message ?? "", /\$1\.23/);
	});

	it("writes the plain panel to stderr in JSON mode so stdout stays a JSON stream", async () => {
		await writeSession(1.2345);
		const { run } = harness({ mode: "json", hasUI: false });
		const output = await capture(process.stderr, () => run("today"));
		assert.match(output, /^Cost — today · all projects$/m);
		assert.match(output, /\$1\.23/);
	});

	it("discovers sessions in a configured flat session directory", async () => {
		const custom = join(agentDir, "custom-sessions");
		await mkdir(custom, { recursive: true });
		await writeFile(join(custom, "session.jsonl"), sessionLog("/projects/atlas", 1.2345, new Date()), "utf8");
		const { notices, run } = harness({ cwd: "/projects/atlas", sessionDir: custom });
		await run("today");
		assert.match(notices[0]?.message ?? "", /\$1\.23/);
	});

	it("expands a tilde in PI_CODING_AGENT_DIR", async () => {
		const homeAgent = await mkdtemp(join(homedir(), ".pi-cost-ledger-tilde-"));
		try {
			const directory = join(homeAgent, "sessions", "--projects-atlas--");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "session.jsonl"), sessionLog("/projects/atlas", 1.2345, new Date()), "utf8");
			process.env.PI_CODING_AGENT_DIR = `~/${basename(homeAgent)}`;
			const { notices, run } = harness({ cwd: "/projects/atlas" });
			await run("today");
			assert.match(notices[0]?.message ?? "", /\$1\.23/);
		} finally {
			await rm(homeAgent, { recursive: true, force: true });
		}
	});

	it("rewrites the index when a session file is deleted", async () => {
		const path = await writeSession(1.2345);
		const { run } = harness();
		await run("today");
		assert.match(await readFile(join(agentDir, "cost-ledger.json"), "utf8"), /session\.jsonl"/);
		await unlink(path);
		await run("today");
		assert.doesNotMatch(await readFile(join(agentDir, "cost-ledger.json"), "utf8"), /session\.jsonl"/);
	});

	it("rejects an invalid or extra text/range argument instead of silently falling back", async () => {
		await writeSession(1.2345);
		const { notices, run } = harness();
		await run("7d al");
		assert.equal(notices[0]?.type, "warning");
		assert.match(notices[0]?.message ?? "", /unknown scope "al"/);
		await run("text 70d all");
		assert.equal(notices[1]?.type, "warning");
		assert.match(notices[1]?.message ?? "", /unknown range "70d"/);
		await run("default 7d all extra");
		assert.equal(notices[2]?.type, "warning");
		assert.match(notices[2]?.message ?? "", /too many arguments/);
	});

	it("does not suggest scopes after a complete argument list", async () => {
		const { complete } = harness();
		assert.deepEqual(await complete("default 7d all "), []);
		assert.deepEqual(await complete("text today project "), []);
	});

	it("creates the settings directory when the agent directory does not exist yet", async () => {
		const nested = join(agentDir, "nested", "agent");
		process.env.PI_CODING_AGENT_DIR = nested;
		const { notices, run } = harness();
		await run("default today");
		assert.equal(notices[0]?.type, "info");
		assert.match(await readFile(join(nested, "cost-settings.json"), "utf8"), /"today"/);
	});

	it("rebuilds the index on refresh", async () => {
		await writeSession(1.2345);
		const { notices, run } = harness();
		await run("");
		await run("refresh");
		assert.match(notices[1]?.message ?? "", /^\$1\.23/m);
		assert.match(await readFile(join(agentDir, "cost-ledger.json"), "utf8"), /session\.jsonl"/);
	});
});
