/**
 * dsh-workspace-hierarchy — node half.
 *
 * The browser half ships via `exports["./client"]` and renders the hierarchical
 * workspace tree. This host half adds the one piece of behavior the UI needs
 * beyond the built-in workspace surface: a `delete-session` slash command that
 * PERMANENTLY removes a session (its persisted JSONL log and its workspace
 * account entries). DSH itself exposes no "delete a session" RPC — only
 * archive — so the browser half triggers this command to do the destructive
 * part.
 *
 * Limitations (documented in README):
 *  - The persistence seam (`ctx.sessionPersistence`) has no deletion API, so we
 *    delete the backend's per-session log artifact directly (`locate()` →
 *    `rm`). This is the JSONL backend's layout today.
 *  - A session that is still LIVE (open in this process) keeps an in-memory
 *    agent; if it keeps emitting events it can re-materialize its log. Close /
 *    restart DSH to finalize deletion of a live session.
 */
import { spawn } from "node:child_process";
import { rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const name = "ui-workspace-hierarchy";
const inject = ["commands", "workspaceRegistry"];

/** Absolute path of the bundled low-level session mover (spawned by `move-session`). */
const MOVE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../tools/move-session.js");
/** Absolute path of the bundled workspace renamer (spawned by `rename-workspace`). */
const RENAME_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../tools/rename-workspace.js");

/** Case-insensitive path canon for Windows drives: forward slashes, lowercased. */
function normPath(p) {
	return String(p).replace(/\\/g, "/").toLowerCase();
}

/** True when `child` is `parent` or a strict descendant of `parent`. */
function isPathWithin(child, parent) {
	const c = normPath(child);
	const p = normPath(parent);
	if (c === p) return true;
	return c.startsWith(p.endsWith("/") ? p : p + "/");
}

/** Live (open in this process) sessions whose cwd lives under `path`. */
function liveSessionsUnder(ctx, path) {
	const sessions = ctx.get("sessions");
	const live = sessions?.list?.() ?? [];
	return live.filter((session) => {
		const cwd = session.header?.cwd;
		return typeof cwd === "string" && cwd !== "" && isPathWithin(cwd, path);
	});
}

/**
 * Move one session to a target workspace directory by running the bundled
 * `tools/move-session.js` migration script (rewrites the log header cwd, moves
 * the artifact, updates workspace.json and session_projcache.json). The script
 * validates and backs up before mutating.
 * @param sessionId - the session to move.
 * @param targetCwd - the target workspace directory (must exist).
 * @returns the script's stdout.
 */
function runMoveSession(sessionId, targetCwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [MOVE_SCRIPT, "--id", sessionId, targetCwd, "--apply"], {
			env: process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => { out += chunk.toString(); });
		child.stderr.on("data", (chunk) => { err += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error((err || out || `move-session exited ${code}`).trim()));
		});
	});
}

/**
 * Permanently delete one session:
 *   1. remove it from every workspace's session account (idempotent);
 *   2. delete its persisted log artifact from the session-persistence backend.
 *
 * @param ctx - host root context.
 * @param sessionId - the session id to delete.
 * @returns the number of persisted artifacts removed.
 */
async function deleteSession(ctx, sessionId) {
	// 1) Workspace accounting: detach from every account that references it.
	//    `detachSession` is idempotent for non-accounted ids and never touches
	//    the session's own log.
	const workspaces = ctx.workspaceRegistry.list();
	for (const workspace of workspaces) {
		await workspace.detachSession(sessionId);
	}

	// 2) Persisted log: the persistence seam has no delete API, so locate the
	//    backend's absolute artifact path and remove it directly.
	const persistence = ctx.get("sessionPersistence");
	if (persistence === undefined || typeof persistence.list !== "function") {
		return 0;
	}

	let removed = 0;
	const headers = await persistence.list();
	for (const header of headers) {
		if (String(header.id) !== sessionId) continue;
		const location = persistence.locate(header);
		if (location === undefined || location.path === undefined || location.path === "") continue;
		await rm(location.path, { force: true });
		removed += 1;
		// Best-effort cleanup of the now-empty per-session directory. `rmdir`
		// only removes an EMPTY directory, so it can never over-delete a
		// non-empty ancestor; a failure here is harmless (the log is already gone).
		await rmdir(dirname(location.path)).catch(() => {});
	}

	return removed;
}

/**
 * Run the bundled `tools/rename-workspace.js` migration script, which renames
 * a workspace's directory on disk and rewrites every session cwd (log header +
 * log location + projcache) plus every affected workspace path under it.
 * The script validates and backs up before mutating.
 * @param workspaceId - the workspace to rename.
 * @param newTitle - the new folder name / display title.
 * @returns the script's stdout.
 */
function runRenameWorkspace(workspaceId, newTitle) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [RENAME_SCRIPT, "--id", workspaceId, newTitle, "--apply"], {
			env: process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => { out += chunk.toString(); });
		child.stderr.on("data", (chunk) => { err += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error((err || out || `rename-workspace exited ${code}`).trim()));
		});
	});
}

/**
 * Permanently delete a workspace AND its directory on disk:
 *   1. delete the folder recursively (`rm -r`),
 *   2. remove the workspace and every sub-workspace whose path lives under it.
 *
 * Refuses roots, the home directory, folders that contain the DSH home, and
 * any workspace that still has live (open) sessions under it. Session logs
 * live under the DSH home (not inside the workspace folder), so they survive
 * and their sessions fall back to the Ungrouped bucket.
 *
 * @param ctx - host root context.
 * @param workspaceId - the workspace to delete.
 * @returns the number of workspace registrations removed.
 */
async function deleteWorkspace(ctx, workspaceId) {
	const workspace = ctx.workspaceRegistry.get(workspaceId);
	if (workspace === void 0) throw new Error(`unknown workspace "${workspaceId}"`);

	if (dirname(workspace.path) === workspace.path) {
		throw new Error(`refusing to delete the filesystem root "${workspace.path}"`);
	}
	if (normPath(workspace.path) === normPath(homedir())) {
		throw new Error("refusing to delete the home directory");
	}
	const dshHome = process.env.DSH_HOME;
	if (dshHome !== undefined && dshHome !== "" && isPathWithin(dshHome, workspace.path)) {
		throw new Error(`refusing to delete "${workspace.path}": it contains the DSH home directory`);
	}
	const live = liveSessionsUnder(ctx, workspace.path);
	if (live.length > 0) {
		throw new Error(`cannot delete workspace "${workspace.title}": ${live.length} open session(s) live under "${workspace.path}". Switch them to another workspace first.`);
	}

	await rm(workspace.path, { recursive: true, force: true });

	const descendants = ctx.workspaceRegistry.list().filter((w) => w.id !== workspaceId && isPathWithin(w.path, workspace.path));
	for (const descendant of descendants) await ctx.workspaceRegistry.delete(descendant.id);
	await ctx.workspaceRegistry.delete(workspaceId);

	return descendants.length + 1;
}

/**
 * Rename a workspace's directory on disk (and re-point every affected session
 * + sub-workspace) by delegating to `tools/rename-workspace.js`. Refuses while
 * any session under the folder is live; restart `dsh web` to finalize.
 *
 * @param ctx - host root context.
 * @param workspaceId - the workspace to rename.
 * @param newTitle - the new folder name / display title.
 * @returns the script's stdout.
 */
async function renameWorkspace(ctx, workspaceId, newTitle) {
	const workspace = ctx.workspaceRegistry.get(workspaceId);
	if (workspace === void 0) throw new Error(`unknown workspace "${workspaceId}"`);
	const live = liveSessionsUnder(ctx, workspace.path);
	if (live.length > 0) {
		throw new Error(`cannot rename workspace "${workspace.title}": ${live.length} open session(s) live under "${workspace.path}". Switch them to another workspace first.`);
	}
	return await runRenameWorkspace(workspaceId, newTitle);
}

function apply(ctx) {
	ctx.effect(() => ctx.commands.register({
		name: "delete-session",
		description: "Permanently delete a session and its log (cannot be undone)",
		recordInput: false,
		handler: async (invocation) => {
			const sessionId = String(invocation.rawInput ?? "").trim();
			if (sessionId === "") {
				return { kind: "error", text: "delete-session needs a session id." };
			}
			try {
				await deleteSession(ctx, sessionId);
				return { kind: "success", text: `Deleted session ${sessionId}.` };
			} catch (reason) {
				return {
					kind: "error",
					text: reason instanceof Error ? reason.message : String(reason),
				};
			}
		},
	}), "workspace-hierarchy: delete-session command");
	ctx.effect(() => ctx.commands.register({
		name: "move-session",
		description: "Move a session to another workspace directory (rewrites the session cwd)",
		recordInput: false,
		handler: async (invocation) => {
			const raw = String(invocation.rawInput ?? "").trim();
			const match = /^(\S+)\s+(.+)$/.exec(raw);
			if (match === null) {
				return { kind: "error", text: "move-session needs a session id and a target workspace path." };
			}
			const sessionId = match[1];
			const targetCwd = match[2].trim();
			try {
				const out = await runMoveSession(sessionId, targetCwd);
				return { kind: "success", text: out === "" ? `Moved session ${sessionId} to ${targetCwd}.` : out };
			} catch (reason) {
				return {
					kind: "error",
					text: reason instanceof Error ? reason.message : String(reason),
				};
			}
		},
	}), "workspace-hierarchy: move-session command");
	ctx.effect(() => ctx.commands.register({
		name: "delete-workspace",
		description: "Delete a workspace and its directory on disk (cannot be undone)",
		recordInput: false,
		handler: async (invocation) => {
			const workspaceId = String(invocation.rawInput ?? "").trim();
			if (workspaceId === "") {
				return { kind: "error", text: "delete-workspace needs a workspace id." };
			}
			try {
				const removed = await deleteWorkspace(ctx, workspaceId);
				return { kind: "success", text: `Deleted workspace ${workspaceId} and its folder (${removed} workspace registration(s) removed).` };
			} catch (reason) {
				return {
					kind: "error",
					text: reason instanceof Error ? reason.message : String(reason),
				};
			}
		},
	}), "workspace-hierarchy: delete-workspace command");
	ctx.effect(() => ctx.commands.register({
		name: "rename-workspace",
		description: "Rename a workspace's directory on disk and re-point its sessions",
		recordInput: false,
		handler: async (invocation) => {
			const raw = String(invocation.rawInput ?? "").trim();
			const match = /^(\S+)\s+(.+)$/.exec(raw);
			if (match === null) {
				return { kind: "error", text: "rename-workspace needs a workspace id and a new title." };
			}
			const workspaceId = match[1];
			const newTitle = match[2].trim();
			try {
				const out = await renameWorkspace(ctx, workspaceId, newTitle);
				return { kind: "success", text: out === "" ? `Renamed workspace ${workspaceId} to ${newTitle}.` : out };
			} catch (reason) {
				return {
					kind: "error",
					text: reason instanceof Error ? reason.message : String(reason),
				};
			}
		},
	}), "workspace-hierarchy: rename-workspace command");
}

export { apply, inject, name };
