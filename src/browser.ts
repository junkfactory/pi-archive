/**
 * `SessionBrowser` — the two-bucket picker behind `/pi-archive`.
 *
 * The component owns every stateful action (scope cycle, movement, archive,
 * unarchive, delete confirmation) and reports terminal outcomes through
 * `onSelect` / `onClose` only. It never touches the filesystem: every effect
 * goes through the injected `deps`. `done()` is not a dependency, because
 * `ui.custom` resolves exactly once and the command's factory owns it.
 */

import { resolve } from "node:path";
import type {
	KeybindingsManager,
	SessionInfo,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	buildRows,
	familyMembers,
	formatAge,
	type Row,
	type Scope,
	shortenPath,
} from "./sessions.js";

export interface ArchiveResult {
	ok: boolean;
	count?: number;
	error?: string;
}

export interface RemoveResult {
	ok: boolean;
	method?: string;
	error?: string;
	/** Files actually removed: the row's whole subtree, root first. */
	paths?: string[];
}

/** Filesystem seams. `done()` is deliberately absent — see the module docs. */
export interface SessionBrowserDeps {
	loadScope: (scope: Scope) => Promise<SessionInfo[]>;
	archive: (path: string) => Promise<ArchiveResult>;
	unarchive: (path: string) => Promise<{ ok: boolean; error?: string }>;
	remove: (path: string) => Promise<RemoveResult>;
	/**
	 * Optional liveness probe so a family held by another pid is refused before
	 * `archive` touches the disk. The `archive` dep must still guard.
	 */
	isLive?: (path: string) => boolean | Promise<boolean>;
}

export interface SessionBrowserOptions {
	activePath?: string;
	initialScope: Scope;
	theme: Theme;
	keybindings: KeybindingsManager;
	tui: TUI;
	deps: SessionBrowserDeps;
	onSelect: (path: string, scope: Scope) => void;
	onClose: () => void;
}

const SCOPES: readonly Scope[] = ["current", "all", "archived"];
const LABELS: Record<Scope, string> = {
	current: "Current",
	all: "All",
	archived: "Archived",
};
const MAX_VISIBLE = 10;
const PAGE_SIZE = 5;

function hint(scope: Scope): string {
	return [
		"type to search",
		"Tab scope",
		"↑↓ move",
		"Enter open",
		scope === "archived" ? "ctrl+u restore" : "ctrl+a archive",
		"ctrl+d delete",
		"Esc clear/close",
	].join(" · ");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Same glyph set as the built-in picker's threaded mode. */
function treePrefix(row: Row): string {
	if (row.depth === 0) return "";
	const parts = row.ancestorContinues.map((continues) =>
		continues ? "│  " : "   ",
	);
	return parts.join("") + (row.isLast ? "└─ " : "├─ ");
}

/** Same searchable text as pi's built-in picker (session-selector-search.js). */
function searchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export class SessionBrowser implements Component, Focusable {
	private readonly searchInput: Input;
	private query = "";
	private dataVersion = 0;
	private filtered:
		| { scope: Scope; query: string; version: number; rows: Row[] }
		| undefined;

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	private readonly activePath: string | undefined;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly deps: SessionBrowserDeps;
	private readonly onSelect: (path: string, scope: Scope) => void;
	private readonly onClose: () => void;

	private scope: Scope;
	private scopes: Partial<Record<Scope, SessionInfo[]>> = {};
	private loading: Scope[] = [];
	private pending = new Map<Scope, Promise<SessionInfo[]>>();
	private status = "";
	private statusIsError = false;
	/** `count` is `undefined` while the subtree is still being resolved. */
	private confirmDelete:
		| { path: string; count: number | undefined }
		| undefined;
	private selectedIndex = 0;
	private cachedLines: string[] | undefined;
	private cachedWidth = -1;

	constructor(options: SessionBrowserOptions) {
		this.activePath = options.activePath;
		this.scope = options.initialScope;
		this.theme = options.theme;
		this.searchInput = new Input({
			placeholder: "Search name, message, path…",
			placeholderStyle: (text) => this.theme.fg("muted", text),
		});
		this.keybindings = options.keybindings;
		this.tui = options.tui;
		this.deps = options.deps;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		void this.load(this.scope);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = this.buildLines(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	handleInput(data: string): void {
		const keybindings = this.keybindings;
		if (this.confirmDelete !== undefined) {
			// Deleting removes the row's subtree, so the count must be on screen
			// before a second ctrl+d is accepted.
			if (this.confirmDelete.count === undefined) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					this.confirmDelete = undefined;
					this.touch();
				}
				return;
			}
			if (keybindings.matches(data, "app.session.delete")) {
				void this.confirmRemoval();
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				this.confirmDelete = undefined;
				this.touch();
			}
			return;
		}
		if (keybindings.matches(data, "tui.input.tab")) {
			this.cycleScope();
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageUp")) {
			this.move(-PAGE_SIZE);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown")) {
			this.move(PAGE_SIZE);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.select();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (this.query !== "") {
				this.clearQuery();
				return;
			}
			this.onClose();
			return;
		}
		if (keybindings.matches(data, "app.session.delete")) {
			this.startDelete();
			return;
		}
		if (matchesKey(data, "ctrl+a")) {
			void this.archiveSelected();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			void this.unarchiveSelected();
			return;
		}
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== this.query) {
			this.query = this.searchInput.getValue();
			this.selectedIndex = 0;
		}
		this.touch();
	}

	// ---- state -------------------------------------------------------------

	private rows(scope: Scope = this.scope): Row[] {
		const sessions = this.scopes[scope] ?? [];
		const query = this.query.trim();
		if (!query) return buildRows(sessions);
		const cached = this.filtered;
		if (
			cached?.scope === scope &&
			cached.query === query &&
			cached.version === this.dataVersion
		) {
			return cached.rows;
		}
		const rows = fuzzyFilter(sessions, query, searchText).map((session) => ({
			session,
			depth: 0,
			isLast: true,
			ancestorContinues: [],
		}));
		this.filtered = { scope, query, version: this.dataVersion, rows };
		return rows;
	}

	private clearQuery(): void {
		this.searchInput.setValue("");
		this.query = "";
		this.selectedIndex = 0;
		this.touch();
	}

	private isActive(path: string): boolean {
		return (
			this.activePath !== undefined &&
			resolve(path) === resolve(this.activePath)
		);
	}

	private setStatus(text: string, isError: boolean): void {
		this.status = text;
		this.statusIsError = isError;
		this.touch();
	}

	private touch(): void {
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private clampSelection(length = this.rows().length): void {
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, length - 1));
	}

	private dropPaths(paths: readonly string[]): void {
		const keys = new Set(paths.map((path) => resolve(path)));
		for (const scope of SCOPES) {
			const sessions = this.scopes[scope];
			if (!sessions) continue;
			this.scopes[scope] = sessions.filter(
				(session) => !keys.has(resolve(session.path)),
			);
		}
		this.dataVersion++;
	}

	/** Lazy load: one call per scope, cached even when the load fails. */
	private load(scope: Scope): Promise<SessionInfo[]> {
		const cached = this.scopes[scope];
		if (cached) return Promise.resolve(cached);
		const inflight = this.pending.get(scope);
		if (inflight) return inflight;

		this.loading = [...this.loading, scope];
		this.touch();

		const promise = this.deps
			.loadScope(scope)
			.then(
				(sessions) => {
					this.scopes[scope] = sessions;
					this.dataVersion++;
					return sessions;
				},
				(error: unknown) => {
					this.scopes[scope] = [];
					this.setStatus(
						`Failed to load ${LABELS[scope]}: ${errorMessage(error)}`,
						true,
					);
					return [];
				},
			)
			.finally(() => {
				this.loading = this.loading.filter((loading) => loading !== scope);
				this.pending.delete(scope);
				this.clampSelection();
				this.touch();
			});
		this.pending.set(scope, promise);
		return promise;
	}

	// ---- actions -----------------------------------------------------------

	private cycleScope(): void {
		const index = SCOPES.indexOf(this.scope);
		const next = SCOPES[(index + 1) % SCOPES.length];
		if (next === undefined) return;
		this.scope = next;
		this.selectedIndex = 0;
		this.status = "";
		this.statusIsError = false;
		this.confirmDelete = undefined;
		this.touch();
		void this.load(next);
	}

	private move(delta: number): void {
		const length = this.rows().length;
		if (length === 0) return;
		const next = Math.max(0, Math.min(this.selectedIndex + delta, length - 1));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.touch();
	}

	private selectedRow(): Row | undefined {
		return this.rows()[this.selectedIndex];
	}

	private select(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (this.scope !== "archived" && this.isActive(row.session.path)) {
			this.setStatus("Session already active", false);
			return;
		}
		this.onSelect(row.session.path, this.scope);
	}

	private async archiveSelected(): Promise<void> {
		if (this.scope === "archived") return; // archived rows are not re-archived
		const row = this.selectedRow();
		if (!row) return;
		const path = row.session.path;
		if (this.isActive(path)) {
			this.setStatus("Cannot archive the active session", true);
			return;
		}

		// The family comes from `All`, not the cwd-filtered scope, so a
		// cross-project child is refused with its parent instead of orphaned.
		const all = await this.load("all");
		const family = familyMembers(all, path);
		const members = family.length > 0 ? family : [row.session];

		if (members.some((member) => this.isActive(member.path))) {
			this.setStatus(
				"Cannot archive: family contains the active session",
				true,
			);
			return;
		}

		const { isLive } = this.deps;
		if (isLive) {
			const live = await Promise.all(
				members.map((member) => isLive(member.path)),
			);
			if (live.some(Boolean)) {
				this.setStatus("Cannot archive: session is in use", true);
				return;
			}
		}

		const result = await this.deps.archive(path);
		if (!result.ok) {
			this.setStatus(result.error ?? "Archive failed", true);
			return;
		}
		this.dropPaths(members.map((member) => member.path));
		const count = result.count ?? members.length;
		this.clampSelection();
		this.setStatus(`Archived ${count} session(s)`, false);
	}

	private async unarchiveSelected(): Promise<void> {
		if (this.scope !== "archived") return; // active rows stay put
		const row = this.selectedRow();
		if (!row) return;
		const path = row.session.path;
		const family = familyMembers(this.scopes.archived ?? [], path);
		const members = family.length > 0 ? family : [row.session];

		const result = await this.deps.unarchive(path);
		if (!result.ok) {
			this.setStatus(result.error ?? "Restore failed", true);
			return;
		}
		this.dropPaths(members.map((member) => member.path));
		this.clampSelection();
		this.setStatus("Restored", false);
	}

	private startDelete(): void {
		const row = this.selectedRow();
		if (!row) return;
		const target = row.session.path;
		this.confirmDelete = { path: target, count: undefined };
		this.touch();
		void this.resolveDeleteCount(target);
	}

	/** `remove` deletes the subtree, so the prompt reports its real size. */
	private async resolveDeleteCount(path: string): Promise<void> {
		const [all, archived] = await Promise.all([
			this.load("all"),
			this.load("archived"),
		]);
		const pending = this.confirmDelete;
		if (pending === undefined || resolve(pending.path) !== resolve(path))
			return;
		const family = familyMembers([...all, ...archived], path);
		this.confirmDelete = {
			path,
			count: Math.max(1, family.length),
		};
		this.touch();
	}

	private async confirmRemoval(): Promise<void> {
		const pending = this.confirmDelete;
		if (pending === undefined || pending.count === undefined) return;
		this.confirmDelete = undefined;
		const result = await this.deps.remove(pending.path);
		const removed = result.paths ?? (result.ok ? [pending.path] : []);
		if (removed.length > 0) {
			this.dropPaths(removed);
			this.clampSelection();
		}
		if (!result.ok) {
			this.setStatus(result.error ?? "Delete failed", true);
			return;
		}
		this.setStatus(
			removed.length > 1 ? `Deleted ${removed.length} sessions` : "Deleted",
			false,
		);
	}

	// ---- rendering ---------------------------------------------------------

	private headerLine(width: number): string {
		const parts = SCOPES.map((scope) => {
			const label = this.countLabel(scope);
			return scope === this.scope
				? this.theme.fg("accent", label)
				: this.theme.fg("muted", label);
		});
		return truncateToWidth(
			`${this.theme.bold("Sessions")}  ${parts.join(" | ")}`,
			width,
			"…",
		);
	}

	private countLabel(scope: Scope): string {
		const sessions = this.scopes[scope];
		const query = this.query.trim();
		if (sessions !== undefined && query !== "" && scope === this.scope) {
			return `${LABELS[scope]} (${this.rows(scope).length}/${sessions.length})`;
		}
		const count = sessions === undefined ? "…" : String(sessions.length);
		return `${LABELS[scope]} (${count})`;
	}

	/** Names the real blast radius: `remove` deletes the whole subtree. */
	private confirmDeletePrompt(): string {
		const count = this.confirmDelete?.count;
		if (count === undefined)
			return "Delete session and its forks? Esc to cancel";
		const what =
			count > 1 ? `${count} sessions (this row and its forks)` : "session";
		return `Delete ${what}? Press Ctrl+D again to confirm · Esc to cancel`;
	}

	private hintLine(width: number): string {
		if (this.confirmDelete !== undefined) {
			return this.theme.fg(
				"error",
				truncateToWidth(this.confirmDeletePrompt(), width, "…"),
			);
		}
		if (this.status) {
			return this.theme.fg(
				this.statusIsError ? "error" : "accent",
				truncateToWidth(this.status, width, "…"),
			);
		}
		return this.theme.fg(
			"muted",
			truncateToWidth(hint(this.scope), width, "…"),
		);
	}

	private rowLine(row: Row, index: number, width: number): string {
		const session = row.session;
		const isSelected = index === this.selectedIndex;
		const isActive = this.isActive(session.path);
		const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
		const prefix = treePrefix(row);
		const label =
			(session.name ?? session.firstMessage).replace(/\p{Cc}/gu, " ").trim() ||
			"(untitled)";
		const age = formatAge(session.modified);
		const meta = `${session.messageCount} ${age}`;
		const showCwd = this.scope === "all" || this.scope === "archived";
		const right =
			showCwd && session.cwd ? `${shortenPath(session.cwd)} ${meta}` : meta;

		const available =
			width - 2 - visibleWidth(prefix) - visibleWidth(right) - 1;
		const text = truncateToWidth(label, Math.max(10, available), "…");
		let styled = this.theme.fg(isActive ? "accent" : "text", text);
		if (isSelected) styled = this.theme.bold(styled);

		const left = cursor + this.theme.fg("dim", prefix) + styled;
		const spacing = Math.max(
			1,
			width - visibleWidth(left) - visibleWidth(right),
		);
		return truncateToWidth(
			left + " ".repeat(spacing) + this.theme.fg("dim", right),
			width,
			"…",
		);
	}

	private buildLines(width: number): string[] {
		const lines = [
			this.headerLine(width),
			...this.searchInput.render(width),
			this.hintLine(width),
			"",
		];
		if (
			this.loading.includes(this.scope) ||
			this.scopes[this.scope] === undefined
		) {
			lines.push(this.theme.fg("muted", "  Loading…"));
			return lines;
		}
		const rows = this.rows();
		this.clampSelection(rows.length);
		if (rows.length === 0) {
			const query = this.query.trim();
			lines.push(
				this.theme.fg(
					"muted",
					query !== "" ? `  No matches for "${query}"` : "  No sessions",
				),
			);
			return lines;
		}
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
				rows.length - MAX_VISIBLE,
			),
		);
		const end = Math.min(start + MAX_VISIBLE, rows.length);
		for (let index = start; index < end; index++) {
			const row = rows[index];
			if (row) lines.push(this.rowLine(row, index, width));
		}
		if (start > 0 || end < rows.length) {
			lines.push(
				this.theme.fg(
					"muted",
					truncateToWidth(
						`  (${this.selectedIndex + 1}/${rows.length})`,
						width,
						"",
					),
				),
			);
		}
		return lines;
	}
}
