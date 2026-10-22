import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveDeps } from "../src/archive.js";
import { resolveConfig } from "../src/config.js";
import extension from "../src/index.js";
import { liveDir, registerLive } from "../src/liveness.js";
import { runSweep } from "../src/sweep.js";

const DAY = 86_400_000;

let agentRoot: string;
let sessionsRoot: string;
let projectDir: string;
let roots: string[];

beforeEach(async () => {
	agentRoot = await mkdtemp(join(tmpdir(), "pi-archive-sweep-"));
	roots = [agentRoot];
	sessionsRoot = join(agentRoot, "sessions");
	projectDir = join(sessionsRoot, "--work-a--");
	await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

interface SessionOptions {
	ageDays?: number;
	parentSession?: string;
	id?: string;
}

/** Write a session file (header + one body line) and backdate its mtime. */
async function addSession(
	dir: string,
	name: string,
	options: SessionOptions = {},
): Promise<string> {
	const path = join(dir, name);
	const ageDays = options.ageDays ?? 10;
	const header = {
		type: "session",
		id: options.id ?? name.replace(/\.jsonl$/, ""),
		timestamp: new Date(Date.now() - ageDays * DAY).toISOString(),
		cwd: "/work/a",
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	await mkdir(dir, { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify(header)}\n${JSON.stringify({ type: "message", role: "user" })}\n`,
		"utf8",
	);
	const when = new Date(Date.now() - ageDays * DAY);
	await utimes(path, when, when);
	return path;
}

function fakeTrash(options: { deleteFile?: boolean } = {}) {
	const trashed: string[] = [];
	const trash = async (
		path: string,
	): Promise<{ ok: boolean; exitCode: number | null }> => {
		trashed.push(path);
		if (options.deleteFile) await rm(path, { force: true });
		return { ok: true, exitCode: 0 };
	};
	return { trash, trashed };
}

function sweepOptions(
	overrides: Partial<Parameters<typeof runSweep>[0]> = {},
): Parameters<typeof runSweep>[0] {
	return {
		agentDir: agentRoot,
		sessionsRoot,
		config: resolveConfig(null),
		deps: { trash: fakeTrash().trash },
		...overrides,
	};
}

/** Poll until `check` is true (the startup sweep is detached by design). */
async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs = 4000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for the detached sweep");
}

/** A pid that has already exited (reaped by spawnSync). */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "0"]);
	if (!child.pid) throw new Error("could not spawn a child process");
	return child.pid;
}

describe("runSweep", () => {
	it("archives a stale family, then reports 0 on a second run", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		const child = await addSession(projectDir, "child.jsonl", {
			ageDays: 10,
			parentSession: root,
		});

		const first = await runSweep(sweepOptions());
		expect(first.archived).toBe(2);
		expect(first.families).toBe(1);
		expect(first.failed).toEqual([]);

		for (const path of [root, child]) {
			expect(await exists(join(projectDir, "archive", basename(path)))).toBe(
				true,
			);
			expect(await exists(path)).toBe(false);
		}

		const second = await runSweep(sweepOptions());
		expect(second.archived).toBe(0);
		expect(second.families).toBe(0);
		expect(second.failed).toEqual([]);
	});

	it("skips a family with a recent child", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		await addSession(projectDir, "child.jsonl", {
			ageDays: 0,
			parentSession: root,
		});

		const report = await runSweep(sweepOptions());
		expect(report.archived).toBe(0);
		expect(report.skipped).toContain(`recent: ${root}`);
		expect(await exists(root)).toBe(true);
	});

	it("skips the family that contains the active session", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		const child = await addSession(projectDir, "child.jsonl", {
			ageDays: 10,
			parentSession: root,
		});

		const report = await runSweep(sweepOptions({ activeSessionFile: child }));
		expect(report.archived).toBe(0);
		expect(report.skipped).toContain(`active: ${root}`);
		expect(await exists(root)).toBe(true);
	});

	it("re-reads the registry per family: a live claim blocks the family", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		const child = await addSession(projectDir, "child.jsonl", {
			ageDays: 10,
			parentSession: root,
		});
		await registerLive(agentRoot, root);

		const report = await runSweep(sweepOptions());
		expect(report.archived).toBe(0);
		expect(report.skipped).toContain(`live: ${root}`);
		expect(await exists(root)).toBe(true);
		expect(await exists(child)).toBe(true);
	});

	it("prunes a dead pid and then archives the family", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		await mkdir(liveDir(agentRoot), { recursive: true });
		// An entry for a pid that no longer exists, under its hash filename.
		const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
		const entryPath = join(liveDir(agentRoot), `${hash}.json`);
		await writeFile(
			entryPath,
			JSON.stringify({ sessionPath: root, pid: deadPid() }),
			"utf8",
		);

		const report = await runSweep(sweepOptions());
		expect(report.archived).toBe(1);
		expect(await exists(join(projectDir, "archive", "root.jsonl"))).toBe(true);
		expect(await exists(entryPath)).toBe(false);
	});

	it("purges an old archived session through the injected trash", async () => {
		await addSession(projectDir, "keep.jsonl", { ageDays: 0 });
		const archived = await addSession(
			join(projectDir, "archive"),
			"old.jsonl",
			{
				ageDays: 200,
			},
		);
		const { trash, trashed } = fakeTrash();

		const report = await runSweep(sweepOptions({ deps: { trash } }));
		expect(report.purged).toBe(1);
		expect(trashed).toEqual([archived]);
		expect(report.split).toEqual([]);
	});

	it("purges the archive of a project whose sessions are all archived", async () => {
		// Regression: with no top-level `*.jsonl` left, the project drops out of
		// `listProjectDirs` and its archive used to be omitted from the purge.
		const archived = await addSession(
			join(projectDir, "archive"),
			"old.jsonl",
			{ ageDays: 200 },
		);
		const { trash, trashed } = fakeTrash();

		const report = await runSweep(sweepOptions({ deps: { trash } }));
		expect(report.purged).toBe(1);
		expect(trashed).toEqual([archived]);
		expect(report.split).toEqual([]);
	});

	it("protects a split family (D7): the child is still active", async () => {
		const archivedRoot = await addSession(
			join(projectDir, "archive"),
			"root.jsonl",
			{ ageDays: 200 },
		);
		await addSession(projectDir, "child.jsonl", {
			ageDays: 0,
			parentSession: join(projectDir, "root.jsonl"),
		});

		const { trash, trashed } = fakeTrash();
		const report = await runSweep(sweepOptions({ deps: { trash } }));
		expect(report.purged).toBe(0);
		expect(report.split).toContain(archivedRoot);
		expect(trashed).toEqual([]);
		expect(await exists(archivedRoot)).toBe(true);
	});

	it("keeps an old archive whose sibling is still in the project dir", async () => {
		const archivedRoot = await addSession(
			join(projectDir, "archive"),
			"root.jsonl",
			{ ageDays: 200 },
		);
		await addSession(projectDir, "root.jsonl", { ageDays: 200 });

		const { trash, trashed } = fakeTrash();
		const report = await runSweep(sweepOptions({ deps: { trash } }));
		expect(report.purged).toBe(0);
		expect(report.split).toContain(archivedRoot);
		expect(trashed).toEqual([]);
	});

	it("warns and purges nothing when purge is disabled", async () => {
		await addSession(projectDir, "keep.jsonl", { ageDays: 0 });
		await addSession(join(projectDir, "archive"), "old.jsonl", {
			ageDays: 200,
		});
		const { trash, trashed } = fakeTrash();

		const report = await runSweep(
			sweepOptions({
				config: resolveConfig({ sessionArchivePurgeDays: 0 }),
				deps: { trash },
			}),
		);
		expect(report.purged).toBe(0);
		expect(report.warnings.some((w) => w.includes("purge disabled"))).toBe(
			true,
		);
		expect(trashed).toEqual([]);
	});

	it("forwards config warnings to onWarn and skips archiving", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		const warnings: string[] = [];

		const report = await runSweep(
			sweepOptions({
				config: resolveConfig({ sessionArchiveDays: "soon" }),
				onWarn: (msg) => warnings.push(msg),
			}),
		);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("sessionArchiveDays");
		expect(report.warnings).toEqual(warnings);
		expect(report.archived).toBe(0);
		expect(report.skipped).toContain(`disabled: ${root}`);
		expect(await exists(root)).toBe(true);
	});

	it("reports a failed move instead of throwing", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		const deps: ArchiveDeps = {
			trash: fakeTrash().trash,
			rename: async () => {
				throw new Error("EACCES: nope");
			},
		};

		const report = await runSweep(sweepOptions({ deps }));
		expect(report.archived).toBe(0);
		expect(report.failed.length).toBe(1);
		expect(report.failed[0]?.reason).toContain("EACCES");
		expect(await exists(root)).toBe(true);
	});

	it("is a no-op on an empty or missing sessions root", async () => {
		const report = await runSweep(
			sweepOptions({ sessionsRoot: join(agentRoot, "nope") }),
		);
		expect(report).toMatchObject({
			archived: 0,
			families: 0,
			purged: 0,
			skipped: [],
			failed: [],
			split: [],
		});
	});
});

interface FakeContext {
	hasUI?: boolean;
	file?: string;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
	sessionManager?: { getSessionFile: () => string | undefined };
}

function fakePi() {
	const commands: {
		handler: (args: string, ctx: never) => Promise<void>;
	}[] = [];
	const handlers = new Map<
		string,
		(event: never, ctx: never) => Promise<void>
	>();
	const pi = {
		registerCommand: (_name: string, options: { handler: never }) => {
			commands.push(options as never);
		},
		on: (event: string, handler: never) => {
			handlers.set(event, handler as never);
			return () => {};
		},
	};
	return { pi, commands, handlers };
}

function fakeCtx(options: FakeContext = {}) {
	const notify =
		options.notify ??
		((_message: string, _type?: "info" | "warning" | "error") => {});
	return {
		hasUI: options.hasUI ?? true,
		cwd: "/work/a",
		ui: { notify },
		sessionManager: options.sessionManager ?? {
			getSessionFile: () => options.file,
		},
	};
}

describe("session_start / session_shutdown / sweep wiring", () => {
	const realAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		// Point getAgentDir() at the fixture: the real registry is never touched.
		process.env.PI_CODING_AGENT_DIR = agentRoot;
	});

	afterEach(() => {
		if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = realAgentDir;
	});

	it("startup hook archives the stale family; a manual sweep then reports 0", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		await addSession(projectDir, "child.jsonl", {
			ageDays: 10,
			parentSession: root,
		});
		const { pi, commands, handlers } = fakePi();
		extension(pi as never);

		const start = handlers.get("session_start");
		const sweepCommand = commands[0];
		if (!start || !sweepCommand) throw new Error("wiring missing");

		await start({ reason: "startup" } as never, fakeCtx() as never);
		await waitFor(() => exists(join(projectDir, "archive", "root.jsonl")));
		expect(await exists(join(projectDir, "archive", "child.jsonl"))).toBe(true);

		const notify = vi.fn();
		await sweepCommand.handler("sweep", fakeCtx({ notify }) as never);
		expect(notify).toHaveBeenCalledWith(
			"pi-archive: archived 0 from 0 families, purged 0",
			"info",
		);
	});

	it("manual sweep skips a session live in another pid and never throws", async () => {
		const root = await addSession(projectDir, "root.jsonl", { ageDays: 10 });
		const own = await addSession(projectDir, "own.jsonl", { ageDays: 0 });
		// This process stands in for a second pi window holding the old session.
		await registerLive(agentRoot, root);

		const { pi, commands } = fakePi();
		extension(pi as never);
		const sweepCommand = commands[0];
		if (!sweepCommand) throw new Error("command missing");

		const notify = vi.fn();
		await sweepCommand.handler(
			"sweep",
			fakeCtx({ file: own, notify }) as never,
		);
		expect(notify).toHaveBeenCalledWith(
			"pi-archive: archived 0 from 0 families, purged 0",
			"info",
		);
		expect(await exists(root)).toBe(true);
	});

	it("manual sweep reports a failure as a warning instead of throwing", async () => {
		const { pi, commands } = fakePi();
		extension(pi as never);
		const sweepCommand = commands[0];
		if (!sweepCommand) throw new Error("command missing");

		const notify = vi.fn();
		const ctx = fakeCtx({
			notify,
			sessionManager: {
				getSessionFile: () => {
					throw new Error("stale ctx");
				},
			},
		});
		await expect(
			sweepCommand.handler("sweep", ctx as never),
		).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("pi-archive: sweep failed"),
			"warning",
		);
	});
});
