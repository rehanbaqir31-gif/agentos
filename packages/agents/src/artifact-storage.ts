import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { artifactIdSchema } from "@agentos/core";

const locatorPattern = /^([a-f0-9]{2})\/([a-f0-9-]{36})\.artifact$/i;

export interface StoredArtifactObject {
  locator: string;
  byteSize: number;
  sha256: string;
  truncated: boolean;
}

export interface ArtifactObjectStorage {
  write(id: string, content: Uint8Array, maxBytes: number): Promise<StoredArtifactObject>;
  read(locator: string): Promise<Buffer>;
  remove(locator: string): Promise<void>;
  deferRemove(locator: string, notBefore: Date): Promise<void>;
  cleanupAbandonedStaging(olderThan: Date): Promise<number>;
  cleanupOrphans(referencedLocators: readonly string[], olderThan: Date): Promise<number>;
}

export class ArtifactStorageError extends Error {
  constructor(
    message: string,
    readonly capturedByteSize: number,
    readonly capturedSha256: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactStorageError";
  }
}

export interface ArtifactStorageOptions {
  rootDirectory?: string;
  promote?: (stagedPath: string, objectPath: string) => Promise<void>;
}

/** Local immutable object storage. Locators are opaque relative keys, never host paths. */
export class FileSystemArtifactStorage implements ArtifactObjectStorage {
  readonly rootDirectory: string;
  private readonly promote: (stagedPath: string, objectPath: string) => Promise<void>;

  private constructor(
    rootDirectory: string,
    promote: (stagedPath: string, objectPath: string) => Promise<void>,
  ) {
    this.rootDirectory = rootDirectory;
    this.promote = promote;
  }

  static async open(options: ArtifactStorageOptions = {}): Promise<FileSystemArtifactStorage> {
    const configuredRoot = resolve(
      options.rootDirectory ?? join(homedir(), ".agentos", "artifacts"),
    );
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const rootDirectory = await realpath(configuredRoot);
    await mkdir(join(rootDirectory, "staging"), { recursive: true, mode: 0o700 });
    await mkdir(join(rootDirectory, "objects"), { recursive: true, mode: 0o700 });
    const storage = new FileSystemArtifactStorage(rootDirectory, options.promote ?? defaultPromote);
    await storage.safeDirectory("staging");
    await storage.safeDirectory("objects");
    return storage;
  }

  async write(id: string, content: Uint8Array, maxBytes: number): Promise<StoredArtifactObject> {
    const artifactId = artifactIdSchema.parse(id);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError("Artifact byte limit must be a non-negative safe integer");
    const captured = Buffer.from(content.subarray(0, maxBytes));
    const sha256 = createHash("sha256").update(captured).digest("hex");
    const truncated = captured.byteLength < content.byteLength;
    const stageName = `${artifactId}.${randomUUID()}.part`;
    const locator = `${artifactId.slice(0, 2)}/${artifactId}.artifact`;
    let stagedPath: string | undefined;
    let objectPath: string | undefined;
    let promoted = false;

    try {
      const stageDirectory = await this.safeDirectory("staging");
      stagedPath = join(stageDirectory, stageName);
      const objectDirectory = await this.safeDirectory(join("objects", artifactId.slice(0, 2)));
      objectPath = join(objectDirectory, `${artifactId}.artifact`);
      const handle = await open(stagedPath, "wx", 0o600);
      try {
        await handle.writeFile(captured);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const stagedBytes = await readFile(stagedPath);
      verifyBytes(stagedBytes, captured.byteLength, sha256);
      try {
        await this.promote(stagedPath, objectPath);
        promoted = true;
      } catch (error) {
        if (!isExists(error)) throw error;
        const existing = await readFile(objectPath);
        verifyBytes(existing, captured.byteLength, sha256);
        await unlink(stagedPath);
        return { locator, byteSize: captured.byteLength, sha256, truncated };
      }
      const persisted = await readFile(objectPath);
      verifyBytes(persisted, captured.byteLength, sha256);
      return { locator, byteSize: captured.byteLength, sha256, truncated };
    } catch (error) {
      if (stagedPath) await unlink(stagedPath).catch(() => undefined);
      if (promoted && objectPath) await unlink(objectPath).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new ArtifactStorageError(message.slice(0, 2_000), captured.byteLength, sha256, {
        cause: error,
      });
    }
  }

  async read(locator: string): Promise<Buffer> {
    const objectPath = await this.objectPath(locator);
    const info = await lstat(objectPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Artifact object is not a regular file");
    const resolvedObject = await realpath(objectPath);
    await assertWithin(
      await this.safeDirectory(join("objects", locatorPattern.exec(locator)![1]!)),
      resolvedObject,
    );
    return readFile(resolvedObject);
  }

  async remove(locator: string): Promise<void> {
    const objectPath = await this.objectPath(locator);
    await unlink(objectPath).catch((error: unknown) => {
      if (isMissing(error)) return;
      throw error;
    });
  }

  async deferRemove(locator: string, notBefore: Date): Promise<void> {
    const objectPath = await this.objectPath(locator);
    const info = await lstat(objectPath).catch((error: unknown) =>
      isMissing(error) ? null : Promise.reject(error),
    );
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Artifact object is not a regular file");
    const future = Math.max(Date.now(), notBefore.valueOf()) / 1000;
    await utimes(objectPath, future, future);
  }

  async cleanupAbandonedStaging(olderThan: Date): Promise<number> {
    const staging = await this.safeDirectory("staging");
    const names = await readdir(staging);
    let removed = 0;
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.[a-f0-9-]{36}\.part$/i.test(name)) continue;
      const filePath = join(staging, name);
      const info = await lstat(filePath);
      if (info.mtime > olderThan) continue;
      await unlink(filePath);
      removed += 1;
    }
    return removed;
  }

  async cleanupOrphans(referencedLocators: readonly string[], olderThan: Date): Promise<number> {
    const referenced = new Set(referencedLocators);
    const objectsRoot = await this.safeDirectory("objects");
    let removed = 0;
    for (const shard of await readdir(objectsRoot)) {
      if (!/^[a-f0-9]{2}$/i.test(shard)) continue;
      const directory = await this.safeDirectory(join("objects", shard));
      for (const name of await readdir(directory)) {
        const match = /^([a-f0-9-]{36})\.artifact$/i.exec(name);
        if (!match || match[1]!.slice(0, 2).toLowerCase() !== shard.toLowerCase()) continue;
        const locator = `${shard}/${name}`;
        if (referenced.has(locator)) continue;
        const filePath = join(directory, name);
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.mtime > olderThan) continue;
        await unlink(filePath);
        removed += 1;
      }
    }
    return removed;
  }

  private async objectPath(locator: string): Promise<string> {
    const match = locatorPattern.exec(locator);
    if (!match || match[2]!.slice(0, 2).toLowerCase() !== match[1]!.toLowerCase())
      throw new Error("Invalid artifact locator");
    const directory = await this.safeDirectory(join("objects", match[1]!));
    const candidate = join(directory, `${match[2]}.artifact`);
    const resolved = resolve(candidate);
    const rel = relative(directory, resolved);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("Artifact locator escapes object storage");
    return resolved;
  }

  private async safeDirectory(relativePath: string): Promise<string> {
    const candidate = resolve(this.rootDirectory, relativePath);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe artifact storage directory");
    const actual = await realpath(candidate);
    await assertWithin(this.rootDirectory, actual);
    return actual;
  }
}

async function defaultPromote(stagedPath: string, objectPath: string): Promise<void> {
  // A hard link is an atomic, no-overwrite promotion on the same filesystem.
  await link(stagedPath, objectPath);
  await rm(stagedPath);
}

function verifyBytes(bytes: Buffer, expectedSize: number, expectedSha256: string): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== expectedSize || digest !== expectedSha256)
    throw new Error("Artifact failed staged content verification");
}

async function assertWithin(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Artifact storage path escapes its configured root");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
