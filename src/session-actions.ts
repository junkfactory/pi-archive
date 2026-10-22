/**
 * Picker actions — the filesystem half of `/pi-archive`.
 *
 * Every effect goes through injected seams (`listAll`, `archiveDeps`, `isLive`,
 * `now`, and — for the terminal selection — `switchSession`), so the whole
 * fatal path is unit-testable without a real sessions tree.
 *
 * `selectSession` is the one fatal path: a bad path kills the process, so a
 * vanished file is refused before the switch, `archive/` paths are restored
 * first, and nothing may touch the (then stale) context after the switch.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	type ArchiveDeps,
	applyMoves,
	deleteSessionFile,
	toArchivePath,
	unarchive as unarchiveFiles,
} from "./archive.js";
import { familyMembers, loadScope, type Scope } from "./sessions.js";

export interface SessionActionDeps {
	agentDir: string;
	cwd: string;
	sessionDir: string;
	usesDefaultDir: boolean;
	activeSessionFile?: string;
	now?: () => number;
	/**
	 * `SessionManager.listAll`. No argument means the default sessions root,
	 * which is the only form that recurses into project directories — passing
	 * `<agentDir>/sessions` explicitly would list its top level only.
	 */
	listAll: (dir?: string) => Promise<SessionInfo[]>;
	archiveDeps?: ArchiveDeps;
	isLive: (path: string) => Promise<boolean>;
}

export interface ArchiveAction {
	ok: boolean;
	count?: number;
	error?: string;
}

export interface UnarchiveAction {
	ok: boolean;
	error?: string;
	/** Restored destination, for a follow-up `switchSession`. */
	path?: string;
}

export interface RemoveAction {
	ok: boolean;
	method?: string;
	error?: string;
	/** Files actually removed: the row's whole subtree, root first. */
	paths?: string[];
}

export interface SessionActions {
	load: (scope: Scope) => Promise<SessionInfo[]>;
	archive: (path: string) => Promise<ArchiveAction>;
	unarchive: (path: string) => Promise<UnarchiveAction>;
	remove: (path: string) => Promise<RemoveAction>;
}

export interface SelectDeps {
	/** The action closure, so the whole family is restored before switching. */
	unarchive: (path: string) => Promise<UnarchiveAction>;
	switchSession: (path: string) => Promise<unknown>;
	notify: (message: string) => void;
	/** Injected for tests; defaults to `fs.existsSync`. */
	exists?: (path: string) => boolean;
}

/** `…/<project>/archive/x.jsonl` → `…/<project>/x.jsonl`. */
export function restoredPath(path: string): string {
	const dir = dirname(path);
	return basename(dir) === "archive"
		? join(dirname(dir), basename(path))
		: path;
}

function samePath(a: string, b: string): boolean {
	return resolve(a) === resolve(b);
}

/**
 * Filesystem closures for the browser. `load` caches per scope so the
 * command's `current` preload is free for the component, and `archive`
 * reuses the cached `All` set for family computation.
 */
export function makeActions(d: SessionActionDeps): SessionActions {
	const cache = new Map<Scope, SessionInfo[]>();
	const now = (): number => (d.now ?? Date.now)();

	async function load(scope: Scope): Promise<SessionInfo[]> {
		const cached = cache.get(scope);
		if (cached) return cached;
		const sessions =
			scope === "all"
				? await d.listAll(d.usesDefaultDir ? undefined : d.sessionDir)
				: await loadScope(scope, {
						cwd: d.cwd,
						sessionDir: d.sessionDir,
						usesDefaultDir: d.usesDefaultDir,
						agentDir: d.agentDir,
					});
		cache.set(scope, sessions);
		return sessions;
	}

	async function archive(path: string): Promise<ArchiveAction> {
		const active = d.activeSessionFile;
		if (active !== undefined && samePath(path, active)) {
			return { ok: false, error: "Cannot archive the active session" };
		}

		// The family comes from `All`, not the cwd-filtered `Current` scope:
		// a cross-project fork child must move with its parent.
		const all = await load("all");
		const family = familyMembers(all, path);
		const members = family.length > 0 ? family.map((s) => s.path) : [path];

		if (active !== undefined && members.some((p) => samePath(p, active))) {
			return {
				ok: false,
				error: "Cannot archive: family contains the active session",
			};
		}
		for (const member of members) {
			let live = true;
			try {
				live = await d.isLive(member);
			} catch {
				live = true; // unknown liveness: never move someone's open file
			}
			if (live)
				return { ok: false, error: "Cannot archive: session is in use" };
		}

		const result = await applyMoves(
			members.map((p) => ({ from: p, to: toArchivePath(p) })),
			now(),
			d.archiveDeps,
		);
		const failure = result.failed[0];
		if (failure) return { ok: false, error: failure.reason };
		return { ok: true, count: result.archived };
	}

	async function unarchive(path: string): Promise<UnarchiveAction> {
		// Archived files are not part of `listAll()` (it scans project dirs
		// only), so the family comes from the merged archived scope.
		const archived = await load("archived");
		const family = familyMembers(archived, path);
		const members = family.length > 0 ? family.map((s) => s.path) : [path];

		const restored = await unarchiveFiles(members, now(), d.archiveDeps);
		if (restored.length === 0) {
			// A vanished source was already restored (idempotent `u`).
			if (!existsSync(path)) return { ok: true, path: restoredPath(path) };
			return { ok: false, error: "Cannot restore: target exists" };
		}
		return { ok: true, path: restoredPath(path) };
	}

	async function remove(path: string): Promise<RemoveAction> {
		const active = d.activeSessionFile;
		if (active !== undefined && samePath(path, active)) {
			return { ok: false, error: "Cannot delete the active session" };
		}

		// Subtree, not ancestry: deleting a row takes its forks with it, but a
		// fork never drags its parent along. A family can straddle `archive/`,
		// so both scopes are merged — `All` misses archived forks and `Archived`
		// misses live ones. A failed scan falls back to the row alone rather than
		// rejecting: `remove` must never throw onto the picker's key handler.
		let merged: SessionInfo[] = [];
		try {
			const [all, archived] = await Promise.all([
				load("all"),
				load("archived"),
			]);
			merged = [...all, ...archived];
		} catch {
			merged = [];
		}
		const family = familyMembers(merged, path);
		const members = family.length > 0 ? family.map((s) => s.path) : [path];

		if (active !== undefined && members.some((p) => samePath(p, active))) {
			return {
				ok: false,
				error: "Cannot delete: family contains the active session",
			};
		}

		const paths: string[] = [];
		let method: string | undefined;
		for (const member of members) {
			const result = await deleteSessionFile(member, d.archiveDeps);
			if (!result.ok) {
				// Trash is not transactional: report what is already gone so the
				// picker can drop those rows instead of claiming all survived.
				return {
					ok: false,
					paths,
					method,
					error:
						paths.length === 0
							? result.error
							: `Deleted ${paths.length} of ${members.length}, then failed: ${result.error}`,
				};
			}
			paths.push(member);
			method = result.method;
		}
		return { ok: true, paths, method };
	}

	return { load, archive, unarchive, remove };
}

/**
 * Terminal picker outcome: restore an archived file first, pre-check that the
 * target exists, then switch. The statement right after the `switchSession`
 * await is a `return` on purpose — the old context is stale after a switch and
 * anything touching it throws (F4). Keep it that way.
 */
export async function selectSession(
	d: SelectDeps,
	path: string,
): Promise<void> {
	const exists = d.exists ?? existsSync;
	let target = path;

	if (restoredPath(path) !== path) {
		const restored = await d.unarchive(path);
		if (!restored.ok) {
			d.notify(restored.error ?? "Cannot restore archived session");
			return;
		}
		target = restored.path ?? restoredPath(path);
	}

	if (!exists(target)) {
		d.notify(`pi-archive: session file no longer exists: ${target}`);
		return;
	}

	await d.switchSession(target);
	return;
}
