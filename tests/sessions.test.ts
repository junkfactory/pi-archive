import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildRows,
	familyMembers,
	formatAge,
	loadScope,
	type Row,
	shortenPath,
} from "../src/sessions.js";

const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface SessionOptions {
	modified?: number;
	parentSession?: string;
	cwd?: string;
}

/** Header-only session file; `modified` comes from the header timestamp. */
async function addSession(
	dir: string,
	name: string,
	options: SessionOptions = {},
): Promise<string> {
	const path = join(dir, name);
	await mkdir(dir, { recursive: true });
	const header = {
		type: "session",
		id: name.replace(/\.jsonl$/, ""),
		timestamp: new Date(options.modified ?? NOW).toISOString(),
		cwd: options.cwd ?? "/work/project",
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	await writeFile(path, `${JSON.stringify(header)}\n`);
	return path;
}

/** Synthetic SessionInfo, for tree tests that do not need files on disk. */
function session(
	path: string,
	options: { modified?: number; parentSessionPath?: string } = {},
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

function ids(rows: Row[]): string[] {
	return rows.map((row) => row.session.id);
}

let tmp: string;
let agentDir: string;
let sessionsRoot: string;
let projectA: string;
let projectB: string;
let customDir: string;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "pi-archive-sessions-"));
	agentDir = join(tmp, "agent");
	sessionsRoot = join(agentDir, "sessions");
	projectA = join(sessionsRoot, "--work-a--");
	projectB = join(sessionsRoot, "--work-b--");
	customDir = join(tmp, "custom-sessions");
	await mkdir(projectA, { recursive: true });
	await mkdir(projectB, { recursive: true });
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(tmp, { recursive: true, force: true });
});

describe("loadScope('archived')", () => {
	beforeEach(async () => {
		await addSession(join(projectA, "archive"), "a-old.jsonl", {
			modified: NOW - 3 * HOUR,
		});
		await addSession(join(projectA, "archive"), "a-new.jsonl", {
			modified: NOW - HOUR,
		});
		await addSession(join(projectB, "archive"), "b.jsonl", {
			modified: NOW - 2 * HOUR,
		});
		await addSession(join(customDir, "archive"), "c.jsonl", {
			modified: NOW - 30 * MIN,
		});
		// Active sessions never show up in the archived scope.
		await addSession(projectA, "active.jsonl", { modified: NOW });
	});

	it("merges both roots, excludes project-level sessions, newest first", async () => {
		const list = await loadScope("archived", {
			cwd: "/work/a",
			sessionDir: customDir,
			usesDefaultDir: false,
			agentDir,
		});
		expect(list.map((s) => s.id)).toEqual(["c", "a-new", "b", "a-old"]);
	});

	it("skips the custom archive dir when the session dir is default", async () => {
		const list = await loadScope("archived", {
			cwd: "/work/a",
			sessionDir: join(projectA, "archive"),
			usesDefaultDir: true,
			agentDir,
		});
		expect(list.map((s) => s.id)).toEqual(["a-new", "b", "a-old"]);
	});

	it("dedupes overlapping roots by realpath", async () => {
		await rm(join(customDir, "archive"), { recursive: true, force: true });
		await symlink(join(projectA, "archive"), join(customDir, "archive"));
		const list = await loadScope("archived", {
			cwd: "/work/a",
			sessionDir: customDir,
			usesDefaultDir: false,
			agentDir,
		});
		expect(list.map((s) => s.id)).toEqual(["a-new", "b", "a-old"]);
	});

	it("returns [] when no archive root exists", async () => {
		const list = await loadScope("archived", {
			cwd: "/work/a",
			sessionDir: join(tmp, "nothing"),
			usesDefaultDir: false,
			agentDir: join(tmp, "no-agent"),
		});
		expect(list).toEqual([]);
	});
});

describe("loadScope('current' | 'all')", () => {
	beforeEach(async () => {
		await addSession(customDir, "a.jsonl", {
			modified: NOW - HOUR,
			cwd: "/work/a",
		});
		await addSession(customDir, "b.jsonl", {
			modified: NOW - 2 * HOUR,
			cwd: "/work/b",
		});
	});

	it("filters current by cwd", async () => {
		const list = await loadScope("current", {
			cwd: "/work/a",
			sessionDir: customDir,
			usesDefaultDir: false,
			agentDir,
		});
		expect(list.map((s) => s.id)).toEqual(["a"]);
	});

	it("all uses the custom session dir when it is not the default", async () => {
		const list = await loadScope("all", {
			cwd: "/work/a",
			sessionDir: customDir,
			usesDefaultDir: false,
			agentDir,
		});
		expect(list.map((s) => s.id)).toEqual(["a", "b"]);
	});
});

describe("buildRows", () => {
	it("repairs a parent that moved into the project's archive/", () => {
		const rows = buildRows([
			session(join(projectA, "archive", "root.jsonl"), {
				modified: NOW - DAY,
			}),
			session(join(projectA, "archive", "child.jsonl"), {
				modified: NOW,
				parentSessionPath: join(projectA, "root.jsonl"),
			}),
		]);
		expect(rows.map((row) => [row.session.id, row.depth, row.isLast])).toEqual([
			["root", 0, true],
			["child", 1, true],
		]);
		expect(rows[1]?.ancestorContinues).toEqual([false]);
	});

	it("threads a cross-project archived family by basename", () => {
		const rows = buildRows([
			session(join(projectA, "archive", "parent.jsonl"), {
				modified: NOW - DAY,
			}),
			session(join(projectB, "archive", "child.jsonl"), {
				modified: NOW,
				parentSessionPath: join(projectA, "parent.jsonl"),
			}),
		]);
		expect(ids(rows)).toEqual(["parent", "child"]);
		expect(rows[1]?.depth).toBe(1);
	});

	it("renders a child whose parent is missing from both locations as a root", () => {
		const rows = buildRows([
			session(join(projectA, "archive", "orphan.jsonl"), {
				parentSessionPath: join(projectA, "gone.jsonl"),
			}),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.depth).toBe(0);
	});

	it("orders siblings and roots by subtree-max modified", () => {
		const root = join(projectA, "archive", "older-root.jsonl");
		const child = join(projectA, "archive", "older-child.jsonl");
		const grandchild = join(projectA, "archive", "grandchild.jsonl");
		const newer = join(projectA, "archive", "newer-root.jsonl");
		const rows = buildRows([
			session(root, { modified: NOW - 10 * DAY }),
			session(child, {
				modified: NOW - 9 * DAY,
				parentSessionPath: root,
			}),
			session(grandchild, {
				modified: NOW - MIN,
				parentSessionPath: child,
			}),
			session(newer, { modified: NOW - HOUR }),
		]);
		expect(ids(rows)).toEqual([
			"older-root",
			"older-child",
			"grandchild",
			"newer-root",
		]);
		expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 0]);
		expect(rows.map((row) => row.isLast)).toEqual([false, true, true, true]);
		expect(rows[2]?.ancestorContinues).toEqual([false, false]);
	});

	it("sorts siblings by their own subtree max", () => {
		const root = join(projectA, "archive", "root.jsonl");
		const rows = buildRows([
			session(root, { modified: NOW - 10 * DAY }),
			session(join(projectA, "archive", "slow.jsonl"), {
				modified: NOW - 8 * DAY,
				parentSessionPath: root,
			}),
			session(join(projectA, "archive", "fast.jsonl"), {
				modified: NOW - HOUR,
				parentSessionPath: root,
			}),
			session(join(projectA, "archive", "mid.jsonl"), {
				modified: NOW - 2 * DAY,
				parentSessionPath: root,
			}),
			session(join(projectA, "archive", "fast-child.jsonl"), {
				modified: NOW - 3 * HOUR,
				parentSessionPath: join(projectA, "archive", "fast.jsonl"),
			}),
		]);
		expect(ids(rows)).toEqual(["root", "fast", "fast-child", "mid", "slow"]);
		expect(rows.map((row) => row.isLast)).toEqual([
			true,
			false,
			true,
			false,
			true,
		]);
		expect(rows[2]?.ancestorContinues).toEqual([false, true]);
	});

	it("resolves an exact parent path and keeps unrelated rows visible", () => {
		const parent = join(projectA, "archive", "parent.jsonl");
		const rows = buildRows([
			session(parent),
			session(join(projectA, "archive", "exact-child.jsonl"), {
				parentSessionPath: parent,
			}),
			session(join(projectB, "archive", "loner.jsonl")),
		]);
		expect(rows.filter((row) => row.depth === 1)).toHaveLength(1);
		expect(rows).toHaveLength(3);
	});

	it("terminates on a parent cycle without losing rows", () => {
		const a = join(projectA, "archive", "a.jsonl");
		const b = join(projectA, "archive", "b.jsonl");
		const rows = buildRows([
			session(a, { parentSessionPath: b }),
			session(b, { parentSessionPath: a }),
		]);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.depth === 0)).toBe(true);
	});

	it("dedupes the same file reached through a symlink", async () => {
		const real = await addSession(join(projectA, "archive"), "real.jsonl");
		await mkdir(join(projectB, "archive"), { recursive: true });
		await symlink(real, join(projectB, "archive", "alias.jsonl"));
		const rows = buildRows([
			session(real),
			session(join(projectB, "archive", "alias.jsonl")),
		]);
		expect(rows).toHaveLength(1);
	});
});

describe("familyMembers", () => {
	function family(): { root: string; child: string; members: SessionInfo[] } {
		const root = join(projectA, "archive", "root.jsonl");
		const child = join(projectA, "archive", "child.jsonl");
		const grandchild = join(projectA, "archive", "grandchild.jsonl");
		const unrelated = join(projectA, "archive", "unrelated.jsonl");
		return {
			root,
			child,
			members: [
				session(root),
				session(child, { parentSessionPath: root }),
				session(grandchild, { parentSessionPath: child }),
				session(join(projectB, "archive", "other-child.jsonl"), {
					parentSessionPath: unrelated,
				}),
				session(unrelated),
			],
		};
	}

	it("returns the root, its descendants, and nothing else", () => {
		const { root, child, members } = family();
		expect(familyMembers(members, root).map((s) => s.id)).toEqual([
			"root",
			"child",
			"grandchild",
		]);
		expect(familyMembers(members, child).map((s) => s.id)).toEqual([
			"child",
			"grandchild",
		]);
	});

	it("returns [] for an unknown root", () => {
		const { members } = family();
		expect(
			familyMembers(members, join(projectA, "archive", "nope.jsonl")),
		).toEqual([]);
	});

	it("terminates on a cycle", () => {
		const a = join(projectA, "archive", "a.jsonl");
		const b = join(projectA, "archive", "b.jsonl");
		const cycle = [
			session(a, { parentSessionPath: b }),
			session(b, { parentSessionPath: a }),
		];
		expect(familyMembers(cycle, a).map((s) => s.id)).toEqual(["a"]);
	});
});

describe("formatAge", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
	});

	it("matches the built-in selector's buckets", () => {
		expect(formatAge(new Date(NOW))).toBe("now");
		expect(formatAge(new Date(NOW - 5 * MIN))).toBe("5m");
		expect(formatAge(new Date(NOW - 3 * HOUR))).toBe("3h");
		expect(formatAge(new Date(NOW - 2 * DAY))).toBe("2d");
		expect(formatAge(new Date(NOW - 21 * DAY))).toBe("3w");
		expect(formatAge(new Date(NOW - 120 * DAY))).toBe("4mo");
		expect(formatAge(new Date(NOW - 365 * DAY))).toBe("1y");
	});
});

describe("shortenPath", () => {
	it("substitutes the home directory only", () => {
		expect(shortenPath(join(homedir(), "Projects/x"))).toBe("~/Projects/x");
		expect(shortenPath("/tmp/x")).toBe("/tmp/x");
		expect(shortenPath("")).toBe("");
	});
});
