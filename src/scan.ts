/**
 * Session scanner + family graph.
 *
 * Enumerates project dirs under the sessions root, reads only the first
 * (header) line of each `*.jsonl`, groups sessions into fork families, and
 * plans which families are safe to archive. Message bodies are never read.
 */

import type { Dirent } from "node:fs";
import { createReadStream, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

export interface SessionNode {
	path: string;
	dir: string;
	basename: string;
	id: string;
	cwd: string;
	parentSessionPath?: string;
	mtimeMs: number;
}

export interface ArchivePlan {
	families: { moves: { from: string; to: string }[] }[];
	skipped: string[];
}

const DAY_MS = 86_400_000;

function tryRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * pi's `canonicalizePath` semantics: realpath of the dir plus the basename, so
 * a symlinked sessions root still matches. Falls back to the raw path.
 */
function canonicalize(path: string): string {
	const direct = tryRealpath(path);
	if (direct !== undefined) return direct;
	const dir = tryRealpath(dirname(path));
	return dir === undefined ? path : join(dir, basename(path));
}

function keyOf(node: SessionNode): string {
	return canonicalize(node.path);
}

interface SessionIndex {
	byPath: Map<string, SessionNode>;
	byBasename: Map<string, SessionNode[]>;
}

/** Dedupe nodes by canonical path and index them globally by path and basename. */
function buildIndex(nodes: SessionNode[]): {
	unique: SessionNode[];
	index: SessionIndex;
} {
	const byPath = new Map<string, SessionNode>();
	const unique: SessionNode[] = [];
	for (const node of nodes) {
		const key = keyOf(node);
		if (byPath.has(key)) continue;
		byPath.set(key, node);
		unique.push(node);
	}
	const byBasename = new Map<string, SessionNode[]>();
	for (const node of unique) {
		const siblings = byBasename.get(node.basename) ?? [];
		siblings.push(node);
		byBasename.set(node.basename, siblings);
	}
	return { unique, index: { byPath, byBasename } };
}

/**
 * Exact canonical path first, then basename across every project dir (one
 * global index). Absent or unresolvable parent means this node has no parent.
 */
function resolveParent(
	node: SessionNode,
	index: SessionIndex,
): SessionNode | undefined {
	const ref = node.parentSessionPath;
	if (!ref) return undefined;
	const exact = index.byPath.get(canonicalize(ref));
	if (exact) return exact;
	const candidates = index.byBasename.get(basename(ref));
	if (!candidates || candidates.length === 0) return undefined;
	const selfDir = canonicalize(node.dir);
	const sameDir = candidates.filter((c) => canonicalize(c.dir) === selfDir);
	const pool = sameDir.length > 0 ? sameDir : candidates;
	return [...pool].sort((a, b) => a.path.localeCompare(b.path))[0];
}

interface SessionHeader {
	id: string;
	cwd: string;
	parentSession?: string;
}

function parseHeader(line: string): SessionHeader | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "session" || typeof record.id !== "string") {
		return undefined;
	}
	return {
		id: record.id,
		cwd: typeof record.cwd === "string" ? record.cwd : "",
		parentSession:
			typeof record.parentSession === "string" &&
			record.parentSession.length > 0
				? record.parentSession
				: undefined,
	};
}

/** Read the first line only, then stop: message bodies are never loaded. */
async function readFirstLine(path: string): Promise<string | undefined> {
	const stream = createReadStream(path, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) return line;
		return undefined;
	} catch {
		return undefined;
	} finally {
		rl.close();
		stream.destroy();
	}
}

async function readNode(
	path: string,
	projectDir: string,
): Promise<SessionNode | undefined> {
	let mtimeMs: number;
	try {
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
	const line = await readFirstLine(path);
	if (line === undefined) return undefined;
	const header = parseHeader(line);
	if (!header) return undefined;
	return {
		path,
		dir: projectDir,
		basename: basename(path),
		id: header.id,
		cwd: header.cwd,
		parentSessionPath: header.parentSession,
		mtimeMs,
	};
}

/** Header + stat for every top-level `*.jsonl` in a project dir. */
export async function readSessionNodes(
	projectDir: string,
): Promise<SessionNode[]> {
	let names: string[];
	try {
		const entries = await readdir(projectDir, { withFileTypes: true });
		names = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const nodes: SessionNode[] = [];
	for (const name of names) {
		const node = await readNode(join(projectDir, name), projectDir);
		if (node) nodes.push(node);
	}
	return nodes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Group nodes into fork families. Each family lists its root first; a
 * malformed parent cycle produces one family with no root (never archivable),
 * and terminates via the visited set.
 */
export function buildFamilies(nodes: SessionNode[]): SessionNode[][] {
	const { unique, index } = buildIndex(nodes);
	const keys = new Map<SessionNode, string>();
	for (const node of unique) keys.set(node, keyOf(node));

	const parentOf = new Map<string, SessionNode | undefined>();
	for (const node of unique) {
		const key = keys.get(node);
		if (key === undefined) continue;
		parentOf.set(key, resolveParent(node, index));
	}

	interface Group {
		rootKey?: string;
		members: SessionNode[];
	}
	const groups = new Map<string, Group>();

	for (const node of unique) {
		if (!keys.has(node)) continue;
		const chain: string[] = [];
		const visited = new Set<string>();
		let cycleKey: string | undefined;
		let current: SessionNode | undefined = node;
		while (current) {
			const currentKey = keys.get(current);
			if (currentKey === undefined) break;
			if (visited.has(currentKey)) {
				cycleKey = currentKey;
				break;
			}
			visited.add(currentKey);
			chain.push(currentKey);
			current = parentOf.get(currentKey);
		}
		const acyclicRoot =
			cycleKey === undefined ? chain[chain.length - 1] : undefined;
		const groupKey =
			acyclicRoot === undefined
				? `cycle:${[...visited].sort()[0]}`
				: acyclicRoot;
		const group = groups.get(groupKey) ?? {
			rootKey: acyclicRoot,
			members: [],
		};
		group.members.push(node);
		groups.set(groupKey, group);
	}

	const families: SessionNode[][] = [];
	for (const groupKey of [...groups.keys()].sort()) {
		const group = groups.get(groupKey);
		if (!group) continue;
		const rootKey = group.rootKey;
		const members = [...group.members].sort((a, b) => {
			const rankA = keys.get(a) === rootKey ? 0 : 1;
			const rankB = keys.get(b) === rootKey ? 0 : 1;
			return rankA - rankB || a.path.localeCompare(b.path);
		});
		families.push(members);
	}
	return families;
}

/**
 * `roots` maps a family label (its root path) to that family's members, i.e.
 * `new Map(buildFamilies(nodes).map((f) => [f[0].path, f]))`.
 *
 * A family is archivable only when every member is older than `archiveDays`,
 * the active session file is not a member, and at least one member is a root.
 */
export function planArchives(
	roots: Map<string, SessionNode[]>,
	opts: { now: number; archiveDays: number; activeSessionFile?: string },
): ArchivePlan {
	const plan: ArchivePlan = { families: [], skipped: [] };
	const all = [...roots.values()].flat();
	const { index } = buildIndex(all);
	const memberKeys = new Set(all.map(keyOf));
	const activeKey = opts.activeSessionFile
		? canonicalize(opts.activeSessionFile)
		: undefined;
	const enabled = Number.isFinite(opts.archiveDays) && opts.archiveDays > 0;
	const cutoff = opts.now - opts.archiveDays * DAY_MS;

	const isFamilyRoot = (node: SessionNode): boolean => {
		const parent = resolveParent(node, index);
		return parent === undefined || !memberKeys.has(keyOf(parent));
	};

	for (const [label, family] of roots) {
		if (family.length === 0) continue;
		if (!enabled) {
			plan.skipped.push(`disabled: ${label}`);
			continue;
		}
		if (!family.some(isFamilyRoot)) {
			plan.skipped.push(`no-root: ${label}`);
			continue;
		}
		if (activeKey !== undefined && family.some((n) => keyOf(n) === activeKey)) {
			plan.skipped.push(`active: ${label}`);
			continue;
		}
		if (!family.every((n) => n.mtimeMs < cutoff)) {
			plan.skipped.push(`recent: ${label}`);
			continue;
		}
		plan.families.push({
			moves: family.map((node) => ({
				from: node.path,
				to: join(node.dir, "archive", node.basename),
			})),
		});
	}
	return plan;
}

async function hasTopLevelSession(dir: string): Promise<boolean> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.some(
			(entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
		);
	} catch {
		return false;
	}
}

async function hasArchivedSession(dir: string): Promise<boolean> {
	try {
		const entries = await readdir(join(dir, "archive"), {
			withFileTypes: true,
		});
		return entries.some(
			(entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
		);
	} catch {
		return false;
	}
}

/** Depth-1 dirs of `sessionsRoot` holding sessions on a layout the caller picks. */
async function childDirsHolding(
	sessionsRoot: string,
	hasSessions: (dir: string) => Promise<boolean>,
): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		// A symlink reports false, matching pi's own listing.
		if (!entry.isDirectory()) continue;
		const dir = join(sessionsRoot, entry.name);
		if (await hasSessions(dir)) dirs.push(dir);
	}
	return dirs.sort();
}

/** Depth-1 dirs that hold at least one top-level `*.jsonl` (nested layouts skipped). */
export function listProjectDirs(sessionsRoot: string): Promise<string[]> {
	return childDirsHolding(sessionsRoot, hasTopLevelSession);
}

/**
 * Depth-1 dirs that hold at least one `archive/*.jsonl`.
 *
 * A project whose sessions have all been archived keeps no top-level
 * `*.jsonl`, so `listProjectDirs` drops it - but its `archive/` must still be
 * purged and must still take part in the D7 family graph.
 */
export function listArchiveDirs(sessionsRoot: string): Promise<string[]> {
	return childDirsHolding(sessionsRoot, hasArchivedSession);
}
