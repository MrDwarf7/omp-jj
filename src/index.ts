import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { COMMAND, workspacesDir } from "./constants.ts";
import { createWorkspace, parseArgs } from "./workspace.ts";

export default function jjWorkspace(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND, {
		description: "Move this session into a new jj workspace, changes included (--move takes them)",
		handler: async (args, ctx) => {
			const notify = (message: string, type: "info" | "warning" | "error") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
				else console.error(message);
			};
			if (!ctx.isIdle()) {
				notify("Wait for the current response to finish before creating a workspace.", "warning");
				return;
			}
			try {
				const workspace = await createWorkspace(
					(jjArgs, cwd) => pi.exec("jj", jjArgs, { cwd, timeout: 60_000 }),
					ctx.cwd,
					parseArgs(args),
					workspacesDir(),
				);
				// Extensions can't relocate a session, so hand off to the built-in /move.
				const moveCommand = `/move ${workspace.path}`;
				const verb = workspace.moved ? "moved" : "copied";
				notify(`Created jj workspace ${workspace.name}, changes ${verb}. Run ${moveCommand} to switch.`, "info");
				if (ctx.mode === "tui") ctx.ui.setEditorText(moveCommand);
			} catch (err) {
				notify(`Workspace creation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
