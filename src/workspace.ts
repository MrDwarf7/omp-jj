import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type JjRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WorkspaceRequest {
	name: string;
	move: boolean;
}

export interface CreatedWorkspace {
	name: string;
	path: string;
	moved: boolean;
}

const NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export function defaultWorkspaceName(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `wt-${date}-${time}`;
}

export function parseArgs(args: string, now = new Date()): WorkspaceRequest {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const move = tokens.includes("--move");
	const rest = tokens.filter(token => token !== "--move");
	if (rest.length > 1) throw new Error(`Expected at most one workspace name, got: ${rest.join(" ")}`);
	return { name: rest[0] ?? defaultWorkspaceName(now), move };
}

async function run(jj: JjRunner, args: string[], cwd: string): Promise<string> {
	const result = await jj(args, cwd);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`jj ${args[0]} failed: ${detail}`);
	}
	return result.stdout.trim();
}

/**
 * The new workspace starts from `@-` rather than `@`: a child of the source `@` would be rebased,
 * and left stale, every time the source workspace snapshots. Changes are then copied with
 * `jj restore` (or moved with `jj squash`), run from inside the new workspace so its files are
 * updated in the same operation.
 */
export async function createWorkspace(
	jj: JjRunner,
	cwd: string,
	request: WorkspaceRequest,
	baseDir: string,
): Promise<CreatedWorkspace> {
	if (!NAME_PATTERN.test(request.name) || request.name === "." || request.name === "..") {
		throw new Error(`Invalid workspace name: ${request.name}`);
	}

	const sourceRoot = await run(jj, ["workspace", "root"], cwd);

	const dest = path.join(baseDir, path.basename(sourceRoot), request.name);
	if (existsSync(dest)) throw new Error(`${dest} already exists; pick another name.`);

	const source = await run(jj, ["log", "-r", "@", "--no-graph", "-T", "commit_id"], sourceRoot);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await run(jj, ["workspace", "add", "--name", request.name, "-r", "@-", dest], sourceRoot);

	try {
		if (request.move) {
			await run(jj, ["squash", "--from", source, "--into", "@"], dest);
			// Squashing rewrote the source workspace's `@` from outside it.
			await run(jj, ["workspace", "update-stale"], sourceRoot);
		} else {
			await run(jj, ["restore", "--from", source], dest);
		}
	} catch (err) {
		throw new Error(
			`Workspace exists at ${dest}, but setup did not finish. Inspect both workspaces before retrying: ${
				err instanceof Error ? err.message : String(err)
			}`,
			{ cause: err },
		);
	}

	return { name: request.name, path: await fs.realpath(dest), moved: request.move };
}
