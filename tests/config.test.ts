import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, readSettingsConfig, resolveConfig } from "../src/config.js";

const GLOBAL_SETTINGS = join(getAgentDir(), "settings.json");

interface Row {
	name: string;
	present: boolean;
	value?: unknown;
	days: number;
	disabled: boolean;
	warnings: number;
}

const ROWS: Row[] = [
	{ name: "absent", present: false, days: 7, disabled: false, warnings: 0 },
	{
		name: "null",
		present: true,
		value: null,
		days: 7,
		disabled: false,
		warnings: 0,
	},
	{ name: "7", present: true, value: 7, days: 7, disabled: false, warnings: 0 },
	{
		name: '"7"',
		present: true,
		value: "7",
		days: 7,
		disabled: false,
		warnings: 0,
	},
	{ name: "0", present: true, value: 0, days: 0, disabled: true, warnings: 0 },
	{
		name: "-3",
		present: true,
		value: -3,
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: "NaN",
		present: true,
		value: Number.NaN,
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: "Infinity",
		present: true,
		value: Number.POSITIVE_INFINITY,
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: '"x"',
		present: true,
		value: "x",
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: '"  "',
		present: true,
		value: "  ",
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: "object",
		present: true,
		value: { days: 7 },
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: "array",
		present: true,
		value: [7],
		days: 0,
		disabled: true,
		warnings: 1,
	},
	{
		name: "boolean",
		present: true,
		value: true,
		days: 0,
		disabled: true,
		warnings: 1,
	},
];

function rawWith(key: string, row: Row): Record<string, unknown> {
	return row.present ? { [key]: row.value } : {};
}

describe("resolveConfig", () => {
	it("defaults when raw is absent or not a settings object", () => {
		for (const raw of [undefined, null, [], "x", 42, true]) {
			expect(resolveConfig(raw)).toEqual({
				archiveDays: DEFAULTS.archiveDays,
				purgeDays: DEFAULTS.purgeDays,
				disabled: { archive: false, purge: false },
				warnings: [],
			});
		}
	});

	it.each(ROWS)("sessionArchiveDays: $name", (row) => {
		const config = resolveConfig(rawWith("sessionArchiveDays", row));
		expect(config.archiveDays).toBe(row.days);
		expect(config.disabled.archive).toBe(row.disabled);
		expect(config.warnings).toHaveLength(row.warnings);
		// The untouched key keeps its default.
		expect(config.purgeDays).toBe(DEFAULTS.purgeDays);
		expect(config.disabled.purge).toBe(false);
	});

	it.each(ROWS)("sessionArchivePurgeDays: $name", (row) => {
		const config = resolveConfig(rawWith("sessionArchivePurgeDays", row));
		// Absent/null keep the purge default (90), not the archive default in `row.days`.
		const expected =
			row.value === undefined || row.value === null
				? DEFAULTS.purgeDays
				: row.days;
		expect(config.purgeDays).toBe(expected);
		expect(config.disabled.purge).toBe(row.disabled);
		expect(config.warnings).toHaveLength(row.warnings);
		expect(config.archiveDays).toBe(DEFAULTS.archiveDays);
		expect(config.disabled.archive).toBe(false);
	});

	it("names the offending key in the warning", () => {
		const config = resolveConfig({
			sessionArchiveDays: -1,
			sessionArchivePurgeDays: "x",
		});
		expect(config.warnings).toHaveLength(2);
		expect(config.warnings[0]).toContain("sessionArchiveDays");
		expect(config.warnings[1]).toContain("sessionArchivePurgeDays");
		expect(config.disabled).toEqual({ archive: true, purge: true });
	});

	it("accepts both keys together", () => {
		expect(
			resolveConfig({ sessionArchiveDays: 3, sessionArchivePurgeDays: 10 }),
		).toEqual({
			archiveDays: 3,
			purgeDays: 10,
			disabled: { archive: false, purge: false },
			warnings: [],
		});
	});
});

describe("readSettingsConfig", () => {
	const tempDirs: string[] = [];

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-archive-config-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("reads only the global settings path", () => {
		const readFile = vi.fn(() =>
			JSON.stringify({ sessionArchiveDays: 30, sessionArchivePurgeDays: 365 }),
		);
		const config = readSettingsConfig({ readFile });

		expect(readFile).toHaveBeenCalledTimes(1);
		expect(readFile).toHaveBeenCalledWith(GLOBAL_SETTINGS);
		expect(config.archiveDays).toBe(30);
		expect(config.purgeDays).toBe(365);
		expect(config.disabled).toEqual({ archive: false, purge: false });
		expect(config.warnings).toEqual([]);
	});

	it("falls back to defaults when the file is missing", () => {
		const config = readSettingsConfig({
			readFile: () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		});
		expect(config).toEqual({
			archiveDays: DEFAULTS.archiveDays,
			purgeDays: DEFAULTS.purgeDays,
			disabled: { archive: false, purge: false },
			warnings: [],
		});
	});

	it("falls back to defaults when the file is unparseable", () => {
		const config = readSettingsConfig({ readFile: () => "{not json" });
		expect(config.archiveDays).toBe(DEFAULTS.archiveDays);
		expect(config.purgeDays).toBe(DEFAULTS.purgeDays);
		expect(config.warnings).toEqual([]);
	});

	it("disables and warns on an invalid key instead of using the default", () => {
		const config = readSettingsConfig({
			readFile: () => JSON.stringify({ sessionArchivePurgeDays: "x" }),
		});
		expect(config.purgeDays).toBe(0);
		expect(config.disabled.purge).toBe(true);
		expect(config.warnings).toHaveLength(1);
		expect(config.warnings[0]).toContain("sessionArchivePurgeDays");
		// The valid/absent key still gets its default.
		expect(config.archiveDays).toBe(DEFAULTS.archiveDays);
	});

	it("ignores a repo-local <cwd>/.pi/settings.json", () => {
		const cwd = makeTempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ sessionArchiveDays: 1, sessionArchivePurgeDays: 1 }),
		);

		const readFile = vi.fn((path: string) => {
			if (path !== GLOBAL_SETTINGS) throw new Error(`unexpected read: ${path}`);
			return JSON.stringify({
				sessionArchiveDays: 30,
				sessionArchivePurgeDays: 60,
			});
		});

		const originalCwd = process.cwd();
		process.chdir(cwd);
		try {
			const config = readSettingsConfig({ readFile });
			expect(config.archiveDays).toBe(30);
			expect(config.purgeDays).toBe(60);
			expect(readFile).toHaveBeenCalledTimes(1);
			expect(readFile).toHaveBeenCalledWith(GLOBAL_SETTINGS);
		} finally {
			process.chdir(originalCwd);
		}
	});
});
