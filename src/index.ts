/**
 * pi-archive
 *
 * Pi extension that auto-archives stale session files into
 * `<project-session-dir>/archive/`, purges old archives, and browses active
 * and archived sessions in a `/pi-archive` picker.
 */

import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionBrowser } from "./browser.js";
import { readSettingsConfig } from "./config.js";
import { readLive, registerLive, unregisterLive } from "./liveness.js";
import { makeActions, selectSession } from "./session-actions.js";
import { runSweep, type SweepReport } from "./sweep.js";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Capture `ctx.ui.notify` closure in a `uiValid` flag *now*, synchronously:
 * after any session switch the ctx is stale and the runner throws. A dead ui
 * means a dropped warning, never an unhandled rejection.
 */
function captureNotify(ctx: ExtensionContext): (msg: string) => void {
	const notify = ctx.ui.notify;
	let uiValid = true;
	return (msg: string): void => {
		if (!uiValid) return;
		try {
			notify.call(ctx.ui, msg, "warning");
		} catch {
			uiValid = false;
		}
	};
}

function safeNotify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Stale ctx: nothing left to tell.
	}
}

function sweepOptions(ctx: ExtensionContext, onWarn?: (msg: string) => void) {
	const agentDir = getAgentDir();
	return {
		agentDir,
		sessionsRoot: join(agentDir, "sessions"),
		activeSessionFile: ctx.sessionManager.getSessionFile(),
		config: readSettingsConfig(),
		onWarn,
	};
}

function formatReport(report: SweepReport): string {
	return `pi-archive: archived ${report.archived} from ${report.families} families, purged ${report.purged}`;
}

/** Terminal picker outcomes; `done()` resolves the `ui.custom` promise once. */
type BrowserResult = { kind: "select"; path: string } | { kind: "close" };

let sweepErrorReported = false;

export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("pi-archive", {
		description:
			"Browse active and archived sessions, or sweep old ones (pi-archive).",
		getArgumentCompletions: (prefix) =>
			["sweep"]
				.filter((a) => a.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (args.trim() === "sweep") {
				await sweepNow(ctx);
				return;
			}
			await openBrowser(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		// Every reason, not just "startup": a /resume'd old session must be
		// claimed so another window's sweep cannot move it (F15).
		const agentDir = getAgentDir();
		const file = ctx.sessionManager.getSessionFile();
		if (file) await registerLive(agentDir, file).catch(() => {});

		// Auto-sweep only on startup in a dialog-capable run (F7: never delay
		// startup; print/json runs must not start background filesystem work).
		if (event.reason !== "startup" || !ctx.hasUI) return;

		const notify = captureNotify(ctx);
		void runSweep(sweepOptions(ctx, notify)).catch((err: unknown) => {
			if (sweepErrorReported) return;
			sweepErrorReported = true;
			notify(`pi-archive: sweep failed: ${errorMessage(err)}`);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (file) await unregisterLive(getAgentDir(), file).catch(() => {});
	});
}

/** `/pi-archive`: idle, preload the current scope, then run the picker. */
async function openBrowser(ctx: ExtensionCommandContext): Promise<void> {
	const agentDir = getAgentDir();
	const sessionDir = ctx.sessionManager.getSessionDir();
	const activeSessionFile = ctx.sessionManager.getSessionFile();
	const actions = makeActions({
		agentDir,
		cwd: ctx.cwd,
		sessionDir,
		// Same branch as the built-in picker: only the default root recurses
		// into project dirs, so `listAll` must be called with no argument there.
		usesDefaultDir: resolve(sessionDir) === resolve(join(agentDir, "sessions")),
		activeSessionFile,
		listAll: (dir) => SessionManager.listAll(dir),
		isLive: async (path) => (await readLive(agentDir)).has(path),
	});

	await ctx.waitForIdle();
	// Preload so the first frame is not empty. `actions.load` caches per scope,
	// so the component's own initial load resolves without another disk pass.
	await actions.load("current").catch(() => {});

	const result = await ctx.ui.custom<BrowserResult>(
		(tui, theme, keybindings, done) =>
			new SessionBrowser({
				activePath: activeSessionFile,
				initialScope: "current",
				theme,
				keybindings,
				tui,
				deps: {
					loadScope: actions.load,
					archive: actions.archive,
					unarchive: actions.unarchive,
					remove: actions.remove,
				},
				onSelect: (path) => done({ kind: "select", path }),
				onClose: () => done({ kind: "close" }),
			}),
	);

	if (result.kind !== "select") return;
	// `selectSession` returns immediately after `switchSession`: the old ctx is
	// stale from that point on, so the handler must not touch it again.
	await selectSession(
		{
			unarchive: actions.unarchive,
			switchSession: (path) => ctx.switchSession(path),
			notify: (message) => safeNotify(ctx, message, "warning"),
		},
		result.path,
	);
}

/** `/pi-archive sweep`: awaited, and never throws into the handler. */
async function sweepNow(ctx: ExtensionCommandContext): Promise<void> {
	try {
		const report = await runSweep(sweepOptions(ctx, captureNotify(ctx)));
		safeNotify(ctx, formatReport(report), "info");
	} catch (err) {
		safeNotify(
			ctx,
			`pi-archive: sweep failed: ${errorMessage(err)}`,
			"warning",
		);
	}
}
