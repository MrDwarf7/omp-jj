import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkspace, type JjRunner, parseArgs } from "../src/workspace.ts";

let tmp: string;
let repo: string;
let base: string;

// Isolated from the developer's jj config so signing, editors, or default revsets can't leak in.
const env = { ...process.env, JJ_CONFIG: "", JJ_USER: "Test", JJ_EMAIL: "test@example.com", JJ_EDITOR: "false" };

const jj: JjRunner = async (args, cwd) => {
	const proc = Bun.spawn(["jj", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
};

async function jjOk(args: string[], cwd: string): Promise<string> {
	const result = await jj(args, cwd);
	if (result.code !== 0) throw new Error(`jj ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

describe.skipIf(!Bun.which("jj"))("createWorkspace", () => {
	beforeEach(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-")));
		repo = path.join(tmp, "repo");
		base = path.join(tmp, "workspaces");
		await jjOk(["git", "init", "--colocate", repo], tmp);
		await Bun.write(path.join(repo, "a.txt"), "a\n");
		await jjOk(["commit", "-m", "base"], repo);
		await Bun.write(path.join(repo, "a.txt"), "a\nchanged\n");
		await Bun.write(path.join(repo, "b.txt"), "new\n");
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	test("copies @ changes into a sibling of @ and leaves the source untouched", async () => {
		const ws = await createWorkspace(jj, repo, { name: "feat", move: false }, base);

		expect(ws.path).toBe(path.join(base, "repo", "feat"));
		expect(await Bun.file(path.join(ws.path, "a.txt")).text()).toBe("a\nchanged\n");
		expect(await Bun.file(path.join(ws.path, "b.txt")).text()).toBe("new\n");
		expect(await jjOk(["diff", "--name-only"], repo)).toBe("a.txt\nb.txt");
		const parentArgs = ["log", "-r", "@-", "--no-graph", "-T", "commit_id"];
		expect(await jjOk(parentArgs, ws.path)).toBe(await jjOk(parentArgs, repo));
	});

	test("source snapshots afterwards don't make the new workspace stale", async () => {
		const ws = await createWorkspace(jj, repo, { name: "feat", move: false }, base);
		await Bun.write(path.join(repo, "c.txt"), "later\n");
		await jjOk(["status"], repo);

		expect(await jjOk(["diff", "--name-only"], ws.path)).toBe("a.txt\nb.txt");
	});

	test("--move empties the source @ and keeps the source workspace usable", async () => {
		const ws = await createWorkspace(jj, repo, { name: "feat", move: true }, base);

		expect(await Bun.file(path.join(ws.path, "b.txt")).text()).toBe("new\n");
		expect(await Bun.file(path.join(repo, "b.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("a\n");
		expect(await jjOk(["diff", "--name-only"], repo)).toBe("");
	});

	test.each([false, true])("transfers a divergent source with move=%s", async move => {
		await jjOk(["status"], repo);
		const operation = await jjOk(["op", "log", "--limit", "1", "--no-graph", "-T", "id"], repo);
		await jjOk(["describe", "-m", "left"], repo);
		await jjOk(["--at-op", operation, "describe", "-m", "right"], repo);
		await jjOk(["status"], repo);

		const ws = await createWorkspace(jj, repo, { name: "feat", move }, base);
		expect(await Bun.file(path.join(ws.path, "a.txt")).text()).toBe("a\nchanged\n");
		expect(await Bun.file(path.join(ws.path, "b.txt")).text()).toBe("new\n");
		expect(await jjOk(["diff", "--name-only"], repo)).toBe(move ? "" : "a.txt\nb.txt");
	});

	test("creates no bookmark in a colocated repo", async () => {
		await createWorkspace(jj, repo, { name: "feat", move: false }, base);
		expect(await jjOk(["bookmark", "list"], repo)).toBe("");
	});

	test("preserves moved files and reports the destination if source refresh fails", async () => {
		const failRefresh: JjRunner = (args, cwd) =>
			args[0] === "workspace" && args[1] === "update-stale"
				? Promise.resolve({ code: 1, stdout: "", stderr: "refresh unavailable" })
				: jj(args, cwd);
		const dest = path.join(base, "repo", "feat");

		await expect(createWorkspace(failRefresh, repo, { name: "feat", move: true }, base)).rejects.toThrow(dest);
		expect(await Bun.file(path.join(dest, "a.txt")).text()).toBe("a\nchanged\n");
		expect(await Bun.file(path.join(dest, "b.txt")).text()).toBe("new\n");
		await jjOk(["workspace", "update-stale"], repo);
		expect(await jjOk(["diff", "--name-only"], repo)).toBe("");
	});

	test("refuses outside a jj repo and when the target already exists", async () => {
		await expect(createWorkspace(jj, tmp, { name: "feat", move: false }, base)).rejects.toThrow();
		expect(await Bun.file(path.join(base, "repo", "feat", "b.txt")).exists()).toBe(false);
		await createWorkspace(jj, repo, { name: "feat", move: false }, base);
		await expect(createWorkspace(jj, repo, { name: "feat", move: false }, base)).rejects.toThrow();
		expect(await Bun.file(path.join(base, "repo", "feat", "b.txt")).text()).toBe("new\n");
	});

	test.each(["../evil", ".", ".."])("rejects unsafe workspace name %s", async name => {
		await expect(createWorkspace(jj, repo, { name, move: false }, base)).rejects.toThrow();
		expect(await fs.readdir(tmp)).toEqual(["repo"]);
	});
});

describe("parseArgs", () => {
	test("takes an optional name and --move in any order", () => {
		expect(parseArgs("--move feat")).toEqual({ name: "feat", move: true });
		expect(parseArgs("feat")).toEqual({ name: "feat", move: false });
	});

	test("rejects more than one name", () => {
		expect(() => parseArgs("a b")).toThrow();
	});
});
