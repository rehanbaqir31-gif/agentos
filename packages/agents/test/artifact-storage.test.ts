import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStorageError, FileSystemArtifactStorage } from "../src/artifact-storage.js";

describe("filesystem artifact object storage", () => {
  it("atomically stores verified content under an opaque locator and truncates at its limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-artifacts-"));
    try {
      const storage = await FileSystemArtifactStorage.open({ rootDirectory: root });
      const id = randomUUID();
      const stored = await storage.write(id, Buffer.from("0123456789"), 6);
      expect(stored).toMatchObject({
        locator: `${id.slice(0, 2)}/${id}.artifact`,
        byteSize: 6,
        sha256: createHash("sha256").update("012345").digest("hex"),
        truncated: true,
      });
      expect(stored.locator).not.toContain(root);
      expect(await storage.read(stored.locator)).toEqual(Buffer.from("012345"));
      await expect(storage.read("../../outside.txt")).rejects.toThrow("Invalid artifact locator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records failed promotions and removes their staged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-artifact-failure-"));
    try {
      const storage = await FileSystemArtifactStorage.open({
        rootDirectory: root,
        promote: async () => {
          throw new Error("promotion unavailable");
        },
      });
      await expect(storage.write(randomUUID(), Buffer.from("partial"), 20)).rejects.toMatchObject({
        name: "ArtifactStorageError",
        capturedByteSize: 7,
      } satisfies Partial<ArtifactStorageError>);
      expect(await storage.cleanupAbandonedStaging(new Date(Date.now() + 1_000))).toBe(0);
      expect(await readdir(join(root, "staging"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans abandoned staging files and unreferenced object orphans", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-artifact-cleanup-"));
    try {
      const storage = await FileSystemArtifactStorage.open({ rootDirectory: root });
      const staging = join(root, "staging");
      const abandoned = join(staging, `${randomUUID()}.${randomUUID()}.part`);
      await writeFile(abandoned, "partial", { mode: 0o600 });
      await utimes(abandoned, new Date(0), new Date(0));
      expect(await storage.cleanupAbandonedStaging(new Date())).toBe(1);

      const orphan = await storage.write(randomUUID(), Buffer.from("orphan"), 20);
      expect(await storage.cleanupOrphans([], new Date(Date.now() + 1_000))).toBe(1);
      await expect(storage.read(orphan.locator)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects symlinked object shards", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-artifact-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "agentos-artifact-outside-"));
    try {
      const storage = await FileSystemArtifactStorage.open({ rootDirectory: root });
      await rm(join(root, "objects", "aa"), { recursive: true, force: true });
      await symlink(outside, join(root, "objects", "aa"), "junction");
      await expect(
        storage.read(
          `aa/${"a".repeat(8)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(12)}.artifact`,
        ),
      ).rejects.toThrow();
      await writeFile(join(outside, "sentinel"), "untouched");
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("untouched");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
