import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  AdapterConfig,
  AgentResult,
  IsolatedRuntime,
  RuntimeAllocation,
} from "./contracts.js";
import { GitWorkspaceManager, type GitCommandRunner } from "./git-workspace.js";

const digestImage = z.string().regex(/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i);
export interface DockerCommandRunner {
  run(
    args: string[],
    options?: { timeoutMs?: number; environment?: Record<string, string> },
  ): Promise<string>;
}
const exec = promisify(execFile);
export const systemDockerRunner: DockerCommandRunner = {
  async run(args, options = {}) {
    const environment = { ...process.env, ...options.environment };
    const result = await exec("docker", args, {
      env: environment,
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  },
};

export interface DockerRuntimeOptions {
  image: string;
  commandRunner?: DockerCommandRunner;
  gitRunner?: GitCommandRunner;
  readinessTimeoutMs?: number;
  healthProbe?: (url: string, authorization: string) => Promise<boolean>;
}

export class DockerIsolatedRuntime implements IsolatedRuntime {
  private readonly image: string;
  private readonly docker: DockerCommandRunner;
  private readonly readinessTimeoutMs: number;
  private readonly healthProbe: (url: string, authorization: string) => Promise<boolean>;
  private readonly workspaces: GitWorkspaceManager;

  constructor(options: DockerRuntimeOptions) {
    this.image = digestImage.parse(options.image);
    this.docker = options.commandRunner ?? systemDockerRunner;
    this.workspaces = new GitWorkspaceManager(options.gitRunner);
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    this.healthProbe = options.healthProbe ?? defaultHealthProbe;
  }

  async allocate(config: AdapterConfig, runId: string): Promise<RuntimeAllocation> {
    if (config.permissionMode !== "read_only") {
      throw new Error(
        "Docker runtime currently permits only read_only runs until AgentOS approvals are enforced",
      );
    }
    if (!z.string().uuid().safeParse(runId).success) throw new Error("Run ID must be a UUID");
    const workspace = await this.workspaces.create(config.projectDirectory);
    const id = `agentos-${randomUUID()}`;
    const password = randomBytes(32).toString("base64url");
    const authorizationHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const mountPath = workspace.path.replaceAll("\\", "/");
    if (mountPath.includes(",")) {
      await workspace.cleanup();
      throw new Error("Docker bind mount paths cannot contain commas");
    }
    const args = [
      "run",
      "--detach",
      "--init",
      `--name=${id}`,
      "--label=agentos.managed=true",
      `--label=agentos.run-id=${runId}`,
      "--network=none",
      "--read-only",
      "--user=10001:10001",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m",
      `--mount=type=bind,source=${mountPath},target=/workspace,readonly`,
      "--workdir=/workspace",
      "--publish=127.0.0.1::4096",
      "--env=HOME=/tmp",
      "--env=OPENCODE_SERVER_PASSWORD",
      this.image,
      "opencode",
      "serve",
      "--hostname",
      "0.0.0.0",
      "--port",
      "4096",
    ];
    try {
      await this.docker.run(args, {
        timeoutMs: 45_000,
        environment: { OPENCODE_SERVER_PASSWORD: password },
      });
      const published = await this.docker.run(["port", id, "4096/tcp"]);
      const match = published.match(/^127\.0\.0\.1:(\d+)$/m);
      if (!match?.[1]) throw new Error("Docker did not publish the OpenCode API on loopback");
      const serverUrl = `http://127.0.0.1:${match[1]}`;
      const deadline = Date.now() + this.readinessTimeoutMs;
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          if (await this.healthProbe(serverUrl, authorizationHeader)) {
            healthy = true;
            break;
          }
        } catch {
          // Server startup is expected to fail health checks briefly.
        }
        await delay(250);
      }
      if (!healthy) throw new Error("OpenCode sandbox did not become healthy before timeout");
      let disposed = false;
      let stopped = false;
      return {
        workspacePath: workspace.path,
        serverUrl,
        authorizationHeader,
        cancel: async () => {
          if (!disposed && !stopped) {
            await this.docker.run(["kill", id], { timeoutMs: 10_000 });
            stopped = true;
          }
        },
        collectResults: async (): Promise<AgentResult> => {
          const result = await workspace.collect();
          return {
            status: "succeeded",
            summary: `${result.changedFiles.length} changed files`,
            changedFiles: result.changedFiles.map((item) => item.path),
            diff: result.diff,
          };
        },
        dispose: async () => {
          if (disposed) return;
          await this.docker.run(["rm", "--force", id], { timeoutMs: 10_000 });
          stopped = true;
          await workspace.cleanup();
          disposed = true;
        },
      };
    } catch (error) {
      try {
        await this.docker.run(["rm", "--force", id], { timeoutMs: 10_000 });
      } catch (cleanupError) {
        if (isMissingContainer(cleanupError)) {
          await workspace.cleanup();
          throw error;
        }
        throw new AggregateError(
          [error, cleanupError],
          `Docker setup failed; workspace retained at ${workspace.path} because container termination could not be verified`,
        );
      }
      await workspace.cleanup();
      throw error;
    }
  }
}

function isMissingContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such container|no such object/i.test(message);
}

async function defaultHealthProbe(url: string, authorization: string): Promise<boolean> {
  const response = await fetch(new URL("/global/health", url), {
    headers: { authorization },
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "healthy" in body && body.healthy === true;
}
