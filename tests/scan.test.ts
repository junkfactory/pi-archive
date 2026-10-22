import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildFamilies,
	listArchiveDirs,
	listProjectDirs,
	planArchives,
	readSessionNodes,
	type SessionNode,
} from "../src/scan.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);

interface SessionOptions {
	ageDays?: number;
	parentSession?: string;
	id?: string;
	cwd?: string;
	secondLine?: string;
}

/** Write a session file (header line + one body line) and backdate its mtime. */
async function addSession(
	dir: string,
	name: string,
	options: SessionOptions = {},
): Promise<string> {
	const path = join(dir, name);
	const ageDays = options.ageDays ?? 0;
	const header = {
		type: "session",
		id: options.id ?? name.replace(/\.jsonl$/, ""),
		timestamp: new Date(NOW - ageDays * DAY).toISOString(),
		cwd: options.cwd ?? `/work/${basename(dir)}`,
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	const secondLine =
		options.secondLine ??
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "hi" },
		});
	await mkdir(dir, { recursive: true });
	await writeFile(path, `${JSON.stringify(header)}\n${secondLine}\n`);
	const mtime = new Date(NOW - ageDays * DAY);
	await utimes(path, mtime, mtime);
	return path;
}

/** Synthetic node, for graph tests that do not need files on disk. */
function node(
	dir: string,
	name: string,
	options: { parentSessionPath?: string; mtimeMs?: number } = {},
): SessionNode {
	return {
		path: join(dir, name),
		dir,
		basename: name,
		id: name,
		cwd: "/cwd",
		parentSessionPath: options.parentSessionPath,
		mtimeMs: options.mtimeMs ?? NOW - 10 * DAY,
	};
}

function rootsOf(families: SessionNode[][]): Map<string, SessionNode[]> {
	return new Map(families.map((family) => [family[0].path, family]));
}

async function fixtureNodes(...dirs: string[]): Promise<SessionNode[]> {
	const nodes: SessionNode[] = [];
	for (const dir of dirs) nodes.push(...(await readSessionNodes(dir)));
	return nodes;
}

let tmp: string;
let sessionsRoot: string;
let projectA: string;
let projectB: string;
let projectC: string;
let paths: Record<string, string>;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "pi-archive-scan-"));
	sessionsRoot = join(tmp, "sessions");
	projectA = join(sessionsRoot, "--work-a--");
	projectB = join(sessionsRoot, "--work-b--");
	await mkdir(projectB, { recursive: true });
	// Every session archived: no top-level `*.jsonl`, so `listProjectDirs`
	// skips it while `listArchiveDirs` must still find it.
	projectC = join(sessionsRoot, "--work-c--");
	await addSession(join(projectC, "archive"), "archived-only.jsonl", {
		ageDays: 200,
		id: "archived-only",
	});

	const staleRoot = await addSession(
		projectA,
		"2026-05-10T00-00-00_stale-root.jsonl",
		{ ageDays: 10, id: "stale-root" },
	);
	const staleChild = await addSession(
		projectA,
		"2026-05-10T01-00-00_stale-child.jsonl",
		{ ageDays: 10, id: "stale-child", parentSession: staleRoot },
	);
	const mixedRoot = await addSession(
		projectA,
		"2026-05-10T02-00-00_mixed-root.jsonl",
		{ ageDays: 10, id: "mixed-root" },
	);
	const mixedChild = await addSession(
		projectA,
		"2026-05-18T00-00-00_mixed-child.jsonl",
		{ ageDays: 2, id: "mixed-child", parentSession: mixedRoot },
	);
	const activeRoot = await addSession(
		projectA,
		"2026-05-10T03-00-00_active-root.jsonl",
		{ ageDays: 10, id: "active-root" },
	);
	const activeChild = await addSession(
		projectA,
		"2026-05-10T04-00-00_active-child.jsonl",
		{ ageDays: 10, id: "active-child", parentSession: activeRoot },
	);
	const freshOne = await addSession(
		projectA,
		"2026-05-20T00-00-00_fresh-one.jsonl",
		{ ageDays: 0.5, id: "fresh-one" },
	);
	const freshTwo = await addSession(
		projectA,
		"2026-05-20T01-00-00_fresh-two.jsonl",
		{ ageDays: 0.5, id: "fresh-two" },
	);
	// Child lives in B; the recorded parent path no longer exists, so only the
	// global basename index can connect it to the family in A.
	const crossChild = await addSession(
		projectB,
		"2026-05-10T05-00-00_cross-child.jsonl",
		{
			ageDays: 10,
			id: "cross-child",
			parentSession: join(tmp, "moved", "--work-a--", basename(staleRoot)),
		},
	);
	const nested = await addSession(
		join(sessionsRoot, "pi-minion", "2026-09"),
		"2026-09-01T00-00-00_nested.jsonl",
		{ ageDays: 0.5, id: "nested" },
	);
	const headerless = join(projectA, "headerless.jsonl");
	paths = {
		staleRoot,
		staleChild,
		mixedRoot,
		mixedChild,
		activeRoot,
		activeChild,
		freshOne,
		freshTwo,
		crossChild,
		nested,
		headerless,
	};
	await writeFile(headerless, "this is not a session header\n");
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("listProjectDirs", () => {
	it("lists only depth-1 dirs with top-level sessions", async () => {
		expect(await listProjectDirs(sessionsRoot)).toEqual([projectA, projectB]);
	});

	it("returns [] for a missing sessions root", async () => {
		expect(await listProjectDirs(join(tmp, "nope"))).toEqual([]);
	});
});

describe("listArchiveDirs", () => {
	it("finds a project whose sessions are all archived", async () => {
		expect(await listArchiveDirs(sessionsRoot)).toEqual([projectC]);
	});

	it("returns [] for a missing sessions root", async () => {
		expect(await listArchiveDirs(join(tmp, "nope"))).toEqual([]);
	});
});

describe("readSessionNodes", () => {
	it("reads headers and mtimes, skipping malformed files", async () => {
		const nodes = await readSessionNodes(projectA);
		expect(nodes.map((n) => n.id).sort()).toEqual([
			"active-child",
			"active-root",
			"fresh-one",
			"fresh-two",
			"mixed-child",
			"mixed-root",
			"stale-child",
			"stale-root",
		]);

		const staleRoot = nodes.find((n) => n.id === "stale-root");
		expect(staleRoot?.path).toBe(paths.staleRoot);
		expect(staleRoot?.dir).toBe(projectA);
		expect(staleRoot?.basename).toBe(basename(paths.staleRoot));
		expect(staleRoot?.cwd).toBe(`/work/${basename(projectA)}`);
		expect(staleRoot?.parentSessionPath).toBeUndefined();
		expect(Math.abs((staleRoot?.mtimeMs ?? 0) - (NOW - 10 * DAY))).toBeLessThan(
			1000,
		);

		const staleChild = nodes.find((n) => n.id === "stale-child");
		expect(staleChild?.parentSessionPath).toBe(paths.staleRoot);
		expect(nodes.some((n) => n.basename === "headerless.jsonl")).toBe(false);
	});

	it("does not parse beyond the first line", async () => {
		const dir = join(tmp, "body-noise");
		await addSession(dir, "2026-05-10T00-00-00_noisy.jsonl", {
			ageDays: 10,
			id: "noisy",
			secondLine: "}}} not json at all {{{",
		});
		expect((await readSessionNodes(dir)).map((n) => n.id)).toEqual(["noisy"]);
	});
});

describe("buildFamilies", () => {
	it("groups fork families across project dirs by basename", async () => {
		const families = buildFamilies(await fixtureNodes(projectA, projectB)).map(
			(family) => family.map((n) => n.id),
		);
		expect(families).toHaveLength(5);
		expect(families).toContainEqual([
			"stale-root",
			"stale-child",
			"cross-child",
		]);
		expect(families).toContainEqual(["mixed-root", "mixed-child"]);
		expect(families).toContainEqual(["active-root", "active-child"]);
		expect(families).toContainEqual(["fresh-one"]);
		expect(families).toContainEqual(["fresh-two"]);
	});

	it("resolves a parent by exact canonical path across project dirs", () => {
		const parent = node(join(tmp, "p1"), "2026-01-01_parent.jsonl");
		const child = node(join(tmp, "p2"), "2026-01-02_child.jsonl", {
			parentSessionPath: parent.path,
		});
		const families = buildFamilies([child, parent]).map((family) =>
			family.map((n) => n.id),
		);
		expect(families).toEqual([
			["2026-01-01_parent.jsonl", "2026-01-02_child.jsonl"],
		]);
	});

	it("matches families through a symlinked sessions root", async () => {
		const link = join(tmp, "linked-sessions");
		await symlink(sessionsRoot, link, "dir");
		const nodes = await fixtureNodes(
			join(link, basename(projectA)),
			join(link, basename(projectB)),
		);
		const families = buildFamilies(nodes);
		const stale = families.find((family) => family.length === 3);
		expect(stale?.map((n) => n.id)).toEqual([
			"stale-root",
			"stale-child",
			"cross-child",
		]);
	});

	it("treats absent and unresolvable parents as roots", () => {
		const orphan = node(join(tmp, "p"), "orphan.jsonl");
		const lost = node(join(tmp, "p"), "lost.jsonl", {
			parentSessionPath: join(tmp, "gone", "deleted-parent.jsonl"),
		});
		const families = buildFamilies([orphan, lost]);
		expect(families).toHaveLength(2);
		expect(families.every((family) => family.length === 1)).toBe(true);
	});

	it("terminates on a malformed parent cycle", () => {
		const a = node(join(tmp, "p"), "a.jsonl");
		const b = node(join(tmp, "p"), "b.jsonl", { parentSessionPath: a.path });
		a.parentSessionPath = b.path;
		const families = buildFamilies([a, b]);
		expect(families).toHaveLength(1);
		expect(families[0].map((n) => n.id).sort()).toEqual(["a.jsonl", "b.jsonl"]);
	});
});

describe("planArchives", () => {
	it("plans only fully stale families, each into its own project archive", async () => {
		const families = buildFamilies(await fixtureNodes(projectA, projectB));
		const plan = planArchives(rootsOf(families), {
			now: NOW,
			archiveDays: 7,
			activeSessionFile: paths.activeRoot,
		});

		expect(plan.families).toHaveLength(1);
		const moves = plan.families[0].moves;
		expect(moves).toHaveLength(3);
		const byFrom = new Map(moves.map((move) => [move.from, move.to]));
		expect(byFrom.get(paths.staleRoot)).toBe(
			join(projectA, "archive", basename(paths.staleRoot)),
		);
		expect(byFrom.get(paths.staleChild)).toBe(
			join(projectA, "archive", basename(paths.staleChild)),
		);
		expect(byFrom.get(paths.crossChild)).toBe(
			join(projectB, "archive", basename(paths.crossChild)),
		);

		expect(moves.some((move) => move.from === paths.activeRoot)).toBe(false);
		expect(plan.skipped).toContainEqual(`active: ${paths.activeRoot}`);
		expect(plan.skipped).toContainEqual(`recent: ${paths.mixedRoot}`);
		expect(plan.skipped.some((s) => s.includes("headerless.jsonl"))).toBe(
			false,
		);

		// Planning alone must not touch the tree.
		expect(await readFile(paths.headerless, "utf8")).toBe(
			"this is not a session header\n",
		);
		expect(await readFile(paths.nested, "utf8")).toContain('"nested"');
		await expect(
			readFile(join(projectA, "archive", basename(paths.staleRoot)), "utf8"),
		).rejects.toThrow();
	});

	it("recognizes the active session through a symlinked path", async () => {
		const link = join(tmp, "active-link.jsonl");
		await symlink(paths.activeRoot, link);
		const plan = planArchives(
			rootsOf(buildFamilies(await readSessionNodes(projectA))),
			{ now: NOW, archiveDays: 7, activeSessionFile: link },
		);
		expect(
			plan.families.some((f) =>
				f.moves.some((m) => m.from === paths.activeRoot),
			),
		).toBe(false);
		expect(plan.skipped).toContainEqual(`active: ${paths.activeRoot}`);
	});

	it("archives nothing when archiving is disabled", async () => {
		const plan = planArchives(
			rootsOf(buildFamilies(await fixtureNodes(projectA, projectB))),
			{ now: NOW, archiveDays: 0 },
		);
		expect(plan.families).toEqual([]);
		expect(plan.skipped).toHaveLength(5);
		expect(plan.skipped.every((s) => s.startsWith("disabled: "))).toBe(true);
	});

	it("never plans a family without a root", () => {
		const a = node(join(tmp, "p"), "a.jsonl");
		const b = node(join(tmp, "p"), "b.jsonl", { parentSessionPath: a.path });
		a.parentSessionPath = b.path;
		const plan = planArchives(rootsOf(buildFamilies([a, b])), {
			now: NOW,
			archiveDays: 7,
		});
		expect(plan.families).toEqual([]);
		expect(plan.skipped).toEqual([`no-root: ${a.path}`]);
	});
});
