import type { SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	setKeybindings,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import {
	SessionBrowser,
	type SessionBrowserDeps,
	type SessionBrowserOptions,
} from "../src/browser.js";
import type { Scope } from "../src/sessions.js";

const NOW = Date.now();

function session(
	path: string,
	overrides: Partial<SessionInfo> = {},
): SessionInfo {
	return {
		path,
		id: path,
		cwd: "/repo/project",
		created: new Date(NOW - 3_600_000),
		modified: new Date(NOW - 60_000),
		messageCount: 4,
		firstMessage: "Untitled",
		allMessagesText: "",
		...overrides,
	};
}

const ACTIVE = session("/repo/project/active.jsonl", {
	firstMessage: "Active session",
	messageCount: 6,
	allMessagesText: "deploy the zebra service",
});
const CHILD = session("/repo/project/child.jsonl", {
	firstMessage: "Fork child",
	parentSessionPath: ACTIVE.path,
	messageCount: 2,
	modified: new Date(NOW - 120_000),
	allMessagesText: "fork child",
});
const OTHER = session("/repo/project/other.jsonl", {
	firstMessage: "Other session",
	messageCount: 10,
	modified: new Date(NOW - 180_000),
	allMessagesText: "nothing to see",
});
const ARCHIVED_PARENT = session("/repo/project/archive/old.jsonl", {
	firstMessage: "Archived parent",
	cwd: "/repo/legacy",
	messageCount: 9,
	modified: new Date(NOW - 240_000),
	allMessagesText: "archived parent notes",
});
const ARCHIVED_CHILD = session("/repo/project/archive/old-fork.jsonl", {
	firstMessage: "Archived fork",
	cwd: "/repo/legacy",
	parentSessionPath: ARCHIVED_PARENT.path,
	messageCount: 3,
	modified: new Date(NOW - 300_000),
	allMessagesText: "archived fork notes",
});

const FIXTURES: Record<Scope, SessionInfo[]> = {
	current: [ACTIVE, CHILD, OTHER],
	all: [ACTIVE, CHILD, OTHER, ARCHIVED_PARENT, ARCHIVED_CHILD],
	archived: [ARCHIVED_PARENT, ARCHIVED_CHILD],
};

const KEYBINDINGS = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
}) as unknown as SessionBrowserOptions["keybindings"];

// `Input` reads the global keybindings, so the harness must install its own.
setKeybindings(KEYBINDINGS);

interface Harness {
	browser: SessionBrowser;
	archive: Mock;
	unarchive: Mock;
	remove: Mock;
	loadScope: Mock;
	onSelect: Mock;
	onClose: Mock;
	requestRender: Mock;
	theme: Theme;
	colors: Array<[string, string]>;
}

function makeHarness(
	overrides: {
		activePath?: string;
		equalScopes?: boolean;
		initialScope?: Scope;
	} & { deps?: Partial<SessionBrowserDeps> } = {},
): Harness {
	const colors: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			colors.push([color, text]);
			return text;
		},
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		style: (text: string) => text,
	} as unknown as Theme;

	const loadScope = vi.fn(
		overrides.deps?.loadScope ??
			(async (scope: Scope) =>
				overrides.equalScopes && scope !== "archived"
					? FIXTURES.current
					: FIXTURES[scope]),
	);
	const archive = vi.fn(
		overrides.deps?.archive ?? (async () => ({ ok: true })),
	);
	const unarchive = vi.fn(
		overrides.deps?.unarchive ?? (async () => ({ ok: true })),
	);
	const remove = vi.fn(
		overrides.deps?.remove ?? (async () => ({ ok: true, method: "trash" })),
	);
	const deps: SessionBrowserDeps = {
		loadScope,
		archive,
		unarchive,
		remove,
		...(overrides.deps?.isLive ? { isLive: overrides.deps.isLive } : {}),
	};
	const onSelect = vi.fn();
	const onClose = vi.fn();
	const requestRender = vi.fn();
	const browser = new SessionBrowser({
		activePath: overrides.activePath,
		initialScope: overrides.initialScope ?? "current",
		theme,
		keybindings: KEYBINDINGS,
		tui: { requestRender } as unknown as TUI,
		deps,
		onSelect,
		onClose,
	});
	return {
		browser,
		archive,
		unarchive,
		remove,
		loadScope,
		onSelect,
		onClose,
		requestRender,
		theme,
		colors,
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function text(harness: Harness): string {
	return harness.browser.render(80).join("\n");
}

async function openArchived(harness: Harness): Promise<void> {
	harness.browser.handleInput("\t");
	await settle();
	harness.browser.handleInput("\t");
	await settle();
}

describe("SessionBrowser rendering", () => {
	it("renders header, hint, blank line and one line per row", async () => {
		const harness = makeHarness();
		await settle();
		const lines = harness.browser.render(80);

		expect(lines[0]).toContain("Sessions");
		expect(lines[0]).toContain("Current (3)");
		expect(lines[0]).toContain("All (5)");
		expect(lines[0]).toContain("Archived (…)");
		expect(lines[2]).toContain("Tab scope");
		expect(lines[3]).toBe("");
		expect(lines).toHaveLength(4 + 3);
		expect(lines[4]?.startsWith("› ")).toBe(true);
		expect(lines[4]).toContain("Active session");
		expect(lines[5]).toContain("Fork child");
		expect(lines[5]).toContain("└─ ");
		expect(lines[6]).toContain("Other session");
		expect(lines[4]).toMatch(/\b6 (now|\d+[mhdw])$/);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		expect(harness.requestRender).toHaveBeenCalled();
	});

	it("accents the open session and bolds the selected row", async () => {
		const harness = makeHarness({ activePath: ACTIVE.path });
		await settle();
		harness.browser.render(80);
		expect(
			harness.colors.some(
				([color, value]) =>
					color === "accent" && value.includes("Active session"),
			),
		).toBe(true);
		expect(
			harness.colors.some(
				([color, value]) => color === "dim" && value.includes("6 "),
			),
		).toBe(true);
	});

	it("renders cwd on archived rows", async () => {
		const harness = makeHarness();
		await settle();
		await openArchived(harness);
		const lines = harness.browser.render(80);
		expect(lines[0]).toContain("Archived (2)");
		expect(lines.join("\n")).toContain("/repo/legacy");
	});

	it("caps the visible rows and scrolls the window", async () => {
		const many = Array.from({ length: 14 }, (_, index) =>
			session(`/repo/project/s${index}.jsonl`, {
				firstMessage: `Session ${index}`,
				modified: new Date(NOW - index * 60_000),
			}),
		);
		const harness = makeHarness({ deps: { loadScope: async () => many } });
		await settle();
		const lines = harness.browser.render(80);
		expect(lines).toHaveLength(4 + 10 + 1);
		expect(lines.join("\n")).toContain("(1/14)");

		for (let index = 0; index < 13; index++) {
			harness.browser.handleInput("\x1b[B");
		}
		const scrolled = harness.browser.render(80);
		expect(scrolled.join("\n")).toContain("(14/14)");
		expect(scrolled[4]?.startsWith("› ")).toBe(false);
		expect(scrolled[13]?.startsWith("› ")).toBe(true);
	});

	it("renders a load error inline and keeps the picker open", async () => {
		const harness = makeHarness({
			deps: {
				loadScope: async (scope: Scope) => {
					if (scope === "current") throw new Error("boom");
					return FIXTURES[scope];
				},
			},
		});
		await settle();
		const rendered = text(harness);
		expect(rendered).toContain("Failed to load Current: boom");
		expect(rendered).not.toContain("Loading…");
		expect(rendered).toContain("No sessions");
		expect(harness.onClose).not.toHaveBeenCalled();
	});
});

describe("SessionBrowser scopes", () => {
	it("preloads current and all, then loads archived on demand", async () => {
		let finish: (sessions: SessionInfo[]) => void = () => {};
		const deferred = new Promise<SessionInfo[]>((resolve) => {
			finish = resolve;
		});
		const harness = makeHarness({
			deps: {
				loadScope: async (scope) =>
					scope === "all" ? deferred : FIXTURES[scope],
			},
		});
		await settle();
		expect(harness.loadScope).toHaveBeenCalledTimes(2);
		expect(harness.loadScope).toHaveBeenNthCalledWith(1, "current");
		expect(harness.loadScope).toHaveBeenNthCalledWith(2, "all");

		harness.browser.handleInput("\t");
		expect(harness.loadScope).toHaveBeenCalledTimes(2);
		expect(text(harness)).toContain("Loading…");

		finish(FIXTURES.all);
		await settle();
		const loaded = text(harness);
		expect(loaded).not.toContain("Loading…");
		expect(loaded).toContain("All (5)");
		expect(loaded).toContain("Archived parent");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.loadScope).toHaveBeenLastCalledWith("archived");
		expect(harness.loadScope).toHaveBeenCalledTimes(3);
		expect(harness.browser.render(80)[0]).toContain("Archived (2)");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.loadScope).toHaveBeenCalledTimes(3);
		expect(harness.browser.render(80)[0]).toContain("Current (3)");
	});

	it("hides All when it duplicates Current", async () => {
		const harness = makeHarness({ equalScopes: true });
		await settle();
		const lines = harness.browser.render(80);
		expect(lines[0]).toContain("Current (3)");
		expect(lines[0]).toContain("Archived");
		expect(lines[0]).not.toContain("All");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[0]).toContain("Archived (2)");
		expect(text(harness)).toContain("Archived parent");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[0]).toContain("Current (3)");
		expect(text(harness)).toContain("Active session");
	});

	it("cycles to Archived with a query and equal lists", async () => {
		const harness = makeHarness({ equalScopes: true });
		await settle();
		harness.browser.handleInput("zebra");
		harness.browser.handleInput("\t");
		await settle();

		const lines = harness.browser.render(80);
		expect(lines[0]).toContain("Archived (0/2)");
		expect(lines[0]).not.toContain("All");
		expect(lines[1]).toContain("zebra");
		expect(lines.join("\n")).toContain('No matches for "zebra"');
	});

	it("keeps All and its error when the All load rejects", async () => {
		const harness = makeHarness({
			deps: {
				loadScope: async (scope: Scope) => {
					if (scope === "all") throw new Error("boom");
					return FIXTURES[scope];
				},
			},
		});
		await settle();
		const rendered = text(harness);
		expect(rendered).toContain("All (0)");
		expect(rendered).toContain("Failed to load All: boom");
		expect(rendered).not.toContain("Loading…");
		expect(rendered).toContain("Active session");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[0]).toContain("All (0)");
	});

	it("falls back to Current when the All list becomes a duplicate", async () => {
		const foreign = session("/repo/other/foreign.jsonl", {
			cwd: "/repo/other",
			name: "Foreign extra",
			firstMessage: "Foreign extra",
			allMessagesText: "elsewhere entirely",
		});
		const harness = makeHarness({
			deps: {
				loadScope: async (scope: Scope) =>
					scope === "all" ? [...FIXTURES.current, foreign] : FIXTURES[scope],
				archive: async () => ({ ok: true, count: 1 }),
			},
		});
		await settle();
		expect(harness.browser.render(80)[0]).toContain("All (4)");

		harness.browser.handleInput("extra");
		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[0]).toContain("All (1/4)");
		expect(text(harness)).toContain("Foreign extra");

		harness.browser.handleInput("\x01");
		await settle();

		expect(harness.archive).toHaveBeenCalledWith(foreign.path);
		const lines = harness.browser.render(80);
		expect(lines[0]).toContain("Current");
		expect(lines[0]).not.toContain("All");
		expect(lines[1]).toContain("extra");
		expect(lines[2]).toContain("Archived 1 session(s)");
		expect(lines.join("\n")).toContain('No matches for "extra"');
	});

	it("brings All back after restoring a foreign session", async () => {
		let restored = false;
		const harness = makeHarness({
			deps: {
				loadScope: async (scope: Scope) => {
					if (scope === "archived") return FIXTURES.archived;
					if (scope === "all" && restored) {
						return [...FIXTURES.current, ARCHIVED_PARENT];
					}
					return FIXTURES.current;
				},
				unarchive: async () => {
					restored = true;
					return { ok: true };
				},
			},
		});
		await settle();
		expect(harness.browser.render(80)[0]).not.toContain("All");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[0]).toContain("Archived (2)");

		harness.browser.handleInput("\x15");
		await settle();

		expect(harness.unarchive).toHaveBeenCalledWith(ARCHIVED_PARENT.path);
		expect(harness.loadScope).toHaveBeenCalledTimes(5);
		let lines = harness.browser.render(80);
		expect(lines[0]).toContain("Current (3)");
		expect(lines[0]).toContain("All (4)");
		expect(lines[2]).toContain("Restored");

		harness.browser.handleInput("\t");
		await settle();
		harness.browser.handleInput("\t");
		await settle();
		lines = harness.browser.render(80);
		expect(lines[0]).toContain("All (4)");
		expect(text(harness)).toContain("Archived parent");
	});

	it("resets the cursor when the scope changes", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x1b[B");
		expect(harness.browser.render(80)[5]?.startsWith("› ")).toBe(true);
		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[4]?.startsWith("› ")).toBe(true);
	});
});

describe("SessionBrowser movement and selection", () => {
	it("moves with arrow keys and clamps at the ends", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x1b[A");
		expect(harness.browser.render(80)[4]?.startsWith("› ")).toBe(true);

		harness.browser.handleInput("\x1b[B");
		expect(harness.browser.render(80)[5]?.startsWith("› ")).toBe(true);

		harness.browser.handleInput("\x1b[B");
		harness.browser.handleInput("\x1b[B");
		expect(harness.browser.render(80)[6]?.startsWith("› ")).toBe(true);
	});

	it("selects the highlighted session with enter", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x1b[B");
		harness.browser.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledWith(CHILD.path, "current");
	});

	it("reports the archived scope when an archived row is chosen", async () => {
		const harness = makeHarness();
		await settle();
		await openArchived(harness);
		harness.browser.handleInput("\r");
		expect(harness.onSelect).toHaveBeenCalledWith(
			ARCHIVED_PARENT.path,
			"archived",
		);
	});

	it("shows Session already active instead of selecting the open session", async () => {
		const harness = makeHarness({ activePath: ACTIVE.path });
		await settle();
		harness.browser.handleInput("\r");
		expect(harness.onSelect).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[2]).toContain("Session already active");
	});
});

describe("SessionBrowser archive", () => {
	it("archives the whole family from the All set and drops the rows", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x01");
		await settle();

		expect(harness.loadScope).toHaveBeenCalledWith("all");
		expect(harness.archive).toHaveBeenCalledWith(ACTIVE.path);
		const rendered = text(harness);
		expect(rendered).not.toContain("Active session");
		expect(rendered).not.toContain("Fork child");
		expect(rendered).toContain("Other session");
		expect(harness.browser.render(80)[0]).toContain("Current (1)");
		expect(harness.browser.render(80)[2]).toContain("Archived 2 session(s)");
	});

	it("refuses the open session without calling a dep", async () => {
		const harness = makeHarness({ activePath: ACTIVE.path });
		await settle();
		harness.browser.handleInput("\x01");
		await settle();

		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.loadScope).toHaveBeenCalledTimes(2);
		expect(harness.browser.render(80)[2]).toContain(
			"Cannot archive the active session",
		);
		harness.browser.render(80);
		expect(
			harness.colors.some(
				([color, value]) =>
					color === "error" && value.includes("Cannot archive"),
			),
		).toBe(true);
	});

	it("refuses a row whose family contains the open session", async () => {
		const harness = makeHarness({ activePath: CHILD.path });
		await settle();
		harness.browser.handleInput("\x01");
		await settle();

		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[2]).toContain(
			"family contains the active session",
		);
	});

	it("refuses a family with a live member without calling archive", async () => {
		const isLive = vi.fn(async (path: string) => path === CHILD.path);
		const harness = makeHarness({ deps: { isLive } });
		await settle();
		harness.browser.handleInput("\x01");
		await settle();

		expect(isLive).toHaveBeenCalledWith(CHILD.path);
		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[2]).toContain("session is in use");
	});

	it("ignores ctrl+a on an archived row", async () => {
		const harness = makeHarness();
		await settle();
		await openArchived(harness);
		harness.browser.handleInput("\x01");
		await settle();
		expect(harness.archive).not.toHaveBeenCalled();
	});

	it("surfaces an archive failure as a status line", async () => {
		const harness = makeHarness({
			deps: {
				archive: async () => ({ ok: false, error: "cannot move file" }),
			},
		});
		await settle();
		harness.browser.handleInput("\x01");
		await settle();
		expect(text(harness)).toContain("cannot move file");
		expect(text(harness)).toContain("Active session");
	});
});

describe("SessionBrowser unarchive", () => {
	it("restores the archived family without selecting", async () => {
		const harness = makeHarness();
		await settle();
		await openArchived(harness);
		harness.browser.handleInput("\x15");
		await settle();

		expect(harness.unarchive).toHaveBeenCalledWith(ARCHIVED_PARENT.path);
		expect(harness.onSelect).not.toHaveBeenCalled();
		const rendered = text(harness);
		expect(rendered).not.toContain("Archived parent");
		expect(rendered).not.toContain("Archived fork");
		expect(rendered).toContain("Restored");
		expect(rendered).toContain("Archived (0)");
		expect(harness.loadScope).toHaveBeenCalledTimes(5);
	});

	it("ignores ctrl+u on an active row", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x15");
		await settle();
		expect(harness.unarchive).not.toHaveBeenCalled();
	});

	it("surfaces an unarchive failure as a status line", async () => {
		const harness = makeHarness({
			deps: {
				unarchive: async () => ({ ok: false, error: "restore denied" }),
			},
		});
		await settle();
		await openArchived(harness);
		harness.browser.handleInput("\x15");
		await settle();
		expect(text(harness)).toContain("restore denied");
		expect(text(harness)).toContain("Archived parent");
	});
});

describe("SessionBrowser delete", () => {
	it("requires a second ctrl+d before calling remove", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x04");
		expect(harness.remove).not.toHaveBeenCalled();
		await settle();
		expect(harness.browser.render(80)[2]).toContain("Delete 2 sessions");

		harness.browser.handleInput("\x04");
		await settle();
		expect(harness.remove).toHaveBeenCalledWith(ACTIVE.path);
		const rendered = text(harness);
		expect(rendered).not.toContain("Active session");
		expect(rendered).toContain("Deleted");
	});

	it("ignores the confirming ctrl+d until the subtree count is known", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x04");
		// Same tick: the All/Archived loads have not resolved, so the prompt
		// cannot yet say how many sessions die. The confirm must not take.
		harness.browser.handleInput("\x04");
		expect(harness.remove).not.toHaveBeenCalled();
		await settle();
		expect(harness.browser.render(80)[2]).toContain("Delete 2 sessions");
	});

	it("drops every deleted row when remove reports a subtree", async () => {
		const harness = makeHarness({
			deps: {
				remove: async () => ({ ok: true, paths: [ACTIVE.path, CHILD.path] }),
			},
		});
		await settle();
		harness.browser.handleInput("\x04");
		await settle();
		expect(harness.browser.render(80)[2]).toContain("Delete 2 sessions");
		harness.browser.handleInput("\x04");
		await settle();
		const rendered = text(harness);
		expect(rendered).not.toContain("Active session");
		expect(rendered).not.toContain("Fork child");
		expect(rendered).toContain("Deleted 2 sessions");
		expect(rendered).toContain("Other session");
	});

	it("cancels the confirmation with escape, then closes on escape", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x04");
		await settle();
		harness.browser.handleInput("\x1b");
		expect(harness.onClose).not.toHaveBeenCalled();
		expect(harness.remove).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[2]).not.toContain("Delete session");
		expect(harness.browser.render(80)[2]).toContain("Tab scope");

		harness.browser.handleInput("\x1b");
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it("surfaces a delete failure as a status line", async () => {
		const harness = makeHarness({
			deps: {
				remove: async () => ({ ok: false, error: "unlink denied" }),
			},
		});
		await settle();
		harness.browser.handleInput("\x04");
		await settle();
		harness.browser.handleInput("\x04");
		await settle();
		expect(text(harness)).toContain("unlink denied");
		expect(text(harness)).toContain("Active session");
	});
});

describe("SessionBrowser search", () => {
	it("filters to the matching row and drops the tree prefix", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("zebra");

		const filtered = harness.browser.render(80);
		expect(filtered[1]).toContain("zebra");
		expect(filtered).toHaveLength(4 + 1);
		expect(filtered[4]).toContain("Active session");
		expect(filtered.join("\n")).not.toContain("Fork child");
		expect(filtered.join("\n")).not.toContain("Other session");
		expect(filtered.join("\n")).not.toContain("└─");

		// A query matching a parent and its fork renders both flat.
		harness.browser.handleInput("\x1b");
		harness.browser.handleInput("project");
		const flat = harness.browser.render(80);
		expect(flat.join("\n")).toContain("Fork child");
		expect(flat.join("\n")).not.toContain("└─");
	});

	it("types letters instead of archiving or restoring", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("a");
		await settle();

		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.unarchive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[0]).toContain("Current (1/3)");
		const rendered = text(harness);
		expect(rendered).toContain("Active session");
		expect(rendered).not.toContain("Fork child");
	});

	it("matches text that exists only in the transcript", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("service");

		const rendered = text(harness);
		expect(rendered).toContain("Active session");
		expect(rendered).not.toContain("Fork child");
		expect(rendered).not.toContain("Other session");
	});

	it("ranks a name hit before a content-only hit", async () => {
		const named = session("/repo/project/named.jsonl", {
			name: "Quartz migration",
			firstMessage: "Quartz migration",
			allMessagesText: "unrelated notes",
		});
		const content = session("/repo/project/content.jsonl", {
			firstMessage: "Content only",
			allMessagesText: "we discussed quartz yesterday",
		});
		const harness = makeHarness({
			deps: { loadScope: async () => [content, named] },
		});
		await settle();
		harness.browser.handleInput("quartz");

		const rendered = text(harness);
		expect(rendered).toContain("Quartz migration");
		expect(rendered).toContain("Content only");
		expect(rendered.indexOf("Quartz migration")).toBeLessThan(
			rendered.indexOf("Content only"),
		);
	});

	it("reports no matches and never archives from an empty list", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("zzzz");
		expect(text(harness)).toContain('No matches for "zzzz"');

		harness.browser.handleInput("\x01");
		await settle();
		expect(harness.archive).not.toHaveBeenCalled();
		expect(text(harness)).toContain('No matches for "zzzz"');
	});

	it("clears the query on the first escape and closes on the second", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("zebra");
		harness.browser.handleInput("\x1b");

		expect(harness.onClose).not.toHaveBeenCalled();
		const cleared = harness.browser.render(80);
		expect(cleared[1]).not.toContain("zebra");
		expect(cleared[0]).toContain("Current (3)");
		expect(cleared).toHaveLength(4 + 3);

		harness.browser.handleInput("\x1b");
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it("archives the selected row while filtered and drops it", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("zebra");
		harness.browser.handleInput("\x01");
		await settle();

		expect(harness.archive).toHaveBeenCalledWith(ACTIVE.path);
		const rendered = text(harness);
		expect(rendered).not.toContain("Active session");
		expect(rendered).not.toContain("Fork child");
	});

	it("restores the selected archived row while filtered", async () => {
		const harness = makeHarness();
		await settle();
		await openArchived(harness);
		harness.browser.handleInput("parent");
		expect(text(harness)).toContain("Archived parent");

		harness.browser.handleInput("\x15");
		await settle();

		expect(harness.unarchive).toHaveBeenCalledWith(ARCHIVED_PARENT.path);
		expect(harness.onSelect).not.toHaveBeenCalled();
		const rendered = text(harness);
		expect(rendered).not.toContain("Archived parent");
		expect(rendered).not.toContain("Archived fork");
	});

	it("keeps the query across a scope switch", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("zebra");
		harness.browser.handleInput("\t");
		await settle();

		const lines = harness.browser.render(80);
		expect(lines[1]).toContain("zebra");
		expect(lines[0]).toContain("All (1/5)");
		expect(lines.join("\n")).toContain("Active session");
		expect(lines.join("\n")).not.toContain("Archived parent");
	});

	it("shows the filtered and the cleared counts in the header", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("zebra");
		expect(harness.browser.render(80)[0]).toContain("Current (1/3)");

		harness.browser.handleInput("\x1b");
		const cleared = harness.browser.render(80);
		expect(cleared[0]).toContain("Current (3)");
		expect(cleared[0]).not.toContain("(1/3)");
	});

	it("shows the cwd in All but not in Current", async () => {
		const harness = makeHarness();
		await settle();
		const current = harness.browser.render(80).slice(4).join("\n");
		expect(current).not.toContain("/repo/project");

		harness.browser.handleInput("\t");
		await settle();
		const all = harness.browser.render(80).slice(4).join("\n");
		expect(all).toContain("/repo/project");
	});

	it("shows the scope-appropriate action key in the hint", async () => {
		const harness = makeHarness();
		await settle();
		expect(harness.browser.render(80)[2]).toContain("ctrl+a archive");
		expect(harness.browser.render(80)[2]).not.toContain("ctrl+u restore");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[2]).toContain("ctrl+a archive");
		expect(harness.browser.render(80)[2]).not.toContain("ctrl+u restore");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[2]).toContain("ctrl+u restore");
		expect(harness.browser.render(80)[2]).not.toContain("ctrl+a archive");
	});

	it("ignores restore in Current and archive in Archived", async () => {
		const harness = makeHarness();
		await settle();
		const current = harness.browser.render(80)[2];

		harness.browser.handleInput("\x15");
		await settle();
		expect(harness.unarchive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[2]).toBe(current);

		await openArchived(harness);
		const archived = harness.browser.render(80)[2];
		harness.browser.handleInput("\x01");
		await settle();
		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[2]).toBe(archived);
	});
});
