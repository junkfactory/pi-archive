/**
 * Session loaders + picker row formatting.
 *
 * `SessionManager` supplies the three scopes; this module merges the archived
 * roots and rebuilds pi's fork tree locally, because `buildSessionTree` and
 * `flattenSessionTree` are module-private in the built-in selector.
 */

import { type Dirent, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type SessionInfo,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

export type Scope = "current" | "all" | "archived";

/** One rendered line: a session plus its fork-tree position. */
export interface Row {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
}

function tryRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** pi's `canonicalizePath`, plus a dir-realpath fallback for paths not on disk. */
function canonicalize(path: string): string {
	const direct = tryRealpath(path);
	if (direct !== undefined) return direct;
	const dir = tryRealpath(dirname(path));
	return dir === undefined ? path : join(dir, basename(path));
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** `<sessionsRoot>/<project>/archive/` for every project that has one. */
async function projectArchiveDirs(sessionsRoot: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(sessionsRoot, entry.name, "archive");
		if (await isDirectory(dir)) dirs.push(dir);
	}
	return dirs;
}

/**
 * Rows for one picker scope. `archived` merges every project's `archive/`
 * under the default sessions root with `<sessionDir>/archive` for a custom
 * `--session-dir`, deduped by realpath, newest `modified` first.
 */
export async function loadScope(
	scope: Scope,
	q: {
		cwd: string;
		sessionDir: string;
		usesDefaultDir: boolean;
		agentDir: string;
	},
): Promise<SessionInfo[]> {
	if (scope === "current") {
		return SessionManager.list(q.cwd, q.sessionDir);
	}
	if (scope === "all") {
		return q.usesDefaultDir
			? SessionManager.listAll()
			: SessionManager.listAll(q.sessionDir);
	}

	const candidates = await projectArchiveDirs(join(q.agentDir, "sessions"));
	if (!q.usesDefaultDir) candidates.push(join(q.sessionDir, "archive"));

	const seen = new Set<string>();
	const roots: string[] = [];
	for (const candidate of candidates) {
		if (!(await isDirectory(candidate))) continue;
		const key = canonicalize(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		roots.push(candidate);
	}

	const lists = await Promise.all(
		roots.map((root) => SessionManager.listAll(root)),
	);
	return lists
		.flat()
		.sort(
			(a, b) =>
				b.modified.getTime() - a.modified.getTime() ||
				a.path.localeCompare(b.path),
		);
}

interface SessionIndex {
	byPath: Map<string, SessionInfo>;
	byBasename: Map<string, string[]>;
	unique: SessionInfo[];
}

/** Dedupe by canonical path and index globally by path and basename. */
function buildIndex(sessions: SessionInfo[]): SessionIndex {
	const byPath = new Map<string, SessionInfo>();
	const unique: SessionInfo[] = [];
	for (const session of sessions) {
		const key = canonicalize(session.path);
		if (byPath.has(key)) continue;
		byPath.set(key, session);
		unique.push(session);
	}
	const byBasename = new Map<string, string[]>();
	for (const [key, session] of byPath) {
		const name = basename(session.path);
		const siblings = byBasename.get(name) ?? [];
		siblings.push(key);
		byBasename.set(name, siblings);
	}
	return { byPath, byBasename, unique };
}

/** The project dir an archived file belongs to is `archive/`'s parent. */
function projectDir(path: string): string {
	const parent = dirname(canonicalize(path));
	return basename(parent) === "archive" ? dirname(parent) : parent;
}

/**
 * Parent key: exact canonical path, then `<parentDir>/archive/<basename>`,
 * then `<parentDir>/<basename>`, then that basename anywhere in the merged
 * set (so cross-project archived families thread). Self-links are ignored.
 */
function resolveParentKey(
	session: SessionInfo,
	index: SessionIndex,
): string | undefined {
	const ref = session.parentSessionPath;
	if (!ref) return undefined;
	const selfKey = canonicalize(session.path);

	const exact = canonicalize(ref);
	if (exact !== selfKey && index.byPath.has(exact)) return exact;

	const name = basename(ref);
	const parentDir = canonicalize(dirname(ref));
	for (const dir of [join(parentDir, "archive"), parentDir]) {
		const key = canonicalize(join(dir, name));
		if (key !== selfKey && index.byPath.has(key)) return key;
	}

	const candidates = (index.byBasename.get(name) ?? []).filter(
		(key) => key !== selfKey,
	);
	const [only] = candidates;
	if (candidates.length === 0 || only === undefined) return undefined;
	if (candidates.length === 1) return only;
	const selfProject = projectDir(session.path);
	const sameProject = candidates.filter(
		(key) => projectDir(key) === selfProject,
	);
	const pool = sameProject.length > 0 ? sameProject : candidates;
	return [...pool].sort((a, b) => a.localeCompare(b))[0];
}

function parentMap(index: SessionIndex): Map<string, string | undefined> {
	const parents = new Map<string, string | undefined>();
	for (const session of index.unique) {
		parents.set(canonicalize(session.path), resolveParentKey(session, index));
	}
	return parents;
}

/** Drop a parent link that would close a cycle, so every row stays visible. */
function safeParent(
	key: string,
	parents: Map<string, string | undefined>,
): string | undefined {
	const seen = new Set([key]);
	let current = parents.get(key);
	while (current !== undefined) {
		if (seen.has(current)) return undefined;
		seen.add(current);
		current = parents.get(current);
	}
	return parents.get(key);
}

/** Fork tree, siblings sorted by the maximum `modified` in their subtree. */
export function buildRows(sessions: SessionInfo[]): Row[] {
	const index = buildIndex(sessions);
	const parents = parentMap(index);

	interface TreeNode {
		session: SessionInfo;
		children: TreeNode[];
		latestActivity: number;
	}

	const nodes = new Map<string, TreeNode>();
	for (const session of index.unique) {
		nodes.set(canonicalize(session.path), {
			session,
			children: [],
			latestActivity: session.modified.getTime(),
		});
	}

	const roots: TreeNode[] = [];
	for (const key of [...nodes.keys()].sort()) {
		const node = nodes.get(key);
		if (!node) continue;
		const parentKey = safeParent(key, parents);
		const parent = parentKey === undefined ? undefined : nodes.get(parentKey);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	const updateLatest = (node: TreeNode): number => {
		for (const child of node.children) {
			node.latestActivity = Math.max(node.latestActivity, updateLatest(child));
		}
		return node.latestActivity;
	};
	for (const root of roots) updateLatest(root);

	const sortNodes = (list: TreeNode[]): void => {
		list.sort(
			(a, b) =>
				b.latestActivity - a.latestActivity ||
				a.session.path.localeCompare(b.session.path),
		);
		for (const node of list) sortNodes(node.children);
	};
	sortNodes(roots);

	const rows: Row[] = [];
	const walk = (
		node: TreeNode,
		depth: number,
		ancestorContinues: boolean[],
		isLast: boolean,
	): void => {
		rows.push({ session: node.session, depth, isLast, ancestorContinues });
		for (let i = 0; i < node.children.length; i++) {
			const child = node.children[i];
			if (!child) continue;
			const continues = depth > 0 ? !isLast : false;
			walk(
				child,
				depth + 1,
				[...ancestorContinues, continues],
				i === node.children.length - 1,
			);
		}
	};
	for (let i = 0; i < roots.length; i++) {
		const root = roots[i];
		if (root) walk(root, 0, [], i === roots.length - 1);
	}
	return rows;
}

/**
 * The root plus every descendant (grandchildren included) and nothing else.
 * The visited set guards against a malformed parent cycle.
 */
export function familyMembers(
	sessions: SessionInfo[],
	rootPath: string,
): SessionInfo[] {
	const index = buildIndex(sessions);
	const parents = parentMap(index);
	const rootKey = canonicalize(rootPath);
	if (!index.byPath.has(rootKey)) return [];

	const children = new Map<string, string[]>();
	for (const key of [...parents.keys()].sort()) {
		const parentKey = safeParent(key, parents);
		if (parentKey === undefined) continue;
		const siblings = children.get(parentKey) ?? [];
		siblings.push(key);
		children.set(parentKey, siblings);
	}

	const members: SessionInfo[] = [];
	const visited = new Set<string>();
	const walk = (key: string): void => {
		if (visited.has(key)) return;
		visited.add(key);
		const session = index.byPath.get(key);
		if (session) members.push(session);
		for (const child of children.get(key) ?? []) walk(child);
	};
	walk(rootKey);
	return members;
}

/** Copy of the built-in selector's relative-age formatting. */
export function formatAge(d: Date): string {
	const diffMs = Date.now() - d.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

/** `~` substitution, as the built-in picker renders it. */
export function shortenPath(path: string): string {
	if (!path) return path;
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
