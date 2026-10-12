import * as os from "node:os";
import * as path from "node:path";

export const COMMAND = "jwt";

/**
 * Kept outside omp's `~/.omp/wt`: `omp worktree clear` deletes anything there it can't
 * classify as a git worktree or task sandbox, which would include jj workspaces.
 */
export function workspacesDir(): string {
	const override = process.env.OMP_JJ_WT_DIR;
	return override ? path.resolve(override) : path.join(os.homedir(), ".omp", "jj-wt");
}
