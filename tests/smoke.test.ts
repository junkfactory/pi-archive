import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { liveDir } from "../src/liveness.js";
import type { SweepReport } from "../src/sweep.js";

/** The command handler awaits a sweep; the session_start hook fires it detached. */
const { runSweepMock } = vi.hoisted(() => ({
	runSweepMock: vi.fn(),
}));
vi.mock("../src/sweep.js", () => ({ runSweep: runSweepMock }));

const REPORT: SweepReport = {
	archived: 2,
	families: 1,
	purged: 3,
	skipped: [],
	failed: [],
	warnings: [],
	split: [],
};

interface CapturedCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (
		prefix: string,
	) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: never) => Promise<void>;
}

type Handler = (event: never, ctx: never) => Promise<void>;

function makePi() {
	const commands: CapturedCommand[] = [];
	const handlers = new Map<string, Handler>();
	const pi = {
		registerCommand: (name: string, options: Omit<CapturedCommand, "name">) => {
			commands.push({ name, ...options });
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
	};
	return { pi, commands, handlers };
}

interface FakeContext {
	hasUI?: boolean;
	file?: string;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

function fakeCtx(options: FakeContext = {}) {
	const notify =
		options.notify ??
		((_message: string, _type?: "info" | "warning" | "error") => {});
	return {
		hasUI: options.hasUI ?? true,
		cwd: "/work/a",
		ui: { notify },
		sessionManager: { getSessionFile: () => options.file },
	};
}

let agentDir: string;
const realAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-archive-index-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	runSweepMock.mockReset();
	runSweepMock.mockResolvedValue(REPORT);
});

afterEach(async () => {
	if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = realAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

async function registryEntries(): Promise<string[]> {
	try {
		return (await readdir(liveDir(agentDir))).sort();
	} catch {
		return [];
	}
}

describe("pi-archive extension", () => {
	it("registers the pi-archive command with sweep completion", () => {
		const { pi, commands, handlers } = makePi();
		extension(pi as never);

		expect(commands.map((command) => command.name)).toEqual(["pi-archive"]);
		expect([...handlers.keys()]).toEqual(["session_start", "session_shutdown"]);

		const [command] = commands;
		if (!command) throw new Error("pi-archive command not registered");

		expect(command.description).toContain("pi-archive");
		expect(command.getArgumentCompletions?.("sw")).toEqual([
			{ value: "sweep", label: "sweep" },
		]);
		expect(command.getArgumentCompletions?.("x")).toEqual([]);
	});

	it("/pi-archive sweep awaits runSweep and reports counts", async () => {
		const { pi, commands } = makePi();
		extension(pi as never);
		const [command] = commands;
		if (!command) throw new Error("pi-archive command not registered");

		const notify = vi.fn();
		await command.handler(
			" sweep ",
			fakeCtx({ notify, file: "/f.jsonl" }) as never,
		);

		expect(runSweepMock).toHaveBeenCalledTimes(1);
		expect(runSweepMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentDir,
				sessionsRoot: join(agentDir, "sessions"),
				activeSessionFile: "/f.jsonl",
				config: expect.objectContaining({ archiveDays: 7, purgeDays: 90 }),
				onWarn: expect.any(Function),
			}),
		);
		expect(notify).toHaveBeenCalledWith(
			"pi-archive: archived 2 from 1 families, purged 3",
			"info",
		);
	});

	it("/pi-archive sweep turns a thrown error into a warning", async () => {
		const { pi, commands } = makePi();
		extension(pi as never);
		const [command] = commands;
		if (!command) throw new Error("pi-archive command not registered");

		runSweepMock.mockRejectedValueOnce(new Error("boom"));
		const notify = vi.fn();
		await expect(
			command.handler("sweep", fakeCtx({ notify }) as never),
		).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledWith(
			"pi-archive: sweep failed: boom",
			"warning",
		);
	});

	it("session_start registers liveness on every reason", async () => {
		const { pi, handlers } = makePi();
		extension(pi as never);
		const start = handlers.get("session_start");
		if (!start) throw new Error("session_start not registered");

		for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
			await start(
				{ reason } as never,
				fakeCtx({ file: `/${reason}.jsonl` }) as never,
			);
		}

		expect(await registryEntries()).toHaveLength(5);
		const [, ...rest] = await registryEntries();
		expect(rest.length).toBe(4);
		const firstEntry = (await registryEntries())[0];
		if (!firstEntry) throw new Error("no registry entry");
		expect(
			JSON.parse(await readFile(join(liveDir(agentDir), firstEntry), "utf8")),
		).toMatchObject({ pid: process.pid });
	});

	it("auto-sweeps only on startup", async () => {
		const { pi, handlers } = makePi();
		extension(pi as never);
		const start = handlers.get("session_start");
		if (!start) throw new Error("session_start not registered");

		await start(
			{ reason: "resume" } as never,
			fakeCtx({ file: "/a.jsonl" }) as never,
		);
		expect(runSweepMock).not.toHaveBeenCalled();

		await start(
			{ reason: "startup" } as never,
			fakeCtx({ file: "/a.jsonl" }) as never,
		);
		expect(runSweepMock).toHaveBeenCalledTimes(1);
	});

	it("starts no sweep without a UI", async () => {
		const { pi, handlers } = makePi();
		extension(pi as never);
		const start = handlers.get("session_start");
		if (!start) throw new Error("session_start not registered");

		await start(
			{ reason: "startup" } as never,
			fakeCtx({ file: "/a.jsonl", hasUI: false }) as never,
		);
		expect(runSweepMock).not.toHaveBeenCalled();
		// The registry claim still happens: another window must not sweep it.
		expect(await registryEntries()).toHaveLength(1);
	});

	it("hands the captured notify to the detached sweep", async () => {
		const { pi, handlers } = makePi();
		extension(pi as never);
		const start = handlers.get("session_start");
		if (!start) throw new Error("session_start not registered");

		const notify = vi.fn();
		let warned = false;
		runSweepMock.mockImplementationOnce(
			async (opts: { onWarn?: (msg: string) => void }) => {
				opts.onWarn?.("pi-archive: something odd");
				warned = true;
				return REPORT;
			},
		);

		await start(
			{ reason: "startup" } as never,
			fakeCtx({ notify, file: "/a.jsonl" }) as never,
		);
		await vi.waitFor(() => expect(warned).toBe(true));
		expect(notify).toHaveBeenCalledWith("pi-archive: something odd", "warning");
	});

	it("a throwing notify never breaks the detached sweep", async () => {
		const { pi, handlers } = makePi();
		extension(pi as never);
		const start = handlers.get("session_start");
		if (!start) throw new Error("session_start not registered");

		runSweepMock.mockRejectedValueOnce(new Error("stale ctx"));
		const notify = vi.fn(() => {
			throw new Error("stale ctx");
		});

		await expect(
			start(
				{ reason: "startup" } as never,
				fakeCtx({ notify, file: "/a.jsonl" }) as never,
			),
		).resolves.toBeUndefined();
	});

	it("session_shutdown unregisters its own entry", async () => {
		const { pi, handlers } = makePi();
		extension(pi as never);
		const start = handlers.get("session_start");
		const shutdown = handlers.get("session_shutdown");
		if (!start || !shutdown) throw new Error("handlers not registered");

		await start(
			{ reason: "new" } as never,
			fakeCtx({ file: "/a.jsonl" }) as never,
		);
		await start(
			{ reason: "new" } as never,
			fakeCtx({ file: "/b.jsonl" }) as never,
		);
		expect(await registryEntries()).toHaveLength(2);

		await shutdown(
			{ reason: "quit" } as never,
			fakeCtx({ file: "/a.jsonl" }) as never,
		);
		expect(await registryEntries()).toHaveLength(1);

		// Missing entry (already pruned) is not an error.
		await expect(
			shutdown(
				{ reason: "quit" } as never,
				fakeCtx({ file: "/gone.jsonl" }) as never,
			),
		).resolves.toBeUndefined();
	});
});
