import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, mkdtemp, rm, lstat, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const exec = promisify(execFile);
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export interface GitCommandRunner {
  run(cwd: string, args: string[], timeoutMs?: number): Promise<string>;
}
export const systemGitRunner: GitCommandRunner = {
  async run(cwd, args, timeoutMs = 30_000) {
    const result = await exec("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  },
};

export interface WorkspaceSnapshot {
  baseCommit: string;
  changedFiles: Array<{
    path: string;
    sha256: string | null;
    status: "added" | "modified" | "deleted";
  }>;
  diff: string;
}

export class GitExecutionWorkspace {
  private removed = false;
  constructor(
    readonly repositoryRoot: string,
    readonly baseCommit: string,
    readonly path: string,
    private readonly parentPath: string,
    private readonly git: GitCommandRunner,
  ) {}

  async collect(): Promise<WorkspaceSnapshot> {
    if (this.removed) throw new Error("Execution workspace has already been cleaned up");
    const trackedRaw = await this.git.run(this.path, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      this.baseCommit,
    ]);
    const untrackedRaw = await this.git.run(this.path, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const deletedRaw = await this.git.run(this.path, [
      "diff",
      "--name-only",
      "--diff-filter=D",
      "-z",
      this.baseCommit,
    ]);
    const deleted = new Set(deletedRaw.split("\0").filter(Boolean));
    const tracked = new Set(trackedRaw.split("\0").filter(Boolean));
    const untracked = [...new Set(untrackedRaw.split("\0").filter(Boolean))];
    if (untracked.length) await this.git.run(this.path, ["add", "-N", "--", ...untracked]);
    const changed = new Set([...tracked, ...untracked]);
    const changedFiles: WorkspaceSnapshot["changedFiles"] = [];
    for (const file of [...changed].sort()) {
      if (isAbsolute(file) || file.split(/[\\/]/).includes(".."))
        throw new Error("Git reported an unsafe changed path");
      if (deleted.has(file)) {
        changedFiles.push({ path: file, sha256: null, status: "deleted" });
        continue;
      }
      const absolute = resolve(this.path, file);
      const info = await lstat(absolute);
      const target = await realpath(absolute);
      const rel = relative(this.path, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("Changed file escapes the execution worktree");
      if (info.isDirectory()) continue;
      const content = info.isSymbolicLink()
        ? Buffer.from(await readlink(absolute))
        : await readFile(target);
      changedFiles.push({
        path: file,
        sha256: createHash("sha256").update(content).digest("hex"),
        status: tracked.has(file) ? "modified" : "added",
      });
    }
    const diff = await this.git.run(this.path, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-renames",
      this.baseCommit,
    ]);
    return { baseCommit: this.baseCommit, changedFiles, diff };
  }

  async cleanup(): Promise<void> {
    if (this.removed) return;
    const root = await realpath(this.repositoryRoot);
    const parent = await realpath(this.parentPath);
    const worktree = await realpath(this.path);
    const rel = relative(parent, worktree);
    if (root === worktree || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Refusing unsafe worktree cleanup");
    await this.git.run(root, ["worktree", "remove", "--force", this.path]);
    await rm(parent, { recursive: true, force: false });
    this.removed = true;
  }
}

export class GitWorkspaceManager {
  constructor(private readonly git: GitCommandRunner = systemGitRunner) {}
  async create(
    repositoryPath: string,
    requestedBaseCommit?: string,
  ): Promise<GitExecutionWorkspace> {
    const repositoryRoot = await realpath(repositoryPath);
    const rootFromGit = (
      await this.git.run(repositoryRoot, ["rev-parse", "--show-toplevel"])
    ).trim();
    if ((await realpath(rootFromGit)) !== repositoryRoot)
      throw new Error("Project path must be the Git repository root");
    const candidate =
      requestedBaseCommit ?? (await this.git.run(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    if (!shaPattern.test(candidate)) throw new Error("Base commit must be a full Git commit SHA");
    const baseCommit = (
      await this.git.run(repositoryRoot, ["rev-parse", "--verify", `${candidate}^{commit}`])
    ).trim();
    if (!shaPattern.test(baseCommit))
      throw new Error("Git did not resolve the requested base commit");
    const parentPath = await mkdtemp(join(tmpdir(), `agentos-${randomUUID()}-`));
    const path = join(parentPath, `run-${basename(parentPath).slice(8)}`);
    try {
      await this.git.run(repositoryRoot, ["worktree", "add", "--detach", path, baseCommit]);
      return new GitExecutionWorkspace(repositoryRoot, baseCommit, path, parentPath, this.git);
    } catch (error) {
      await rm(parentPath, { recursive: true, force: true });
      throw error;
    }
  }
}
