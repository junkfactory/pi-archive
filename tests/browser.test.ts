import type { SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
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
});
const CHILD = session("/repo/project/child.jsonl", {
	firstMessage: "Fork child",
	parentSessionPath: ACTIVE.path,
	messageCount: 2,
	modified: new Date(NOW - 120_000),
});
const OTHER = session("/repo/project/other.jsonl", {
	firstMessage: "Other session",
	messageCount: 10,
	modified: new Date(NOW - 180_000),
});
const ARCHIVED_PARENT = session("/repo/project/archive/old.jsonl", {
	firstMessage: "Archived parent",
	cwd: "/repo/legacy",
	messageCount: 9,
	modified: new Date(NOW - 240_000),
});
const ARCHIVED_CHILD = session("/repo/project/archive/old-fork.jsonl", {
	firstMessage: "Archived fork",
	cwd: "/repo/legacy",
	parentSessionPath: ARCHIVED_PARENT.path,
	messageCount: 3,
	modified: new Date(NOW - 300_000),
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
		overrides.deps?.loadScope ?? (async (scope: Scope) => FIXTURES[scope]),
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
		expect(lines[0]).toContain("All (…)");
		expect(lines[0]).toContain("Archived (…)");
		expect(lines[1]).toContain("Tab scope");
		expect(lines[2]).toBe("");
		expect(lines).toHaveLength(6);
		expect(lines[3]?.startsWith("› ")).toBe(true);
		expect(lines[3]).toContain("Active session");
		expect(lines[4]).toContain("Fork child");
		expect(lines[4]).toContain("└─ ");
		expect(lines[5]).toContain("Other session");
		expect(lines[3]).toMatch(/\b6 (now|\d+[mhdw])$/);
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
		expect(lines).toHaveLength(3 + 10 + 1);
		expect(lines.join("\n")).toContain("(1/14)");

		for (let index = 0; index < 13; index++) {
			harness.browser.handleInput("\x1b[B");
		}
		const scrolled = harness.browser.render(80);
		expect(scrolled.join("\n")).toContain("(14/14)");
		expect(scrolled[3]?.startsWith("› ")).toBe(false);
		expect(scrolled[12]?.startsWith("› ")).toBe(true);
	});

	it("renders a load error inline and keeps the picker open", async () => {
		const harness = makeHarness({
			deps: {
				loadScope: async () => {
					throw new Error("boom");
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
	it("lazily loads each scope once and shows Loading… until it resolves", async () => {
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
		expect(harness.loadScope).toHaveBeenCalledTimes(1);
		expect(harness.loadScope).toHaveBeenLastCalledWith("current");

		harness.browser.handleInput("\t");
		expect(harness.loadScope).toHaveBeenLastCalledWith("all");
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
		expect(harness.browser.render(80)[0]).toContain("Archived (2)");

		harness.browser.handleInput("\t");
		await settle();
		expect(harness.loadScope).toHaveBeenCalledTimes(3);
		expect(harness.browser.render(80)[0]).toContain("Current (3)");
	});

	it("resets the cursor when the scope changes", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x1b[B");
		expect(harness.browser.render(80)[4]?.startsWith("› ")).toBe(true);
		harness.browser.handleInput("\t");
		await settle();
		expect(harness.browser.render(80)[3]?.startsWith("› ")).toBe(true);
	});
});

describe("SessionBrowser movement and selection", () => {
	it("moves with arrow keys and clamps at the ends", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("\x1b[A");
		expect(harness.browser.render(80)[3]?.startsWith("› ")).toBe(true);

		harness.browser.handleInput("\x1b[B");
		expect(harness.browser.render(80)[4]?.startsWith("› ")).toBe(true);

		harness.browser.handleInput("\x1b[B");
		harness.browser.handleInput("\x1b[B");
		expect(harness.browser.render(80)[5]?.startsWith("› ")).toBe(true);
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
		expect(harness.browser.render(80)[1]).toContain("Session already active");
	});
});

describe("SessionBrowser archive", () => {
	it("archives the whole family from the All set and drops the rows", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("a");
		await settle();

		expect(harness.loadScope).toHaveBeenCalledWith("all");
		expect(harness.archive).toHaveBeenCalledWith(ACTIVE.path);
		const rendered = text(harness);
		expect(rendered).not.toContain("Active session");
		expect(rendered).not.toContain("Fork child");
		expect(rendered).toContain("Other session");
		expect(harness.browser.render(80)[0]).toContain("Current (1)");
		expect(harness.browser.render(80)[1]).toContain("Archived 2 session(s)");
	});

	it("refuses the open session without calling a dep", async () => {
		const harness = makeHarness({ activePath: ACTIVE.path });
		await settle();
		harness.browser.handleInput("a");
		await settle();

		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.loadScope).toHaveBeenCalledTimes(1);
		expect(harness.browser.render(80)[1]).toContain(
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
		harness.browser.handleInput("a");
		await settle();

		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[1]).toContain(
			"family contains the active session",
		);
	});

	it("refuses a family with a live member without calling archive", async () => {
		const isLive = vi.fn(async (path: string) => path === CHILD.path);
		const harness = makeHarness({ deps: { isLive } });
		await settle();
		harness.browser.handleInput("a");
		await settle();

		expect(isLive).toHaveBeenCalledWith(CHILD.path);
		expect(harness.archive).not.toHaveBeenCalled();
		expect(harness.browser.render(80)[1]).toContain("session is in use");
	});

	it("ignores a on an archived row", async () => {
		const harness = makeHarness();
		await settle();
		await openArchived(harness);
		harness.browser.handleInput("a");
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
		harness.browser.handleInput("a");
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
		harness.browser.handleInput("u");
		await settle();

		expect(harness.unarchive).toHaveBeenCalledWith(ARCHIVED_PARENT.path);
		expect(harness.onSelect).not.toHaveBeenCalled();
		const rendered = text(harness);
		expect(rendered).not.toContain("Archived parent");
		expect(rendered).not.toContain("Archived fork");
		expect(rendered).toContain("Restored");
		expect(rendered).toContain("Archived (0)");
		expect(harness.loadScope).toHaveBeenCalledTimes(3);
	});

	it("ignores u on an active row", async () => {
		const harness = makeHarness();
		await settle();
		harness.browser.handleInput("u");
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
		harness.browser.handleInput("u");
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
		expect(harness.browser.render(80)[1]).toContain("Delete 2 sessions");

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
		expect(harness.browser.render(80)[1]).toContain("Delete 2 sessions");
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
		expect(harness.browser.render(80)[1]).toContain("Delete 2 sessions");
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
		expect(harness.browser.render(80)[1]).not.toContain("Delete session");
		expect(harness.browser.render(80)[1]).toContain("Tab scope");

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
