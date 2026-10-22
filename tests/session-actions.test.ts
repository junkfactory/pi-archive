import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	type utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveDeps } from "../src/archive.js";
import { SessionBrowser } from "../src/browser.js";
import extension from "../src/index.js";
import {
	makeActions,
	restoredPath,
	type SessionActionDeps,
	selectSession,
} from "../src/session-actions.js";

const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);
const DAY = 86_400_000;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

interface SessionOptions {
	modified?: number;
	parentSession?: string;
}

/** Header-only session file, enough for `SessionManager.listAll`. */
async function addSession(
	dir: string,
	name: string,
	options: SessionOptions = {},
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, name);
	const header = {
		type: "session",
		id: name.replace(/\.jsonl$/, ""),
		timestamp: new Date(options.modified ?? NOW).toISOString(),
		cwd: "/work/project",
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	await writeFile(path, `${JSON.stringify(header)}\n`);
	return path;
}

/** Synthetic `SessionInfo` for `listAll` stubs (no disk access). */
function session(
	path: string,
	options: { parentSessionPath?: string; modified?: number } = {},
): SessionInfo {
	return {
		path,
		id: path.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
		cwd: "/work/project",
		parentSessionPath: options.parentSessionPath,
		created: new Date(NOW - DAY),
		modified: new Date(options.modified ?? NOW),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

/** Records archive moves without touching the disk; assertions stay explicit. */
function recordingDeps() {
	const renames: { from: string; to: string }[] = [];
	const stamps: string[] = [];
	const deps: ArchiveDeps = {
		rename: (async (from: string, to: string) => {
			renames.push({ from, to });
		}) as unknown as typeof import("node:fs/promises").rename,
		utimes: (async (path: string) => {
			stamps.push(path);
		}) as unknown as typeof utimes,
	};
	return { deps, renames, stamps };
}

let tmp: string;
let agentDir: string;
let projectA: string;
let projectB: string;
let currentDir: string;
let activeFile: string | undefined;
const realAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "pi-archive-actions-"));
	agentDir = join(tmp, "agent");
	// Point `getAgentDir()` at the fixture so the wiring tests never read the
	// real sessions tree.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	projectA = join(agentDir, "sessions", "--work-a--");
	projectB = join(agentDir, "sessions", "--work-b--");
	currentDir = join(tmp, "current");
	activeFile = undefined;
	await mkdir(projectA, { recursive: true });
	await mkdir(projectB, { recursive: true });
});

afterEach(async () => {
	if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = realAgentDir;
	await rm(tmp, { recursive: true, force: true });
});

function deps(overrides: Partial<SessionActionDeps> = {}): SessionActionDeps {
	return {
		agentDir,
		cwd: "/work/a",
		sessionDir: currentDir,
		usesDefaultDir: true,
		activeSessionFile: activeFile,
		now: () => NOW,
		listAll: vi.fn(async () => []),
		isLive: vi.fn(async () => false),
		...overrides,
	};
}

describe("makeActions().load", () => {
	it("lists All with no argument at the default root and caches it", async () => {
		const listAll = vi.fn(async () => [session("/x.jsonl")]);
		const actions = makeActions(deps({ listAll }));

		const first = await actions.load("all");
		const second = await actions.load("all");

		expect(first).toBe(second);
		expect(listAll).toHaveBeenCalledTimes(1);
		expect(listAll).toHaveBeenCalledWith(undefined);
	});

	it("passes a custom session dir to listAll", async () => {
		const listAll = vi.fn(async () => []);
		const actions = makeActions(
			deps({ listAll, usesDefaultDir: false, sessionDir: "/custom/sessions" }),
		);

		await actions.load("all");

		expect(listAll).toHaveBeenCalledWith("/custom/sessions");
	});
});

describe("archive", () => {
	it("moves the whole family, each child into its own project's archive dir", async () => {
		const parent = await addSession(projectA, "parent.jsonl");
		const child = await addSession(projectB, "child.jsonl", {
			parentSession: parent,
		});
		const listAll = vi.fn(async () => [
			session(parent),
			session(child, { parentSessionPath: parent }),
		]);
		const actions = makeActions(deps({ listAll }));

		const result = await actions.archive(parent);

		expect(result).toEqual({ ok: true, count: 2 });
		expect(await exists(join(projectA, "archive", "parent.jsonl"))).toBe(true);
		expect(await exists(join(projectB, "archive", "child.jsonl"))).toBe(true);
		expect(await exists(parent)).toBe(false);
		expect(await exists(child)).toBe(false);
	});

	it("computes the family from the cached All scope", async () => {
		const parent = await addSession(projectA, "parent.jsonl");
		const listAll = vi.fn(async () => [session(parent)]);
		const actions = makeActions(deps({ listAll }));

		await actions.load("all");
		await actions.archive(parent);

		expect(listAll).toHaveBeenCalledTimes(1);
	});

	it("refuses the open session without calling a filesystem dep", async () => {
		const parent = await addSession(projectA, "parent.jsonl");
		activeFile = parent;
		const recorder = recordingDeps();
		const isLive = vi.fn(async () => false);
		const actions = makeActions(
			deps({
				archiveDeps: recorder.deps,
				isLive,
				listAll: async () => [session(parent)],
			}),
		);

		const result = await actions.archive(parent);

		expect(result).toEqual({
			ok: false,
			error: "Cannot archive the active session",
		});
		expect(recorder.renames).toEqual([]);
		expect(isLive).not.toHaveBeenCalled();
		expect(await exists(parent)).toBe(true);
	});

	it("refuses a family that contains the open session", async () => {
		const parent = await addSession(projectA, "parent.jsonl");
		const child = await addSession(projectB, "child.jsonl", {
			parentSession: parent,
		});
		activeFile = child;
		const recorder = recordingDeps();
		const actions = makeActions(
			deps({
				archiveDeps: recorder.deps,
				listAll: async () => [
					session(parent),
					session(child, { parentSessionPath: parent }),
				],
			}),
		);

		const result = await actions.archive(parent);

		expect(result).toEqual({
			ok: false,
			error: "Cannot archive: family contains the active session",
		});
		expect(recorder.renames).toEqual([]);
		expect(await exists(parent)).toBe(true);
		expect(await exists(child)).toBe(true);
	});

	it("refuses when any family member is live", async () => {
		const parent = await addSession(projectA, "parent.jsonl");
		const child = await addSession(projectB, "child.jsonl", {
			parentSession: parent,
		});
		const recorder = recordingDeps();
		const actions = makeActions(
			deps({
				archiveDeps: recorder.deps,
				isLive: async (path) => path === child,
				listAll: async () => [
					session(parent),
					session(child, { parentSessionPath: parent }),
				],
			}),
		);

		const result = await actions.archive(parent);

		expect(result).toEqual({
			ok: false,
			error: "Cannot archive: session is in use",
		});
		expect(recorder.renames).toEqual([]);
		expect(await exists(parent)).toBe(true);
	});

	it("treats a failed liveness probe as in use", async () => {
		const parent = await addSession(projectA, "parent.jsonl");
		const recorder = recordingDeps();
		const actions = makeActions(
			deps({
				archiveDeps: recorder.deps,
				isLive: async () => {
					throw new Error("registry unreadable");
				},
				listAll: async () => [session(parent)],
			}),
		);

		const result = await actions.archive(parent);

		expect(result.ok).toBe(false);
		expect(recorder.renames).toEqual([]);
	});
});

describe("unarchive", () => {
	it("restores the archived family and reports the restored path", async () => {
		const archived = await addSession(
			join(projectA, "archive"),
			"parent.jsonl",
		);
		await addSession(join(projectB, "archive"), "child.jsonl", {
			parentSession: join(projectA, "parent.jsonl"),
		});
		const actions = makeActions(deps());

		const result = await actions.unarchive(archived);

		expect(result).toEqual({
			ok: true,
			path: join(projectA, "parent.jsonl"),
		});
		expect(await exists(join(projectA, "parent.jsonl"))).toBe(true);
		expect(await exists(join(projectB, "child.jsonl"))).toBe(true);
		expect(await exists(archived)).toBe(false);
	});

	it("refuses the whole restore when a target exists", async () => {
		const archived = await addSession(
			join(projectA, "archive"),
			"parent.jsonl",
		);
		await addSession(projectA, "parent.jsonl");
		const actions = makeActions(deps());

		const result = await actions.unarchive(archived);

		expect(result).toEqual({
			ok: false,
			error: "Cannot restore: target exists",
		});
		expect(await exists(archived)).toBe(true);
	});
});

describe("remove", () => {
	it("refuses the open session before touching the trash", async () => {
		const spy = vi.fn(async () => ({ ok: true, exitCode: 0 }));
		const path = await addSession(join(projectA, "archive"), "s.jsonl");
		activeFile = path;
		const actions = makeActions(deps({ archiveDeps: { trash: spy } }));

		const result = await actions.remove(path);

		expect(result).toEqual({
			ok: false,
			error: "Cannot delete the active session",
		});
		expect(spy).not.toHaveBeenCalled();
		expect(await exists(path)).toBe(true);
	});

	it("deletes through the injected trash", async () => {
		const path = await addSession(join(projectA, "archive"), "s.jsonl");
		const trashed: string[] = [];
		const actions = makeActions(
			deps({
				archiveDeps: {
					trash: async (target) => {
						trashed.push(target);
						await rm(target, { force: true });
						return { ok: true, exitCode: 0 };
					},
				},
			}),
		);

		const result = await actions.remove(path);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("trash");
		expect(trashed).toEqual([path]);
		expect(await exists(path)).toBe(false);
	});
});

describe("selectSession", () => {
	interface Recorder {
		order: string[];
		switches: string[];
		notices: string[];
	}

	function recorder(): Recorder {
		return { order: [], switches: [], notices: [] };
	}

	it("restores an archived family, then switches — and calls nothing after", async () => {
		const rec = recorder();
		const archived = join(projectA, "archive", "p.jsonl");
		const target = join(projectA, "p.jsonl");

		await selectSession(
			{
				unarchive: async (path) => {
					rec.order.push("unarchive");
					expect(path).toBe(archived);
					return { ok: true, path: target };
				},
				exists: (path) => {
					rec.order.push("exists");
					expect(path).toBe(target);
					return true;
				},
				notify: (message) => rec.notices.push(message),
				switchSession: async (path) => {
					rec.order.push("switch");
					rec.switches.push(path);
				},
			},
			archived,
		);

		expect(rec.switches).toEqual([target]);
		expect(rec.notices).toEqual([]);
		// switchSession is the last dep called: nothing may run afterwards.
		expect(rec.order).toEqual(["unarchive", "exists", "switch"]);
	});

	it("does not switch when the restore fails", async () => {
		const rec = recorder();

		await selectSession(
			{
				unarchive: async () => {
					rec.order.push("unarchive");
					return { ok: false, error: "Cannot restore: target exists" };
				},
				exists: () => {
					rec.order.push("exists");
					return true;
				},
				notify: (message) => {
					rec.order.push("notify");
					rec.notices.push(message);
				},
				switchSession: async (path) => {
					rec.order.push("switch");
					rec.switches.push(path);
				},
			},
			join(projectA, "archive", "p.jsonl"),
		);

		expect(rec.switches).toEqual([]);
		expect(rec.notices).toEqual(["Cannot restore: target exists"]);
		expect(rec.order).toEqual(["unarchive", "notify"]);
	});

	it("does not switch when the file vanished after loading", async () => {
		const rec = recorder();
		const path = join(projectA, "gone.jsonl");

		await selectSession(
			{
				unarchive: async () => {
					rec.order.push("unarchive");
					return { ok: true };
				},
				exists: () => {
					rec.order.push("exists");
					return false;
				},
				notify: (message) => {
					rec.order.push("notify");
					rec.notices.push(message);
				},
				switchSession: async (target) => {
					rec.order.push("switch");
					rec.switches.push(target);
				},
			},
			path,
		);

		expect(rec.switches).toEqual([]);
		expect(rec.notices).toHaveLength(1);
		expect(rec.order).toEqual(["exists", "notify"]);
	});

	it("switches an active path without restoring", async () => {
		const rec = recorder();
		const path = join(projectA, "active.jsonl");

		await selectSession(
			{
				unarchive: async () => {
					rec.order.push("unarchive");
					return { ok: true };
				},
				exists: () => {
					rec.order.push("exists");
					return true;
				},
				notify: (message) => rec.notices.push(message),
				switchSession: async (target) => {
					rec.order.push("switch");
					rec.switches.push(target);
				},
			},
			path,
		);

		expect(rec.switches).toEqual([path]);
		expect(rec.order).toEqual(["exists", "switch"]);
	});

	it("has a bare return as the statement after the switchSession await", async () => {
		const source = await readFile(
			new URL("../src/session-actions.ts", import.meta.url),
			"utf8",
		);
		expect(source).toMatch(/await d\.switchSession\(target\);\n\s*return;/);
	});
});

describe("restoredPath", () => {
	it("lifts a file out of its archive dir and leaves others alone", () => {
		expect(restoredPath("/p/archive/a.jsonl")).toBe("/p/a.jsonl");
		expect(restoredPath("/p/a.jsonl")).toBe("/p/a.jsonl");
	});
});

describe("/pi-archive wiring", () => {
	type BrowserResult = { kind: "select"; path: string } | { kind: "close" };

	interface CtxState {
		afterSwitch: boolean;
		violations: string[];
	}

	function captureCommand() {
		const commands: Array<{
			handler: (args: string, ctx: never) => Promise<void>;
		}> = [];
		extension({
			registerCommand: (
				_name: string,
				options: { handler: (args: string, ctx: never) => Promise<void> },
			) => {
				commands.push(options);
			},
			on: () => () => {},
		} as never);
		const [command] = commands;
		if (!command) throw new Error("pi-archive command not registered");
		return command;
	}

	function browserCtx(options: {
		result: BrowserResult;
		order: string[];
		state: CtxState;
	}) {
		const notify = vi.fn();
		const custom = vi.fn(
			async (
				factory: (...args: never[]) => unknown,
			): Promise<BrowserResult> => {
				options.order.push("custom");
				const component = (
					factory as unknown as (
						tui: { requestRender: () => void },
						theme: Record<string, never>,
						keybindings: Record<string, never>,
						done: (result: BrowserResult) => void,
					) => unknown
				)(
					{ requestRender: vi.fn() },
					{},
					{},
					() => ({ kind: "close" }) as BrowserResult,
				);
				expect(component).toBeInstanceOf(SessionBrowser);
				return options.result;
			},
		);

		const base = {
			hasUI: true,
			cwd: "/work/a",
			ui: { custom, notify },
			sessionManager: {
				getSessionDir: () => currentDir,
				getSessionFile: () => activeFile,
			},
			waitForIdle: async () => {
				options.order.push("idle");
			},
			switchSession: vi.fn(async (_path: string) => {
				options.order.push("switch");
				options.state.afterSwitch = true;
				return { cancelled: false };
			}),
		};

		const proxy = new Proxy(base, {
			get(target, prop, receiver) {
				if (options.state.afterSwitch) {
					options.state.violations.push(String(prop));
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		return { ctx: proxy, base };
	}

	it("waits for idle, preloads current, opens the browser, then switches", async () => {
		const command = captureCommand();
		const file = await addSession(currentDir, "live.jsonl");
		const order: string[] = [];
		const state: CtxState = { afterSwitch: false, violations: [] };
		const { ctx, base } = browserCtx({
			result: { kind: "select", path: file },
			order,
			state,
		});

		await command.handler("", ctx as never);

		expect(order).toEqual(["idle", "custom", "switch"]);
		expect(base.switchSession).toHaveBeenCalledWith(file);
		expect(base.ui.notify).not.toHaveBeenCalled();
		// Nothing may touch the (stale) context after switchSession resolves.
		expect(state.violations).toEqual([]);
	});

	it("closes without switching", async () => {
		const command = captureCommand();
		const order: string[] = [];
		const state: CtxState = { afterSwitch: false, violations: [] };
		const { ctx, base } = browserCtx({
			result: { kind: "close" },
			order,
			state,
		});

		await command.handler("", ctx as never);

		expect(order).toEqual(["idle", "custom"]);
		expect(base.switchSession).not.toHaveBeenCalled();
		expect(state.violations).toEqual([]);
	});

	it("reports a restore failure instead of switching", async () => {
		const command = captureCommand();
		const archived = await addSession(
			join(projectA, "archive"),
			"parent.jsonl",
		);
		await addSession(projectA, "parent.jsonl");
		const order: string[] = [];
		const state: CtxState = { afterSwitch: false, violations: [] };
		const { ctx, base } = browserCtx({
			result: { kind: "select", path: archived },
			order,
			state,
		});

		await command.handler("", ctx as never);

		expect(base.switchSession).not.toHaveBeenCalled();
		expect(base.ui.notify).toHaveBeenCalledWith(
			"Cannot restore: target exists",
			"warning",
		);
		expect(order).toEqual(["idle", "custom"]);
	});
});
