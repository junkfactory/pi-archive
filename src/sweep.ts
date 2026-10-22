/**
 * Sweep orchestration: registry → scan → plan → move → purge.
 *
 * The liveness registry is re-read immediately before each family's renames
 * (F15), not once at startup, so a session opened by another pi window during
 * the run is never moved out from under the process appending to it.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type ArchiveDeps, applyMoves, purgeArchived } from "./archive.js";
import type { ArchiveConfig } from "./config.js";
import { readLive } from "./liveness.js";
import {
	buildFamilies,
	listArchiveDirs,
	listProjectDirs,
	planArchives,
	readSessionNodes,
	type SessionNode,
} from "./scan.js";

const DAY_MS = 86_400_000;

export interface SweepReport {
	archived: number;
	families: number;
	purged: number;
	/** Plan skips (`recent:`/`active:`/`live:`/…), plus non-split purge skips. */
	skipped: string[];
	failed: { path: string; reason: string }[];
	warnings: string[];
	/** Archived paths kept by the purge phase because their family is split (D7). */
	split: string[];
}

export interface SweepOptions {
	agentDir: string;
	sessionsRoot: string;
	activeSessionFile?: string;
	config: ArchiveConfig;
	now?: number;
	deps?: ArchiveDeps;
	onWarn?: (msg: string) => void;
}

/** realpath when the file still exists, else the raw path. */
function pathKey(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function isUnderArchive(path: string): boolean {
	return basename(dirname(path)) === "archive";
}

/**
 * One sweep. Never throws for a single file's failure: everything lands in
 * `failed`, `skipped`, `split` or `warnings`.
 */
export async function runSweep(opts: SweepOptions): Promise<SweepReport> {
	const now = opts.now ?? Date.now();
	const report: SweepReport = {
		archived: 0,
		families: 0,
		purged: 0,
		skipped: [],
		failed: [],
		warnings: [],
		split: [],
	};

	const warn = (msg: string): void => {
		report.warnings.push(msg);
		try {
			opts.onWarn?.(msg);
		} catch {
			// A notification into a stale ctx must never fail the sweep.
		}
	};
	for (const msg of opts.config.warnings) warn(msg);

	const projectDirs = await listProjectDirs(opts.sessionsRoot);
	// A project whose sessions are all archived keeps no top-level `*.jsonl`, so
	// `listProjectDirs` drops it. Its `archive/` must still be purged and must
	// still join the D7 family graph, so enumerate archive-bearing dirs too.
	const purgeDirs = [
		...new Set([...projectDirs, ...(await listArchiveDirs(opts.sessionsRoot))]),
	].sort();
	const nodes: SessionNode[] = [];
	for (const dir of projectDirs) {
		nodes.push(...(await readSessionNodes(dir)));
	}

	const families = new Map(
		buildFamilies(nodes).map((family) => [family[0]?.path ?? "", family]),
	);
	const plan = planArchives(families, {
		now,
		archiveDays: opts.config.archiveDays,
		activeSessionFile: opts.activeSessionFile,
	});
	report.skipped.push(...plan.skipped);

	// Registry check per family, right before its renames (F15).
	for (const family of plan.families) {
		const liveKeys = new Set([...(await readLive(opts.agentDir))].map(pathKey));
		const claimed = family.moves.find((move) =>
			liveKeys.has(pathKey(move.from)),
		);
		if (claimed !== undefined) {
			report.skipped.push(`live: ${claimed.from}`);
			continue;
		}
		const result = await applyMoves(family.moves, now, opts.deps);
		report.archived += result.archived;
		report.families += result.families;
		report.failed.push(...result.failed);
	}

	if (opts.config.disabled.purge) {
		warn("pi-archive: purge disabled (sessionArchivePurgeDays)");
		return report;
	}

	// D7: the family graph spans project dirs *and* their archive dirs, so a
	// family with any member still outside `archive/` (or still fresh) is split
	// and none of its archived members may be purged.
	const graphNodes = [...nodes];
	for (const dir of purgeDirs) {
		graphNodes.push(...(await readSessionNodes(join(dir, "archive"))));
	}
	const cutoff = now - opts.config.purgeDays * DAY_MS;
	const protectedPaths = new Set<string>();
	for (const family of buildFamilies(graphNodes)) {
		const whole = family.every(
			(node) => isUnderArchive(node.path) && node.mtimeMs < cutoff,
		);
		if (whole) continue;
		for (const node of family) protectedPaths.add(pathKey(node.path));
	}
	const isProtectedArchived = (path: string): boolean =>
		protectedPaths.has(pathKey(path));

	const purged = await purgeArchived(purgeDirs, opts.config.purgeDays, now, {
		activeSessionFile: opts.activeSessionFile,
		deps: opts.deps,
		isProtectedArchived,
	});
	report.purged += purged.purged;
	report.failed.push(...purged.failed);
	for (const msg of purged.warnings) warn(msg);
	for (const skip of purged.skipped) {
		if (skip.startsWith("split: "))
			report.split.push(skip.slice("split: ".length));
		else report.skipped.push(skip);
	}

	return report;
}
