import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ArchiveDeps,
	applyMoves,
	applyPlans,
	deleteSessionFile,
	purgeArchived,
	stampNow,
	toArchivePath,
	unarchive,
} from "../src/archive.js";
import type { ArchivePlan } from "../src/scan.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Write a session file and backdate its mtime. */
async function addFile(
	dir: string,
	name: string,
	mtimeMs = NOW,
	body = "{}\n",
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, name);
	await writeFile(path, body);
	const when = new Date(mtimeMs);
	await utimes(path, when, when);
	return path;
}

function planOf(families: string[][]): ArchivePlan {
	return {
		families: families.map((family) => ({
			moves: family.map((from) => ({ from, to: toArchivePath(from) })),
		})),
		skipped: [],
	};
}

/** Fake trash that records calls and, like `trash`, succeeds by exit 0. */
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

function enoentError(): NodeJS.ErrnoException {
	return Object.assign(new Error("spawn trash ENOENT"), { code: "ENOENT" });
}

describe("toArchivePath", () => {
	it("puts the session in the archive dir beside its project dir", () => {
		expect(toArchivePath("/sessions/--work-a--/x.jsonl")).toBe(
			"/sessions/--work-a--/archive/x.jsonl",
		);
	});
});

describe("stampNow", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-archive-ops-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("passes Date objects to utimes (numeric args would be seconds)", async () => {
		const path = await addFile(join(root, "p"), "a.jsonl", NOW - 10 * DAY);
		const calls: { atime: unknown; mtime: unknown }[] = [];
		await stampNow(
			{
				utimes: async (target, atime, mtime) => {
					calls.push({ atime, mtime });
					await utimes(target, atime, mtime);
				},
			},
			path,
			NOW,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.atime).toBeInstanceOf(Date);
		expect(calls[0]?.mtime).toBeInstanceOf(Date);
		expect((calls[0]?.mtime as Date | undefined)?.getTime()).toBe(NOW);
		const st = await stat(path);
		expect(Math.abs(st.mtimeMs - NOW)).toBeLessThan(2000);
	});
});

describe("applyPlans", () => {
	let root: string;
	let project: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-archive-ops-"));
		project = join(root, "--work-a--");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("archives a two-file family with fresh mtimes and preserved basenames", async () => {
		const parent = await addFile(project, "parent.jsonl", NOW - 10 * DAY);
		const child = await addFile(project, "child.jsonl", NOW - 10 * DAY);
		const stamped: Date[] = [];
		const deps: ArchiveDeps = {
			utimes: async (target, atime, mtime) => {
				stamped.push(atime as Date, mtime as Date);
				await utimes(target, atime, mtime);
			},
		};

		const result = await applyPlans(planOf([[parent, child]]), NOW, deps);

		expect(result).toEqual({ archived: 2, families: 1, failed: [] });
		const archivedParent = toArchivePath(parent);
		const archivedChild = toArchivePath(child);
		expect(basename(archivedParent)).toBe("parent.jsonl");
		expect(basename(archivedChild)).toBe("child.jsonl");
		expect(await exists(archivedParent)).toBe(true);
		expect(await exists(archivedChild)).toBe(true);
		expect(await exists(parent)).toBe(false);
		expect(await exists(child)).toBe(false);
		expect(stamped.every((d) => d instanceof Date)).toBe(true);
		const st = await stat(archivedParent);
		expect(Math.abs(st.mtimeMs - NOW)).toBeLessThan(2000);
	});

	it("archives again as a no-op", async () => {
		const parent = await addFile(project, "parent.jsonl", NOW - 10 * DAY);
		const child = await addFile(project, "child.jsonl", NOW - 10 * DAY);
		const plan = planOf([[parent, child]]);

		await applyPlans(plan, NOW);
		const second = await applyPlans(plan, NOW);

		expect(second).toEqual({ archived: 0, families: 0, failed: [] });
		expect(await exists(toArchivePath(parent))).toBe(true);
	});

	it("skips the whole family when a target already exists", async () => {
		const parent = await addFile(project, "parent.jsonl", NOW - 10 * DAY);
		const child = await addFile(project, "child.jsonl", NOW - 10 * DAY);
		const taken = await addFile(
			join(project, "archive"),
			"child.jsonl",
			NOW - 100 * DAY,
			"existing\n",
		);

		const result = await applyPlans(planOf([[parent, child]]), NOW);

		expect(result.archived).toBe(0);
		expect(result.families).toBe(0);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.path).toBe(taken);
		expect(await exists(parent)).toBe(true);
		expect(await exists(child)).toBe(true);
		expect(await readFile(taken, "utf8")).toBe("existing\n");
		expect(await exists(toArchivePath(parent))).toBe(false);
	});

	it("rolls earlier members back when a later move fails", async () => {
		const parent = await addFile(project, "parent.jsonl", NOW - 10 * DAY);
		const child = await addFile(project, "child.jsonl", NOW - 10 * DAY);
		let calls = 0;
		const deps: ArchiveDeps = {
			rename: async (from, to) => {
				calls += 1;
				if (calls === 2) {
					throw Object.assign(new Error("rename exploded"), { code: "EIO" });
				}
				const fs = await import("node:fs/promises");
				await fs.rename(from, to);
			},
		};

		const result = await applyPlans(planOf([[parent, child]]), NOW, deps);

		expect(result).toMatchObject({ archived: 0, families: 0 });
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.path).toBe(child);
		expect(await exists(parent)).toBe(true);
		expect(await exists(child)).toBe(true);
		expect(await exists(toArchivePath(parent))).toBe(false);
		expect(await exists(toArchivePath(child))).toBe(false);
	});
});

describe("applyMoves", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-archive-ops-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("moves and stamps a single file, then reports a rerun as nothing", async () => {
		const project = join(root, "--work-a--");
		const from = await addFile(project, "a.jsonl", NOW - 10 * DAY);
		const to = toArchivePath(from);

		const first = await applyMoves([{ from, to }], NOW);
		expect(first).toEqual({ archived: 1, families: 1, failed: [] });
		expect(Math.abs((await stat(to)).mtimeMs - NOW)).toBeLessThan(2000);

		const second = await applyMoves([{ from, to }], NOW);
		expect(second.archived).toBe(0);
		expect(await exists(to)).toBe(true);
	});
});

describe("unarchive", () => {
	let root: string;
	let projectA: string;
	let projectB: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-archive-ops-"));
		projectA = join(root, "--work-a--");
		projectB = join(root, "--work-b--");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("restores a whole cross-project family with a fresh mtime", async () => {
		const archivedParent = await addFile(
			join(projectA, "archive"),
			"parent.jsonl",
			NOW - 10 * DAY,
		);
		const archivedChild = await addFile(
			join(projectB, "archive"),
			"child.jsonl",
			NOW - 10 * DAY,
		);

		const restored = await unarchive([archivedParent, archivedChild], NOW);

		expect(restored).toEqual([
			join(projectA, "parent.jsonl"),
			join(projectB, "child.jsonl"),
		]);
		expect(await exists(join(projectA, "parent.jsonl"))).toBe(true);
		expect(await exists(join(projectB, "child.jsonl"))).toBe(true);
		expect(await exists(archivedParent)).toBe(false);
		expect(await exists(archivedChild)).toBe(false);
		expect(
			Math.abs((await stat(join(projectA, "parent.jsonl"))).mtimeMs - NOW),
		).toBeLessThan(2000);
	});

	it("refuses the whole restore when any target already exists", async () => {
		const archivedParent = await addFile(
			join(projectA, "archive"),
			"parent.jsonl",
			NOW - 10 * DAY,
			"archived parent\n",
		);
		const archivedChild = await addFile(
			join(projectA, "archive"),
			"child.jsonl",
			NOW - 10 * DAY,
			"archived child\n",
		);
		const existing = await addFile(
			projectA,
			"child.jsonl",
			NOW - 2 * DAY,
			"existing child\n",
		);

		const restored = await unarchive([archivedParent, archivedChild], NOW);

		expect(restored).toEqual([]);
		expect(await exists(archivedParent)).toBe(true);
		expect(await exists(archivedChild)).toBe(true);
		expect(await readFile(existing, "utf8")).toBe("existing child\n");
		expect(await exists(join(projectA, "parent.jsonl"))).toBe(false);
	});

	it("restores with link + unlink, never rename", async () => {
		const archived = await addFile(
			join(projectA, "archive"),
			"a.jsonl",
			NOW - 10 * DAY,
		);
		const links: string[] = [];
		const deps: ArchiveDeps = {
			rename: async () => {
				throw new Error("unarchive must not rename");
			},
			link: async (from, to) => {
				const fs = await import("node:fs/promises");
				links.push(String(to));
				await fs.link(from, to);
			},
		};

		const restored = await unarchive([archived], NOW, deps);

		expect(restored).toEqual([join(projectA, "a.jsonl")]);
		expect(links).toEqual([join(projectA, "a.jsonl")]);
		expect(await exists(archived)).toBe(false);
	});
});

describe("purgeArchived", () => {
	let root: string;
	let project: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-archive-ops-"));
		project = join(root, "--work-a--");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("purges only archived files past the cutoff", async () => {
		const archiveDir = join(project, "archive");
		const old = await addFile(archiveDir, "old.jsonl", NOW - 10 * DAY);
		const fresh = await addFile(archiveDir, "fresh.jsonl", NOW - DAY);
		const live = await addFile(project, "live.jsonl", NOW - 30 * DAY);
		const { trash, trashed } = fakeTrash();

		const result = await purgeArchived([project], 5, NOW, {
			deps: { trash },
		});

		expect(result.purged).toBe(1);
		expect(trashed).toEqual([old]);
		expect(trashed).not.toContain(live);
		expect(await exists(fresh)).toBe(true);
		expect(result.failed).toEqual([]);
	});

	it("skips a split family whose member was restored", async () => {
		const archived = await addFile(
			join(project, "archive"),
			"a.jsonl",
			NOW - 10 * DAY,
		);
		await addFile(project, "a.jsonl", NOW - 10 * DAY);
		const { trash, trashed } = fakeTrash();

		const result = await purgeArchived([project], 5, NOW, {
			deps: { trash },
		});

		expect(result.purged).toBe(0);
		expect(trashed).toEqual([]);
		expect(result.skipped).toContain(`split: ${archived}`);
		expect(await exists(archived)).toBe(true);
	});

	it("honours isProtectedArchived for cross-project split families", async () => {
		const archived = await addFile(
			join(project, "archive"),
			"parent.jsonl",
			NOW - 10 * DAY,
		);
		const { trash, trashed } = fakeTrash();

		const result = await purgeArchived([project], 5, NOW, {
			deps: { trash },
			isProtectedArchived: (path) => path === archived,
		});

		expect(result.purged).toBe(0);
		expect(trashed).toEqual([]);
		expect(result.skipped).toContain(`split: ${archived}`);
	});

	it("never purges the active session", async () => {
		const archived = await addFile(
			join(project, "archive"),
			"active.jsonl",
			NOW - 10 * DAY,
		);
		const { trash, trashed } = fakeTrash();

		const result = await purgeArchived([project], 5, NOW, {
			activeSessionFile: archived,
			deps: { trash },
		});

		expect(result.purged).toBe(0);
		expect(trashed).toEqual([]);
		expect(result.skipped).toContain(`active: ${archived}`);
	});

	it("skips the phase without trash and never falls back to unlink", async () => {
		const archived = await addFile(
			join(project, "archive"),
			"a.jsonl",
			NOW - 10 * DAY,
		);
		const unlinked: string[] = [];
		const deps: ArchiveDeps = {
			trash: async () => {
				throw enoentError();
			},
			unlink: async (path) => {
				unlinked.push(String(path));
			},
		};

		const result = await purgeArchived([project], 5, NOW, { deps });

		expect(result.purged).toBe(0);
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(unlinked).toEqual([]);
		expect(await exists(archived)).toBe(true);
	});

	it("treats exit 5 with the file gone as success", async () => {
		const archived = await addFile(
			join(project, "archive"),
			"a.jsonl",
			NOW - 10 * DAY,
		);
		const deps: ArchiveDeps = {
			trash: async (path) => {
				await rm(path, { force: true });
				return { ok: false, exitCode: 5 };
			},
		};

		const result = await purgeArchived([project], 5, NOW, { deps });

		expect(result.purged).toBe(1);
		expect(await exists(archived)).toBe(false);
	});
});

describe("deleteSessionFile", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-archive-ops-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("accepts exit 5 when the file is gone", async () => {
		const path = await addFile(join(root, "p"), "a.jsonl", NOW);
		const result = await deleteSessionFile(path, {
			trash: async () => {
				await rm(path, { force: true });
				return { ok: false, exitCode: 5 };
			},
		});
		expect(result).toEqual({ ok: true, method: "trash" });
	});

	it("reports a trash failure that left the file in place", async () => {
		const path = await addFile(join(root, "p"), "a.jsonl", NOW);
		const result = await deleteSessionFile(path, {
			trash: async () => ({ ok: false, exitCode: 5 }),
		});
		expect(result.ok).toBe(false);
		expect(result.method).toBe("trash");
		expect(await exists(path)).toBe(true);
	});

	it("falls back to unlink only when trash is unavailable", async () => {
		const path = await addFile(join(root, "p"), "a.jsonl", NOW);
		const result = await deleteSessionFile(path, {
			trash: async () => {
				throw enoentError();
			},
		});
		expect(result).toEqual({ ok: true, method: "delete" });
		expect(await exists(path)).toBe(false);
	});
});
