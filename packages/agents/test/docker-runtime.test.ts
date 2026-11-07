import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { adapterConfigSchema } from "../src/contracts.js";
import { DockerIsolatedRuntime, type DockerCommandRunner } from "../src/docker-runtime.js";

const execFile = promisify(nodeExecFile);
const image = `ghcr.io/example/opencode@sha256:${"a".repeat(64)}`;

async function gitRepo() {
  const parent = await mkdtemp(join(tmpdir(), "agentos-docker-test-"));
  const repository = join(parent, "repo");
  await mkdir(repository);
  const git = async (...args: string[]) =>
    execFile("git", args, { cwd: repository, windowsHide: true });
  await git("init", "--quiet");
  await git("config", "user.name", "AgentOS Test");
  await git("config", "user.email", "agentos-test@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n");
  await git("add", "README.md");
  await git("commit", "--quiet", "-m", "base");
  return { parent, repository };
}

describe("Docker isolated runtime", () => {
  it("uses a digest-pinned image, loopback API, resource bounds, and one read-only worktree mount", async () => {
    const f = await gitRepo();
    const calls: Array<{ args: string[]; environment?: Record<string, string> }> = [];
    const docker: DockerCommandRunner = {
      run: vi.fn(async (args, options) => {
        calls.push({ args, environment: options?.environment });
        if (args[0] === "port") return "127.0.0.1:49152";
        return args[0] === "run" ? "container-id" : "";
      }),
    };
    try {
      const runtime = new DockerIsolatedRuntime({
        image,
        commandRunner: docker,
        healthProbe: async () => true,
      });
      const config = adapterConfigSchema.parse({
        projectDirectory: f.repository,
        permissionMode: "read_only",
      });
      const allocation = await runtime.allocate(config, "018f86a6-19fd-7ac2-bd82-fd9637e1fb72");
      const args = calls[0]?.args ?? [];
      expect(args).toContain("--network=none");
      expect(args).toContain("--read-only");
      expect(args).toContain("--user=10001:10001");
      expect(args).toContain("--cap-drop=ALL");
      expect(args).toContain("--pids-limit=128");
      expect(args).toContain("--memory=2g");
      expect(args).toContain("--cpus=2");
      expect(args).toContain("--publish=127.0.0.1::4096");
      expect(args.filter((arg) => arg.startsWith("--mount="))).toHaveLength(1);
      expect(args.some((arg) => /docker\.sock|docker_engine/i.test(arg))).toBe(false);
      expect(args[args.indexOf(image)]).toBe(image);
      expect(calls[0]?.environment && Object.keys(calls[0].environment)).toEqual([
        "OPENCODE_SERVER_PASSWORD",
      ]);
      expect(allocation.serverUrl).toBe("http://127.0.0.1:49152");
      expect(allocation.authorizationHeader).toMatch(/^Basic /);
      const password = calls[0]?.environment?.["OPENCODE_SERVER_PASSWORD"];
      expect(password).toBeTruthy();
      expect(
        Buffer.from(allocation.authorizationHeader.slice("Basic ".length), "base64").toString(),
      ).toBe(`opencode:${password}`);
      expect(args.join(" ")).not.toContain(password);
      await allocation.cancel();
      await allocation.dispose();
      expect(calls.some(({ args: called }) => called[0] === "kill")).toBe(true);
      expect(
        calls.some(({ args: called }) => called[0] === "rm" && called.includes("--force")),
      ).toBe(true);
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });

  it("rejects autonomous/supervised modes until AgentOS approval enforcement exists", async () => {
    const docker = { run: vi.fn(async () => "") };
    const runtime = new DockerIsolatedRuntime({
      image,
      commandRunner: docker,
      healthProbe: async () => true,
    });
    await expect(
      runtime.allocate(
        adapterConfigSchema.parse({ projectDirectory: ".", permissionMode: "supervised" }),
        "018f86a6-19fd-7ac2-bd82-fd9637e1fb72",
      ),
    ).rejects.toThrow(/only read_only/);
    expect(docker.run).not.toHaveBeenCalled();
  });

  it("requires a sha256-pinned image", () => {
    expect(() => new DockerIsolatedRuntime({ image: "latest" })).toThrow();
  });

  it("retains the worktree if Docker cannot confirm container termination", async () => {
    const f = await gitRepo();
    let mountPath = "";
    const docker: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        if (args[0] === "run") {
          mountPath =
            args
              .find((item) => item.startsWith("--mount="))
              ?.split("source=")[1]
              ?.split(",target=")[0] ?? "";
          return "container-id";
        }
        if (args[0] === "port") return "127.0.0.1:49152";
        if (args[0] === "rm") throw new Error("Docker daemon unavailable");
        return "";
      }),
    };
    try {
      const runtime = new DockerIsolatedRuntime({
        image,
        commandRunner: docker,
        healthProbe: async () => false,
        readinessTimeoutMs: 1,
      });
      const config = adapterConfigSchema.parse({
        projectDirectory: f.repository,
        permissionMode: "read_only",
      });
      await expect(
        runtime.allocate(config, "018f86a6-19fd-7ac2-bd82-fd9637e1fb72"),
      ).rejects.toThrow(/workspace retained/);
      expect(mountPath).not.toBe("");
      await expect(access(mountPath)).resolves.toBeUndefined();
    } finally {
      await rm(f.parent, { recursive: true, force: true });
    }
  });
});
