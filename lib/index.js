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
import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";

const name = "ui-workspace-hierarchy";
const inject = ["commands", "workspaceRegistry"];

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
}

export { apply, inject, name };
