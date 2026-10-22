import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	liveDir,
	readLive,
	registerLive,
	unregisterLive,
} from "../src/liveness.js";

let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-archive-live-"));
});

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

function entryName(sessionPath: string): string {
	const hash = createHash("sha256").update(sessionPath).digest("hex");
	return `${hash.slice(0, 16)}.json`;
}

async function entryNames(): Promise<string[]> {
	try {
		return (await readdir(liveDir(agentDir))).sort();
	} catch {
		return [];
	}
}

function fakeKill(code: string | null): typeof process.kill {
	const kill = (): never => {
		const err = new Error(code ?? "boom") as NodeJS.ErrnoException;
		err.code = code ?? undefined;
		throw err;
	};
	return kill as unknown as typeof process.kill;
}

describe("liveDir", () => {
	it("is <agentDir>/pi-archive/live", () => {
		expect(liveDir("/tmp/agent")).toBe("/tmp/agent/pi-archive/live");
	});
});

describe("registerLive / unregisterLive", () => {
	it("writes sha256(sessionPath)[0:16].json with {sessionPath, pid}", async () => {
		const sessionPath = join(agentDir, "sessions", "--p--", "a.jsonl");
		await registerLive(agentDir, sessionPath);

		expect(await entryNames()).toEqual([entryName(sessionPath)]);
		const raw = await readFile(
			join(liveDir(agentDir), entryName(sessionPath)),
			"utf8",
		);
		expect(JSON.parse(raw)).toEqual({ sessionPath, pid: process.pid });
	});

	it("leaves no temp files behind", async () => {
		await registerLive(agentDir, "/a.jsonl");
		const names = await entryNames();
		expect(names.filter((name) => !name.endsWith(".json"))).toEqual([]);
	});

	it("is idempotent and keeps one file per session", async () => {
		await registerLive(agentDir, "/a.jsonl");
		await registerLive(agentDir, "/a.jsonl");
		await registerLive(agentDir, "/b.jsonl");
		expect(await entryNames()).toEqual(
			[entryName("/a.jsonl"), entryName("/b.jsonl")].sort(),
		);
	});

	it("unregisters only its own entry, and tolerates a missing one", async () => {
		await registerLive(agentDir, "/a.jsonl");
		await registerLive(agentDir, "/b.jsonl");

		await unregisterLive(agentDir, "/a.jsonl");
		expect(await entryNames()).toEqual([entryName("/b.jsonl")]);

		await expect(unregisterLive(agentDir, "/a.jsonl")).resolves.toBeUndefined();
		await expect(
			unregisterLive(agentDir, "/never-registered.jsonl"),
		).resolves.toBeUndefined();
	});

	it("treats a missing registry dir as empty when unregistering", async () => {
		await expect(unregisterLive(agentDir, "/a.jsonl")).resolves.toBeUndefined();
	});
});

describe("readLive", () => {
	it("returns an empty set when the registry dir does not exist", async () => {
		expect(await readLive(agentDir)).toEqual(new Set());
	});

	it("returns registered paths whose pid is alive (default probe)", async () => {
		await registerLive(agentDir, "/a.jsonl");
		await registerLive(agentDir, "/b.jsonl");
		expect(await readLive(agentDir)).toEqual(new Set(["/a.jsonl", "/b.jsonl"]));
	});

	it("prunes an entry whose pid fails process.kill(pid, 0)", async () => {
		await registerLive(agentDir, "/dead.jsonl");

		const live = await readLive(agentDir, { kill: fakeKill("ESRCH") });
		expect(live).toEqual(new Set());
		expect(await entryNames()).toEqual([]);
	});

	it("treats EPERM as alive and never prunes it", async () => {
		await registerLive(agentDir, "/other-user.jsonl");

		const live = await readLive(agentDir, { kill: fakeKill("EPERM") });
		expect(live).toEqual(new Set(["/other-user.jsonl"]));
		expect(await entryNames()).toEqual([entryName("/other-user.jsonl")]);
	});

	it("prunes only the dead pids, keeping the live ones", async () => {
		await registerLive(agentDir, "/dead.jsonl");
		await registerLive(agentDir, "/alive.jsonl");

		// The hash decides the entry, so make the probe decide by pid payload.
		const deadRaw = await readFile(
			join(liveDir(agentDir), entryName("/dead.jsonl")),
			"utf8",
		);
		const deadPath = JSON.parse(deadRaw).sessionPath as string;
		const probe = ((pid: number) => {
			if (pid === process.pid) return true;
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		}) as unknown as typeof process.kill;

		await writeFile(
			join(liveDir(agentDir), entryName("/dead.jsonl")),
			JSON.stringify({ sessionPath: deadPath, pid: 424_242 }),
			"utf8",
		);

		const live = await readLive(agentDir, { kill: probe });
		expect(live).toEqual(new Set(["/alive.jsonl"]));
		expect(await entryNames()).toEqual([entryName("/alive.jsonl")]);
	});

	it("prunes unreadable or malformed entries", async () => {
		await mkdir(liveDir(agentDir), { recursive: true });
		await writeFile(join(liveDir(agentDir), "broken.json"), "{", "utf8");
		await writeFile(
			join(liveDir(agentDir), "shape.json"),
			JSON.stringify({ sessionPath: 7, pid: "x" }),
			"utf8",
		);

		expect(await readLive(agentDir)).toEqual(new Set());
		expect(await entryNames()).toEqual([]);
	});

	it("ignores non-json files (temp files, junk)", async () => {
		await mkdir(liveDir(agentDir), { recursive: true });
		await writeFile(join(liveDir(agentDir), "a.json.tmp"), "{}", "utf8");
		await writeFile(join(liveDir(agentDir), "notes.txt"), "hi", "utf8");

		expect(await readLive(agentDir)).toEqual(new Set());
		expect(await entryNames()).toEqual(["a.json.tmp", "notes.txt"]);
	});
});
