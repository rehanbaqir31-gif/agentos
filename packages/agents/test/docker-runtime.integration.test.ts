import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adapterConfigSchema } from "../src/contracts.js";
import { DockerIsolatedRuntime } from "../src/docker-runtime.js";

const execFile = promisify(nodeExecFile);
const enabled = process.env.AGENTOS_DOCKER_INTEGRATION === "1";
const runId = randomUUID();
const image = process.env.AGENTOS_DOCKER_TEST_IMAGE ?? "";
const parent = join(tmpdir(), `agentos-docker-real-${process.pid}`);
const repository = join(parent, "repo");
const hostCanary = join(parent, "host-only-canary.txt");
const containerIds: string[] = [];
const runtime = enabled ? new DockerIsolatedRuntime({ image }) : undefined;

const docker = async (...args: string[]) =>
  (await execFile("docker", args, { windowsHide: true, timeout: 15_000 })).stdout.trim();

async function findContainer(run: string, generation: number): Promise<string> {
  const ids = await docker(
    "ps",
    "--all",
    "--quiet",
    "--filter=label=agentos.managed=true",
    `--filter=label=agentos.run-id=${run}`,
    `--filter=label=agentos.lease-generation=${generation}`,
  );
  const id = ids.split(/\s+/).find(Boolean);
  if (!id) throw new Error(`Expected a live AgentOS container for generation ${generation}`);
  containerIds.push(id);
  return id;
}

const suite = enabled ? describe : describe.skip;

suite("Docker runtime against a real daemon", () => {
  beforeAll(async () => {
    if (!image) throw new Error("AGENTOS_DOCKER_TEST_IMAGE must be set to a built image ID");
    console.info(`Docker daemon: ${await docker("version", "--format", "{{.Server.Version}}")}`);
    await mkdir(repository, { recursive: true });
    await writeFile(hostCanary, `host-only-${runId}`);
    const git = (...args: string[]) =>
      execFile("git", args, { cwd: repository, windowsHide: true });
    await git("init", "--quiet");
    await git("config", "user.name", "AgentOS Docker Test");
    await git("config", "user.email", "docker-test@example.invalid");
    await writeFile(join(repository, "README.md"), "daemon test\n");
    await git("add", "README.md");
    await git("commit", "--quiet", "-m", "base");
  });

  afterAll(async () => {
    for (const id of containerIds) await docker("rm", "--force", id).catch(() => {});
    const networks = await docker(
      "network",
      "ls",
      "--quiet",
      "--filter=label=agentos.managed=true",
      `--filter=label=agentos.run-id=${runId}`,
    ).catch(() => "");
    for (const network of networks.split(/\s+/).filter(Boolean))
      await docker("network", "rm", network).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  });

  it("starts with actual Docker isolation settings and rejects filesystem/network escape probes", async () => {
    const config = adapterConfigSchema.parse({
      projectDirectory: repository,
      permissionMode: "read_only",
    });
    const allocation = await runtime!.allocate(config, runId, 1);
    try {
      const id = await findContainer(runId, 1);
      const inspected = JSON.parse(await docker("inspect", id))[0] as {
        Config: {
          User: string;
          Image: string;
          Labels: Record<string, string>;
          Env: string[];
          Cmd: string[];
        };
        HostConfig: {
          Privileged: boolean;
          ReadonlyRootfs: boolean;
          NetworkMode: string;
          CapDrop: string[];
          SecurityOpt: string[];
          PidsLimit: number;
          Memory: number;
          NanoCpus: number;
          Tmpfs: Record<string, string>;
        };
        Args: string[];
        Mounts: Array<{ Destination: string; RW: boolean; Source: string }>;
      };
      expect(inspected.Config.Image).toBe(image);
      expect(inspected.Config.User).toBe("10001:10001");
      expect(inspected.Config.Labels["agentos.run-id"]).toBe(runId);
      expect(inspected.Config.Labels["agentos.lease-generation"]).toBe("1");
      expect(inspected.HostConfig.Privileged).toBe(false);
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.HostConfig.CapDrop).toContain("ALL");
      expect(inspected.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
      expect(inspected.HostConfig.PidsLimit).toBe(128);
      expect(inspected.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
      expect(inspected.HostConfig.NanoCpus).toBe(2_000_000_000);
      expect(inspected.HostConfig.Tmpfs["/tmp"]).toContain("size=256m");
      expect(inspected.Config.Env).toContain("HOME=/tmp");
      expect(
        inspected.Config.Env.some((item) => item.startsWith("OPENCODE_SERVER_PASSWORD=")),
      ).toBe(true);
      expect(inspected.Args.join(" ")).not.toMatch(/password|token|secret/i);
      expect(inspected.Mounts).toHaveLength(1);
      expect(inspected.Mounts[0]).toMatchObject({ Destination: "/workspace", RW: false });
      expect(inspected.Mounts[0]?.Source).toBe(allocation.workspacePath);
      expect(
        inspected.Mounts.some((mount) => /docker\.sock|docker_engine/i.test(mount.Source)),
      ).toBe(false);
      expect(inspected.HostConfig.NetworkMode).toBe(`agentos-${runId}-1`);

      const network = JSON.parse(
        await docker("network", "inspect", inspected.HostConfig.NetworkMode),
      )[0] as {
        Options: Record<string, string>;
      };
      expect(network.Options["com.docker.network.bridge.enable_ip_masquerade"]).toBe("false");
      expect(network.Options["com.docker.network.bridge.enable_icc"]).toBe("false");
      expect(allocation.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const healthResponse = await fetch(new URL("/global/health", allocation.serverUrl), {
        headers: { authorization: allocation.authorizationHeader },
        signal: AbortSignal.timeout(3_000),
      });
      expect(healthResponse.ok).toBe(true);
      await expect(
        docker("exec", id, "sh", "-c", "touch /workspace/forbidden /etc/forbidden"),
      ).rejects.toThrow();
      await expect(docker("exec", id, "cat", hostCanary)).rejects.toThrow();
      await expect(
        docker(
          "exec",
          id,
          "node",
          "-e",
          "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))",
        ),
      ).resolves.toBe("");
      await expect(
        docker("exec", id, "sh", "-c", "test -S /var/run/docker.sock"),
      ).rejects.toThrow();
      await allocation.cancel();
      const state = JSON.parse(await docker("inspect", id))[0] as { State: { Running: boolean } };
      expect(state.State.Running).toBe(false);
    } finally {
      await allocation.dispose();
    }
  });

  it("cleans only the exact stale generation and leaves the newer generation running", async () => {
    const config = adapterConfigSchema.parse({
      projectDirectory: repository,
      permissionMode: "read_only",
    });
    const old = await runtime!.allocate(config, runId, 2);
    let current: Awaited<ReturnType<NonNullable<typeof runtime>["allocate"]>> | undefined;
    try {
      current = await runtime!.allocate(config, runId, 3);
      const oldId = await findContainer(runId, 2);
      const currentId = await findContainer(runId, 3);
      await expect(
        docker("exec", currentId, "cat", join(old.workspacePath, "README.md")),
      ).rejects.toThrow();
      await runtime!.recover(runId, repository, old.workspacePath, 2);
      await expect(docker("inspect", oldId)).rejects.toThrow();
      const currentState = JSON.parse(await docker("inspect", currentId))[0] as {
        State: { Running: boolean };
      };
      expect(currentState.State.Running).toBe(true);
      await expect(docker("network", "inspect", `agentos-${runId}-2`)).rejects.toThrow();
      await expect(docker("network", "inspect", `agentos-${runId}-3`)).resolves.toBeTruthy();
    } finally {
      await old.dispose().catch(() => {});
      await current?.dispose().catch(() => {});
    }
  });
});
