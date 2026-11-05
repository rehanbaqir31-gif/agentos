import { entityIdSchema } from "@agentos/core";
import type { PageRequest } from "@agentos/core";

export class RepositoryNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`);
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryConflictError";
  }
}

export class RelationshipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelationshipValidationError";
  }
}

export function pageRequest(input: PageRequest = {}): Required<PageRequest> {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new RangeError("limit must be between 1 and 200");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError("offset must be a non-negative integer");
  return { limit, offset };
}

export function translateError(error: unknown): never {
  let candidate = error;
  let code = "";
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth += 1) {
    if ("code" in candidate) {
      code = String((candidate as { code?: unknown }).code);
      if (["23505", "23503", "23514"].includes(code)) break;
    }
    candidate = "cause" in candidate ? (candidate as { cause?: unknown }).cause : undefined;
  }
  if (
    code === "23505" ||
    code === "23503" ||
    code === "23514" ||
    (error instanceof Error &&
      /UNIQUE constraint failed|PRIMARY KEY constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/i.test(
        error.message,
      ))
  ) {
    throw new RepositoryConflictError("Database constraint rejected the requested change", {
      cause: error,
    });
  }
  throw error;
}

export function assertId(id: string): string {
  return entityIdSchema.parse(id);
}
