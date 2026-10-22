import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Retention config resolved from the machine-wide settings file. */
export interface ArchiveConfig {
	archiveDays: number;
	purgeDays: number;
	disabled: { archive: boolean; purge: boolean };
	warnings: string[];
}

/** Fallbacks used only when a key is absent (or `null`). */
export const DEFAULTS = { archiveDays: 7, purgeDays: 90 };

export interface ConfigDeps {
	/** Reads a UTF-8 text file. Injected in tests so no real settings file is touched. */
	readFile?: (path: string) => string;
}

interface ResolvedDays {
	days: number;
	disabled: boolean;
	warning?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function invalid(key: string, value: unknown, behavior: string): ResolvedDays {
	return {
		// 0 keeps the value inert even if a caller forgets to check `disabled`;
		// it is never a silent fallback to the default retention window.
		days: 0,
		disabled: true,
		warning: `pi-archive: ignoring invalid ${key}=${describeValue(value)} (expected a non-negative number); ${behavior} disabled`,
	};
}

/** One key of the table: absent → default, 0 → disabled, negative/NaN/string/object → disabled + warning. */
function resolveDays(
	key: string,
	value: unknown,
	fallback: number,
	behavior: string,
): ResolvedDays {
	if (value === undefined || value === null) {
		return { days: fallback, disabled: false };
	}

	let days: number;
	if (typeof value === "number") {
		days = value;
	} else if (typeof value === "string" && value.trim() !== "") {
		days = Number(value.trim());
	} else {
		return invalid(key, value, behavior);
	}

	if (!Number.isFinite(days) || days < 0) return invalid(key, value, behavior);
	if (days === 0) return { days: 0, disabled: true };
	return { days, disabled: false };
}

/**
 * Pure resolver. `raw` is the parsed settings object; unknown or non-object
 * input yields defaults. Invalid values disable the behavior and record a
 * warning rather than silently falling back.
 */
export function resolveConfig(raw: unknown): ArchiveConfig {
	const settings = isPlainRecord(raw) ? raw : {};
	const archive = resolveDays(
		"sessionArchiveDays",
		settings.sessionArchiveDays,
		DEFAULTS.archiveDays,
		"auto-archive",
	);
	const purge = resolveDays(
		"sessionArchivePurgeDays",
		settings.sessionArchivePurgeDays,
		DEFAULTS.purgeDays,
		"purge",
	);

	const warnings: string[] = [];
	if (archive.warning) warnings.push(archive.warning);
	if (purge.warning) warnings.push(purge.warning);

	return {
		archiveDays: archive.days,
		purgeDays: purge.days,
		disabled: { archive: archive.disabled, purge: purge.disabled },
		warnings,
	};
}

/**
 * Reads `join(getAgentDir(), "settings.json")` directly. Deliberately not
 * `pi.getSettings()`: that deep-merges `<cwd>/.pi/settings.json`, which would
 * let a repo-local file change retention for every project on the machine.
 * Missing or unparseable files yield defaults.
 */
export function readSettingsConfig(deps: ConfigDeps = {}): ArchiveConfig {
	const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));

	let raw: unknown = null;
	try {
		raw = JSON.parse(read(join(getAgentDir(), "settings.json")));
	} catch {
		raw = null;
	}

	return resolveConfig(raw);
}
