/**
 * Archive / purge / unarchive operations.
 *
 * Every filesystem call is injectable through {@link ArchiveDeps} so tests
 * never touch the real trash binary or a real sessions tree. All operations
 * tolerate `ENOENT`/`EEXIST` so a second run on the same tree is a no-op.
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { realpathSync } from "node:fs";
import {
	link,
	mkdir,
	readdir,
	rename,
	stat,
	unlink,
	utimes,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArchivePlan } from "./scan.js";

const DAY_MS = 86_400_000;

export interface ArchiveDeps {
	rename?: typeof rename;
	link?: typeof link;
	unlink?: typeof unlink;
	utimes?: typeof utimes;
	trash?: (path: string) => Promise<{ ok: boolean; exitCode: number | null }>;
}

export interface MoveResult {
	archived: number;
	families: number;
	failed: { path: string; reason: string }[];
}

interface TrashOutcome {
	ok: boolean;
	exitCode: number | null;
}

interface ResolvedDeps {
	rename: typeof rename;
	link: typeof link;
	unlink: typeof unlink;
	utimes: typeof utimes;
	trash: (path: string) => Promise<TrashOutcome>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * `trash <abs path>` exits 0; `trash -- <abs path>` exits 5 even though it
 * trashed the file (F10). The `--` guard is therefore only for flag-looking
 * paths, and exit 0 is not the only success signal.
 */
function runTrash(path: string): Promise<TrashOutcome> {
	return new Promise((resolve, reject) => {
		const args = path.startsWith("-") ? ["--", path] : [path];
		execFile("trash", args, (error) => {
			if (!error) {
				resolve({ ok: true, exitCode: 0 });
				return;
			}
			const code = (error as { code?: number | string }).code;
			if (typeof code === "number") {
				resolve({ ok: false, exitCode: code });
				return;
			}
			reject(error);
		});
	});
}

function resolveDeps(deps: ArchiveDeps = {}): ResolvedDeps {
	return {
		rename: deps.rename ?? rename,
		link: deps.link ?? link,
		unlink: deps.unlink ?? unlink,
		utimes: deps.utimes ?? utimes,
		trash: deps.trash ?? runTrash,
	};
}

/** Best-effort canonical path, matching pi's `canonicalizePath` semantics. */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function mtimeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

/** `<dir>/archive/<basename>` — the sibling archive dir of a session file. */
export function toArchivePath(sessionPath: string): string {
	return join(dirname(sessionPath), "archive", basename(sessionPath));
}

/**
 * Stamp atime/mtime with `Date` objects. Node treats numeric `utimes` args as
 * **seconds**, so `Date.now()` would stamp year 2262 and purge would never
 * fire after the archive.
 */
export async function stampNow(
	deps: ArchiveDeps,
	path: string,
	now: number,
): Promise<void> {
	const utimesFn = deps.utimes ?? utimes;
	await utimesFn(path, new Date(now), new Date(now));
}

/** Stamp a moved file, recording a failed entry instead of throwing. */
async function stampMoved(
	deps: ResolvedDeps,
	path: string,
	now: number,
	failed: MoveResult["failed"],
): Promise<void> {
	try {
		await stampNow({ utimes: deps.utimes }, path, now);
	} catch (err) {
		failed.push({ path, reason: `utimes: ${errorMessage(err)}` });
	}
}

/**
 * Apply a flat list of moves as one unit of work. A missing source is treated
 * as already moved (idempotency); an existing/invalid destination is recorded
 * and skipped without touching the source.
 */
export async function applyMoves(
	moves: { from: string; to: string }[],
	now: number,
	deps: ArchiveDeps = {},
): Promise<MoveResult> {
	const d = resolveDeps(deps);
	const result: MoveResult = { archived: 0, families: 0, failed: [] };
	const moved: { from: string; to: string }[] = [];

	for (const move of moves) {
		if (!(await pathExists(move.from))) continue;
		if (await pathExists(move.to)) {
			result.failed.push({
				path: move.to,
				reason: "EEXIST: target exists",
			});
			continue;
		}
		try {
			await mkdir(dirname(move.to), { recursive: true });
			await d.rename(move.from, move.to);
		} catch (err) {
			if (isEnoent(err)) continue;
			result.failed.push({ path: move.from, reason: errorMessage(err) });
			continue;
		}
		moved.push(move);
	}

	for (const move of moved) {
		await stampMoved(d, move.to, now, result.failed);
	}
	result.archived = moved.length;
	result.families = moved.length > 0 && result.failed.length === 0 ? 1 : 0;
	return result;
}

/**
 * Apply a plan family by family. Every destination is pre-checked (an existing
 * target keeps the whole family in place), then all renames run before the
 * mtime stamp. A failure midway renames the already-moved members back, so a
 * half-moved family never survives.
 */
export async function applyPlans(
	plan: ArchivePlan,
	now: number,
	deps: ArchiveDeps = {},
): Promise<MoveResult> {
	const d = resolveDeps(deps);
	const result: MoveResult = { archived: 0, families: 0, failed: [] };

	for (const family of plan.families) {
		const moves = family.moves;
		if (moves.length === 0) continue;

		// Pre-check every destination. A source that is already gone counts as
		// moved (idempotent rerun); an existing target with a live source keeps
		// the whole family in place.
		let blocked: string | undefined;
		let pending = 0;
		for (const move of moves) {
			if (!(await pathExists(move.from))) continue;
			pending += 1;
			if (await pathExists(move.to)) {
				blocked = move.to;
				break;
			}
		}
		if (blocked !== undefined) {
			result.failed.push({
				path: blocked,
				reason: "EEXIST: target exists, family skipped",
			});
			continue;
		}
		if (pending === 0) continue;

		const moved: { from: string; to: string }[] = [];
		let failure: { path: string; reason: string } | undefined;
		for (const move of moves) {
			try {
				await mkdir(dirname(move.to), { recursive: true });
				await d.rename(move.from, move.to);
				moved.push(move);
			} catch (err) {
				if (isEnoent(err)) continue;
				failure = { path: move.from, reason: errorMessage(err) };
				break;
			}
		}

		if (failure !== undefined) {
			for (const done of moved.reverse()) {
				try {
					await d.rename(done.to, done.from);
				} catch (err) {
					result.failed.push({
						path: done.to,
						reason: `rollback: ${errorMessage(err)}`,
					});
				}
			}
			result.failed.push(failure);
			continue;
		}

		for (const done of moved) {
			await stampMoved(d, done.to, now, result.failed);
		}
		if (moved.length > 0) {
			result.archived += moved.length;
			result.families += 1;
		}
	}

	return result;
}

interface ArchivedLocation {
	path: string;
	archived: boolean;
	mtimeMs: number;
}

/**
 * Purge old archived sessions. `roots` are project session dirs; only
 * `<root>/archive/*.jsonl` is ever a candidate.
 *
 * A family is purged only when every member is in an `archive/` dir and past
 * the cutoff (D7): a basename still present in a project dir, or another
 * archived copy that is recent, marks the family `split`. The active session
 * is never purged. Without a usable trash binary the whole phase is skipped
 * with a warning — unattended purge never falls back to `unlink`.
 */
export async function purgeArchived(
	roots: string[],
	purgeDays: number,
	now: number,
	opts: {
		activeSessionFile?: string;
		deps?: ArchiveDeps;
		isProtectedArchived?: (p: string) => boolean;
	} = {},
): Promise<{
	purged: number;
	skipped: string[];
	failed: { path: string; reason: string }[];
	warnings: string[];
}> {
	const result = {
		purged: 0,
		skipped: [] as string[],
		failed: [] as { path: string; reason: string }[],
		warnings: [] as string[],
	};

	if (!Number.isFinite(purgeDays) || purgeDays <= 0) {
		result.warnings.push("purge disabled: purgeDays is not a positive number");
		return result;
	}

	const d = resolveDeps(opts.deps);
	const cutoff = now - purgeDays * DAY_MS;
	const activeKey = opts.activeSessionFile
		? canonicalize(opts.activeSessionFile)
		: undefined;

	const locations = new Map<string, ArchivedLocation[]>();
	const candidates: ArchivedLocation[] = [];
	const record = (location: ArchivedLocation): void => {
		const list = locations.get(basename(location.path)) ?? [];
		list.push(location);
		locations.set(basename(location.path), list);
	};

	for (const root of roots) {
		for (const entry of await readDirSafe(root)) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const path = join(root, entry.name);
			const mtimeMs = await mtimeOf(path);
			if (mtimeMs === undefined) continue;
			record({ path, archived: false, mtimeMs });
		}
		const archiveDir = join(root, "archive");
		for (const entry of await readDirSafe(archiveDir)) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const path = join(archiveDir, entry.name);
			const mtimeMs = await mtimeOf(path);
			if (mtimeMs === undefined) continue;
			const location: ArchivedLocation = { path, archived: true, mtimeMs };
			record(location);
			candidates.push(location);
		}
	}

	const toDelete: ArchivedLocation[] = [];
	for (const candidate of candidates) {
		if (candidate.mtimeMs >= cutoff) {
			result.skipped.push(`recent: ${candidate.path}`);
			continue;
		}
		if (activeKey !== undefined && canonicalize(candidate.path) === activeKey) {
			result.skipped.push(`active: ${candidate.path}`);
			continue;
		}
		const siblings = locations.get(basename(candidate.path)) ?? [];
		const split = siblings.some(
			(other) =>
				other.path !== candidate.path &&
				(!other.archived || other.mtimeMs >= cutoff),
		);
		if (split || opts.isProtectedArchived?.(candidate.path)) {
			result.skipped.push(`split: ${candidate.path}`);
			continue;
		}
		toDelete.push(candidate);
	}

	for (const candidate of toDelete) {
		let outcome: TrashOutcome;
		try {
			outcome = await d.trash(candidate.path);
		} catch (err) {
			if (isEnoent(err)) {
				result.warnings.push(
					"trash unavailable: purge phase skipped, nothing was deleted",
				);
				return result;
			}
			result.failed.push({
				path: candidate.path,
				reason: errorMessage(err),
			});
			continue;
		}
		// Success is exit 0 *or* the file being gone (F10: `trash --` exits 5).
		if (
			outcome.ok ||
			outcome.exitCode === 0 ||
			!(await pathExists(candidate.path))
		) {
			result.purged += 1;
			continue;
		}
		result.failed.push({
			path: candidate.path,
			reason: `trash exited ${outcome.exitCode}`,
		});
	}

	return result;
}

/**
 * Restore a whole family (D6). Each path must be an archived session
 * (`<project>/archive/<file>`); the project dir is `dirname(dirname(path))`.
 *
 * Restore is `link` + `unlink`, never `rename`: `rename` silently replaces an
 * existing destination and would destroy a same-named session. If any target
 * already exists the whole restore is refused, and a failure midway rolls the
 * already-restored members back. Returns the restored destinations (empty =
 * refused).
 */
export async function unarchive(
	paths: string[],
	now: number,
	deps: ArchiveDeps = {},
): Promise<string[]> {
	const d = resolveDeps(deps);
	const seen = new Set<string>();
	const entries: { from: string; to: string }[] = [];
	for (const from of paths) {
		if (seen.has(from)) continue;
		seen.add(from);
		entries.push({ from, to: join(dirname(dirname(from)), basename(from)) });
	}
	if (entries.length === 0) return [];

	for (const entry of entries) {
		if (await pathExists(entry.to)) return [];
	}

	const restored: { from: string; to: string }[] = [];
	for (const entry of entries) {
		try {
			await mkdir(dirname(entry.to), { recursive: true });
			await d.link(entry.from, entry.to);
			await d.unlink(entry.from);
		} catch (err) {
			if (isEnoent(err) && !(await pathExists(entry.from))) continue;
			for (const done of restored.reverse()) {
				try {
					await d.rename(done.to, done.from);
				} catch {
					// Leave the copy where it is rather than lose it.
				}
			}
			return [];
		}
		restored.push(entry);
	}

	for (const entry of restored) {
		try {
			await stampNow({ utimes: d.utimes }, entry.to, now);
		} catch {
			// A failed stamp never undoes a completed restore.
		}
	}
	return restored.map((entry) => entry.to);
}

/**
 * Interactive delete: trash first, `unlink` only when the trash binary is
 * unavailable (a human asked for this deletion). Success is exit 0 or gone.
 */
export async function deleteSessionFile(
	path: string,
	deps: ArchiveDeps = {},
): Promise<{ ok: boolean; method: "trash" | "delete"; error?: string }> {
	const d = resolveDeps(deps);
	try {
		const outcome = await d.trash(path);
		if (outcome.ok || outcome.exitCode === 0 || !(await pathExists(path))) {
			return { ok: true, method: "trash" };
		}
		return {
			ok: false,
			method: "trash",
			error: `trash exited ${outcome.exitCode}`,
		};
	} catch (err) {
		if (!isEnoent(err)) {
			return { ok: false, method: "trash", error: errorMessage(err) };
		}
	}

	try {
		await d.unlink(path);
		return { ok: true, method: "delete" };
	} catch (err) {
		if (isEnoent(err)) return { ok: true, method: "delete" };
		return { ok: false, method: "delete", error: errorMessage(err) };
	}
}
