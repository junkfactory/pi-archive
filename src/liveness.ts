/**
 * Liveness registry: which session files a live pi process has open.
 *
 * One file per live session (`<agentDir>/pi-archive/live/<hash>.json`) so two
 * processes never read-modify-write the same file: writes are `writeFile` to a
 * temp name followed by `rename`, reads prune entries whose pid is gone.
 *
 * This is what keeps a sweep from moving a file another pi window is still
 * appending to (F15: `appendEntry` keeps writing to the path captured at open
 * time, so a moved file silently splits the session).
 */

import { createHash, randomBytes } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** `<agentDir>/pi-archive/live` */
export function liveDir(agentDir: string): string {
	return join(agentDir, "pi-archive", "live");
}

/** Registry entry payload. */
export interface LiveEntry {
	sessionPath: string;
	pid: number;
}

export interface ReadLiveDeps {
	/** Probes a pid. Injected in tests; defaults to `process.kill(pid, 0)`. */
	kill?: typeof process.kill;
}

function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** `<liveDir>/<sha256(sessionPath).slice(0, 16)>.json` */
function entryPath(agentDir: string, sessionPath: string): string {
	return join(liveDir(agentDir), `${sha256(sessionPath).slice(0, 16)}.json`);
}

/**
 * Claim `sessionPath` for this process. Temp file + `rename`, so a concurrent
 * reader never sees a half-written entry.
 */
export async function registerLive(
	agentDir: string,
	sessionPath: string,
): Promise<void> {
	const dir = liveDir(agentDir);
	await mkdir(dir, { recursive: true });
	const target = entryPath(agentDir, sessionPath);
	const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const entry: LiveEntry = { sessionPath, pid: process.pid };
	await writeFile(tmp, JSON.stringify(entry), "utf8");
	try {
		await rename(tmp, target);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

/** Release `sessionPath`. Missing entry is not an error. */
export async function unregisterLive(
	agentDir: string,
	sessionPath: string,
): Promise<void> {
	try {
		await unlink(entryPath(agentDir, sessionPath));
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

function parseEntry(raw: string): LiveEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.sessionPath !== "string") return undefined;
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) {
		return undefined;
	}
	return { sessionPath: record.sessionPath, pid: record.pid };
}

/**
 * Every session path still claimed by a live pid. Entries whose pid is gone
 * (or whose JSON is unreadable) are pruned: pruning only ever removes claims
 * no process can be using.
 */
export async function readLive(
	agentDir: string,
	deps: ReadLiveDeps = {},
): Promise<Set<string>> {
	const live = new Set<string>();
	const dir = liveDir(agentDir);
	let names: string[];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		names = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name);
	} catch {
		return live;
	}

	const kill = deps.kill ?? process.kill;
	// `process.kill(pid, 0)`: success means alive, `ESRCH` means gone, and
	// `EPERM` means the process exists but belongs to another user — alive,
	// never dead, or a sweep would move a file someone else is writing.
	const isAlive = (pid: number): boolean => {
		try {
			kill(pid, 0);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
		}
	};

	for (const name of names) {
		const path = join(dir, name);
		let entry: LiveEntry | undefined;
		try {
			entry = parseEntry(await readFile(path, "utf8"));
		} catch (err) {
			if (!isEnoent(err)) await unlink(path).catch(() => {});
			continue;
		}
		if (entry === undefined || !isAlive(entry.pid)) {
			await unlink(path).catch(() => {});
			continue;
		}
		live.add(entry.sessionPath);
	}
	return live;
}
