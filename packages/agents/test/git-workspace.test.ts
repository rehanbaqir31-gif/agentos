import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitExecutionWorkspace, GitWorkspaceManager } from "../src/git-workspace.js";

const execFile = promisify(nodeExecFile);

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "agentos-git-test-"));
  const repo = join(parent, "repo");
  await mkdir(repo);
  const git = async (...args: string[]) => execFile("git", args, { cwd: repo, windowsHide: true });
  await git("init", "--quiet");
  await git("config", "user.name", "AgentOS Test");
  await git("config", "user.email", "agentos-test@example.invalid");
  await writeFile(join(repo, "readme.txt"), "committed\n");
  await git("add", "readme.txt");
  await git("commit", "--quiet", "-m", "base");
  const { stdout } = await git("rev-parse", "HEAD");
  return { parent, repo, baseCommit: stdout.trim() };
}

describe("Git execution workspaces", () => {
  it("isolates source edits, records added and modified paths, and cleans up", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.repo, "readme.txt"), "developer's uncommitted edit\n");
      const workspace = await new GitWorkspaceManager().create(f.repo, f.baseCommit);
      try {
        expect(await readFile(join(f.repo, "readme.txt"), "utf8")).toBe(
          "developer's uncommitted edit\n",
        );
        await writeFile(join(workspace.path, "readme.txt"), "agent modification\n");
        await writeFile(join(workspace.path, "new.txt"), "new result\n");
        const result = await workspace.collect();
        expect(result.baseCommit).toBe(f.baseCommit);
        expect(result.changedFiles.map((item) => [item.path, item.status])).toEqual([
          ["new.txt", "added"],
          ["readme.txt", "modified"],
        ]);
        expect(result.changedFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(result.diff).toContain("new result");
        expect(result.diff).toContain("agent modification");
      } finally {
        await workspace.cleanup();
      }
      expect(await readFile(join(f.repo, "readme.txt"), "utf8")).toBe(
        "developer's uncommitted edit\n",
      );
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });

  it("rejects a changed symlink whose target escapes the worktree", async (context) => {
    const f = await fixture();
    const outside = join(f.parent, "outside.txt");
    try {
      const workspace = await new GitWorkspaceManager().create(f.repo, f.baseCommit);
      try {
        await writeFile(outside, "outside");
        try {
          await symlink(outside, join(workspace.path, "escape.txt"));
        } catch (error) {
          if (process.platform === "win32")
            context.skip(`Windows symlinks unavailable: ${String(error)}`);
          throw error;
        }
        await expect(workspace.collect()).rejects.toThrow(/escapes the execution worktree/);
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });

  it("rejects short or invalid base commit references", async () => {
    const f = await fixture();
    try {
      await expect(new GitWorkspaceManager().create(f.repo, "HEAD")).rejects.toThrow(
        /full Git commit SHA/,
      );
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });

  it("rejects traversal paths returned from Git before reading files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentos-git-path-test-"));
    const repository = join(parent, "repo");
    const workspacePath = join(parent, "worktree");
    await mkdir(repository);
    await mkdir(workspacePath);
    const runner = {
      run: async (_cwd: string, args: string[]) => (args[0] === "diff" ? "../outside.txt\0" : ""),
    };
    const workspace = new GitExecutionWorkspace(
      repository,
      "a".repeat(40),
      workspacePath,
      parent,
      runner,
    );
    try {
      await expect(workspace.collect()).rejects.toThrow(/unsafe changed path/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
