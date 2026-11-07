import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { AuthSession, Principal, RepositorySet } from "@agentos/core";

function derive(password: string, salt: Buffer, length: number, options: object): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, value) => {
      if (error) reject(error);
      else resolve(value as Buffer);
    });
  });
}
const PASSWORD_KDF = { N: 32_768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface VerifiedSession {
  principal: Principal;
  session: AuthSession;
  tokenHash: string;
}

export class AuthenticationError extends Error {
  constructor(message = "Authentication failed") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class LocalAuthenticationService {
  constructor(
    private readonly repositories: RepositorySet,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async provisionInitialPrincipal(name: string, password: string): Promise<Principal> {
    const normalizedName = normalizeName(name);
    validatePassword(password);
    const existing = await this.repositories.auth.findAnyPrincipal();
    if (existing) return existing;
    return this.repositories.auth.createPrincipal({
      name: normalizedName,
      passwordHash: await hashPassword(password),
    });
  }

  async login(
    name: string,
    password: string,
  ): Promise<{ principal: Principal; token: string; session: AuthSession }> {
    const normalizedName = normalizeName(name);
    const credentials = await this.repositories.auth.verifyPasswordHash(normalizedName);
    const valid = credentials
      ? await verifyPassword(password, credentials.passwordHash)
      : await verifyPassword(password, await hashPassword("agentos-invalid-login-sentinel"));
    if (!credentials || !valid) throw new AuthenticationError();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = digestToken(token);
    const createdAt = Date.parse(this.now());
    const session = await this.repositories.auth.createSession({
      principalId: credentials.principal.id,
      tokenHash,
      expiresAt: new Date(createdAt + SESSION_TTL_MS).toISOString(),
    });
    return { principal: credentials.principal, token, session };
  }

  async authenticate(token: string | undefined): Promise<VerifiedSession | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = digestToken(token);
    return this.authenticateHash(tokenHash);
  }

  async authenticateHash(tokenHash: string): Promise<VerifiedSession | null> {
    const session = await this.repositories.auth.findSession(tokenHash);
    if (!session) return null;
    const principal = await this.repositories.auth.getPrincipal(session.principalId);
    if (!principal || principal.disabledAt) return null;
    return { principal, session, tokenHash };
  }

  async logout(tokenHash: string): Promise<void> {
    await this.repositories.auth.revokeSession(tokenHash, this.now());
  }

  static hashToken(token: string): string {
    return digestToken(token);
  }
}

export function normalizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized))
    throw new AuthenticationError("Invalid local account name");
  return normalized;
}

export function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 14 || Buffer.byteLength(password) > 1024)
    throw new AuthenticationError("Local password must be at least 14 characters");
}

async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await derive(password, salt, PASSWORD_KDF.keylen, {
    N: PASSWORD_KDF.N,
    r: PASSWORD_KDF.r,
    p: PASSWORD_KDF.p,
    maxmem: PASSWORD_KDF.maxmem,
  });
  return `scrypt$${PASSWORD_KDF.N}$${PASSWORD_KDF.r}$${PASSWORD_KDF.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, serialized: string): Promise<boolean> {
  const [scheme, rawN, rawR, rawP, rawSalt, rawExpected, extra] = serialized.split("$");
  if (scheme !== "scrypt" || !rawN || !rawR || !rawP || !rawSalt || !rawExpected || extra)
    return false;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (N !== PASSWORD_KDF.N || r !== PASSWORD_KDF.r || p !== PASSWORD_KDF.p) return false;
  try {
    const salt = Buffer.from(rawSalt, "base64url");
    const expected = Buffer.from(rawExpected, "base64url");
    if (salt.length !== 16 || expected.length !== PASSWORD_KDF.keylen) return false;
    const actual = await derive(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: PASSWORD_KDF.maxmem,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
