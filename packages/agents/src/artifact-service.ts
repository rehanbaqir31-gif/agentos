import { createHash, randomUUID } from "node:crypto";
import {
  createRunArtifactSchema,
  redactEventSecrets,
  runArtifactSchema,
  type CreateRunArtifact,
  type RunArtifact,
  type RunManifest,
  type RepositorySet,
} from "@agentos/core";
import { ArtifactStorageError, type ArtifactObjectStorage } from "./artifact-storage.js";
import type { AgentResult } from "./contracts.js";

export interface ArtifactServiceOptions {
  maxArtifactBytes?: number;
  maxRunBytes?: number;
  retentionDays?: number;
  orphanGraceMs?: number;
  now?: () => string;
}

export interface ArtifactCaptureResult {
  artifacts: RunArtifact[];
  failures: string[];
}

interface ArtifactPlan {
  id: string;
  type: CreateRunArtifact["type"];
  logicalName: string;
  contentType: string;
  content: Buffer | null;
  unavailableReason: string | null;
  failureReason: string | null;
}

const sensitiveKey =
  /(?:api[_-]?key|private[_-]?key|password|secret|token|credential|authorization|^env$|^environment$)/i;
const defaultArtifactBytes = 5 * 1024 * 1024;
const defaultRunBytes = 25 * 1024 * 1024;

/** Coordinates immutable object writes with scoped, durable metadata. */
export class ArtifactService {
  private readonly maxArtifactBytes: number;
  private readonly maxRunBytes: number;
  private readonly retentionDays: number;
  private readonly orphanGraceMs: number;
  private readonly now: () => string;
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly repositories: RepositorySet,
    private readonly storage: ArtifactObjectStorage,
    options: ArtifactServiceOptions = {},
  ) {
    this.maxArtifactBytes = options.maxArtifactBytes ?? defaultArtifactBytes;
    this.maxRunBytes = options.maxRunBytes ?? defaultRunBytes;
    this.retentionDays = options.retentionDays ?? 30;
    this.orphanGraceMs = options.orphanGraceMs ?? 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date().toISOString());
    for (const [name, value] of [
      ["maxArtifactBytes", this.maxArtifactBytes],
      ["maxRunBytes", this.maxRunBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(this.retentionDays) || this.retentionDays < 1)
      throw new RangeError("retentionDays must be a positive integer");
  }

  async capture(
    runId: string,
    projectId: string,
    manifest: RunManifest,
    result: AgentResult,
  ): Promise<ArtifactCaptureResult> {
    return this.withRunLock(runId, async () => {
      const existingPage = await this.repositories.artifacts.listForProject(runId, projectId, {
        limit: 200,
        offset: 0,
      });
      const existingByName = new Map(
        existingPage.items.map((artifact) => [
          `${artifact.type}:${artifact.logicalName}`,
          artifact,
        ]),
      );
      const plans = this.makePlans(runId, projectId, manifest, result, existingByName);
      const artifacts: RunArtifact[] = [];
      const failures: string[] = [];
      let usedBytes = await this.repositories.artifacts.totalBytes(runId, projectId);

      for (const plan of plans) {
        const existing = existingByName.get(`${plan.type}:${plan.logicalName}`);
        if (existing) {
          artifacts.push(existing);
          if (existing.collectionStatus === "failed")
            failures.push(`${existing.type}: ${existing.collectionError ?? "collection failed"}`);
          continue;
        }
        if (plan.content === null) {
          const failed = plan.failureReason !== null;
          const artifact = await this.repositories.artifacts.create(
            this.metadataInput(runId, projectId, plan, {
              byteSize: 0,
              sha256: null,
              storageLocator: null,
              collectionStatus: failed ? "failed" : "unavailable",
              collectionError:
                plan.failureReason ??
                plan.unavailableReason ??
                "Adapter did not provide this artifact",
            }),
            plan.id,
          );
          artifacts.push(artifact);
          if (failed) failures.push(`${plan.type}: ${plan.failureReason}`);
          continue;
        }

        const remaining = Math.max(0, this.maxRunBytes - usedBytes);
        const allowedBytes = Math.min(this.maxArtifactBytes, remaining);
        try {
          const stored = await this.storage.write(plan.id, plan.content, allowedBytes);
          let artifact: RunArtifact;
          try {
            artifact = await this.repositories.artifacts.create(
              this.metadataInput(runId, projectId, plan, {
                byteSize: stored.byteSize,
                sha256: stored.sha256,
                storageLocator: stored.locator,
                collectionStatus: stored.truncated ? "truncated" : "complete",
                collectionError: null,
              }),
              plan.id,
            );
          } catch (error) {
            await this.storage.remove(stored.locator).catch(() => undefined);
            throw error;
          }
          artifacts.push(artifact);
          usedBytes += artifact.byteSize;
        } catch (error) {
          if (error instanceof ArtifactStorageError) {
            const failed = await this.repositories.artifacts.create(
              this.metadataInput(runId, projectId, plan, {
                byteSize: error.capturedByteSize,
                sha256: error.capturedSha256,
                storageLocator: null,
                collectionStatus: "failed",
                collectionError: safeError(error.message),
              }),
              plan.id,
            );
            artifacts.push(failed);
            failures.push(`${plan.type}: ${safeError(error.message)}`);
            continue;
          }
          throw error;
        }
      }

      return { artifacts, failures };
    });
  }

  async readForProject(runId: string, projectId: string, artifactId: string): Promise<Buffer> {
    const artifact = runArtifactSchema.parse(
      await this.repositories.artifacts.getForProject(runId, projectId, artifactId),
    );
    if (
      (artifact.collectionStatus !== "complete" && artifact.collectionStatus !== "truncated") ||
      artifact.storageLocator === null ||
      artifact.sha256 === null
    )
      throw new Error("Artifact content is unavailable");
    let content: Buffer;
    try {
      content = await this.storage.read(artifact.storageLocator);
    } catch {
      throw new Error("Artifact object is missing or inaccessible");
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== artifact.byteSize || digest !== artifact.sha256)
      throw new Error("Artifact integrity verification failed");
    return content;
  }

  async cleanup(
    now = new Date(this.now()),
  ): Promise<{ expired: number; staging: number; orphans: number }> {
    const cutoff = new Date(now.valueOf() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    let expired = 0;
    while (true) {
      const page = await this.repositories.artifacts.listExpired(cutoff, { limit: 200, offset: 0 });
      if (page.items.length === 0) break;
      for (const item of page.items) {
        const removed = await this.repositories.artifacts.delete(item.id);
        if (!removed) continue;
        if (removed.storageLocator) await this.storage.remove(removed.storageLocator);
        expired += 1;
      }
    }
    const referenced = await this.repositories.artifacts.listStorageLocators();
    const olderThan = new Date(now.valueOf() - this.orphanGraceMs);
    const [staging, orphans] = await Promise.all([
      this.storage.cleanupAbandonedStaging(olderThan),
      this.storage.cleanupOrphans(referenced, olderThan),
    ]);
    return { expired, staging, orphans };
  }

  private makePlans(
    runId: string,
    projectId: string,
    manifest: RunManifest,
    result: AgentResult,
    existing: Map<string, RunArtifact>,
  ): ArtifactPlan[] {
    const make = (
      type: ArtifactPlan["type"],
      logicalName: string,
      contentType: string,
      content: Buffer | null,
      unavailableReason: string | null = null,
      failureReason: string | null = null,
    ): ArtifactPlan => ({
      id:
        existing.get(`${type}:${logicalName}`)?.id ??
        // UUID randomness prevents the storage key from revealing run/project identifiers.
        randomUUID(),
      type,
      logicalName,
      contentType,
      content,
      unavailableReason,
      failureReason,
    });
    const jsonPlan = (type: ArtifactPlan["type"], name: string, value: unknown): ArtifactPlan => {
      try {
        return make(type, name, "application/json", safeJsonBuffer(value));
      } catch {
        return make(
          type,
          name,
          "application/json",
          null,
          null,
          "Artifact content failed safe serialization and was withheld",
        );
      }
    };
    const textPlan = (
      type: ArtifactPlan["type"],
      name: string,
      value: string | null | undefined,
      unavailable: string,
    ) =>
      make(
        type,
        name,
        "text/plain; charset=utf-8",
        value == null ? null : Buffer.from(redactEventSecrets(value)),
        unavailable,
      );
    const plans: ArtifactPlan[] = [
      textPlan(
        "git_diff",
        "patch.diff",
        result.diff,
        "Git diff was not available from the runtime",
      ),
      textPlan("stdout", "stdout.txt", result.stdout, "Adapter did not expose process stdout"),
      textPlan("stderr", "stderr.txt", result.stderr, "Adapter did not expose process stderr"),
      result.testResults === undefined || result.testResults === null
        ? make(
            "test_results",
            "test-results.json",
            "application/json",
            null,
            "Adapter did not provide structured test results",
          )
        : jsonPlan("test_results", "test-results.json", result.testResults),
      jsonPlan("execution_manifest", "manifest.json", manifest),
    ];
    const knownArtifacts = plans.map((plan) => ({
      id: plan.id,
      type: plan.type,
      logicalName: plan.logicalName,
    }));
    const resultMetadata = {
      runId,
      projectId,
      status: result.status,
      summary: result.summary,
      changedFiles: result.changedFiles,
      fileHashes: result.fileHashes,
      exitCode: result.exitCode ?? null,
      terminationReason: result.terminationReason ?? null,
      collectionErrors: (result.collectionErrors ?? []).map(safeError),
      artifacts: knownArtifacts,
    };
    plans.push(jsonPlan("result_metadata", "result.json", resultMetadata));
    return plans;
  }

  private metadataInput(
    runId: string,
    projectId: string,
    plan: ArtifactPlan,
    values: Pick<
      CreateRunArtifact,
      "byteSize" | "sha256" | "storageLocator" | "collectionStatus" | "collectionError"
    >,
  ): CreateRunArtifact {
    return createRunArtifactSchema.parse({
      runId,
      projectId,
      type: plan.type,
      logicalName: plan.logicalName,
      contentType: plan.contentType,
      ...values,
    });
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.runLocks.set(runId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.runLocks.get(runId) === queued) this.runLocks.delete(runId);
    }
  }
}

function safeJsonBuffer(value: unknown): Buffer {
  const sanitized = sanitizeJson(value);
  const text = redactEventSecrets(JSON.stringify(sanitized));
  return Buffer.from(text);
}

function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return redactEventSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey.test(key))
        throw new Error(`Sensitive field ${key} cannot be stored in an artifact`);
      result[key] = sanitizeJson(item);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    return null;
  return value;
}

function safeError(message: string): string {
  return redactEventSecrets(message)
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, "[PATH]")
    .replace(/(?:^|\s)\/(?:Users|home|tmp|var|etc|opt|mnt|workspace|agentos)\/[^\s"']*/g, " [PATH]")
    .slice(0, 4_000);
}
