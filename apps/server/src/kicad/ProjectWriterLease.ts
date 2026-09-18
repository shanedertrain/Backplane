// @effect-diagnostics nodeBuiltinImport:off
/**
 * ProjectWriterLease — prevents two Backplane agent sessions from holding
 * mutation authority over the same KiCad project at the same time.
 *
 * Plain node:fs/node:path, matching KiStackSkills.ts's precedent for the
 * same reason: this is simple, synchronous, low-frequency file I/O (a
 * lease acquired/heartbeat/released a handful of times per turn, not a hot
 * path), not worth threading Effect's FileSystem/Path through six
 * otherwise-plain provider adapters for. `currentTimeMs()` below is the one
 * `Date.now()` call site, narrowly suppressed rather than file-wide, same
 * as every caller's `now` override defaults to it.
 *
 * Why this exists: a live concurrent-write hazard was observed between two
 * independent agent sessions operating on the same project checkout at the
 * same time (no corruption resulted, but it was real, not theoretical --
 * see the downstream project's `kicad-layout`/`kicad-pcb` skill guidance,
 * which already warns "only one process/agent should write the active
 * board at a time"). Prompt-level guidance alone does not prevent this;
 * this module is the actual enforcement.
 *
 * Design:
 * - One lease file per canonical project path, in Backplane's own data
 *   directory (never inside the project, never committed to the project's
 *   git history).
 * - A lease is "active" while its heartbeat is recent; once the heartbeat
 *   goes stale (the owning session exited abnormally, crashed, or the
 *   machine rebooted), a *new* acquire call may silently reclaim it -- this
 *   is the documented stale-recovery path, not the same thing as stealing
 *   an active lease, which this module never does automatically.
 * - Read-only sessions never need to call `acquire` at all -- they simply
 *   don't, and are therefore never blocked by another session's lease.
 * - `forceRelease` is the explicit, deliberate recovery path for a stuck
 *   lease; nothing here calls it automatically.
 *
 * @module kicad/ProjectWriterLease
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface LeaseOwner {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly pid?: number;
  readonly acquiredAt: number;
  readonly lastHeartbeat: number;
}

export interface AcquireResult {
  readonly granted: boolean;
  /** The current owner, whether this call granted the lease or was denied. */
  readonly owner: LeaseOwner;
}

const DEFAULT_STALE_AFTER_MS = 60_000;

// The one wall-clock read in this module; every caller's `now` param
// defaults here so tests can override it deterministically.
function currentTimeMs(): number {
  // @effect-diagnostics-next-line globalDate:off
  return Date.now();
}

export function projectWriterLeaseDirectory(cacheRoot?: string): string {
  return NodePath.join(
    cacheRoot ?? NodePath.join(NodeOS.homedir(), ".cache", "backplane"),
    "project-leases",
  );
}

function leaseFilePath(projectPath: string, cacheRoot?: string): string {
  const canonical = NodeFS.realpathSync(projectPath);
  const hash = NodeCrypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return NodePath.join(projectWriterLeaseDirectory(cacheRoot), `${hash}.json`);
}

function readLease(filePath: string): LeaseOwner | undefined {
  try {
    const raw = NodeFS.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "projectPath" in parsed &&
      "sessionId" in parsed &&
      "provider" in parsed &&
      "acquiredAt" in parsed &&
      "lastHeartbeat" in parsed
    ) {
      return parsed as LeaseOwner;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeLeaseAtomically(filePath: string, owner: LeaseOwner): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(owner));
  NodeFS.renameSync(temp, filePath);
}

function isStale(owner: LeaseOwner, now: number, staleAfterMs: number): boolean {
  return now - owner.lastHeartbeat > staleAfterMs;
}

/**
 * Acquire (or renew) the writer lease for a project. Granted when: no lease
 * exists yet, the existing lease is stale, or the caller already owns it
 * (renewal/heartbeat-via-acquire). Denied -- without changing anything --
 * when another session holds an active (non-stale) lease.
 */
export function acquireProjectWriterLease(input: {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly pid?: number;
  readonly cacheRoot?: string;
  readonly now?: number;
  readonly staleAfterMs?: number;
}): AcquireResult {
  const now = input.now ?? currentTimeMs();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const filePath = leaseFilePath(input.projectPath, input.cacheRoot);
  const existing = readLease(filePath);

  if (existing && existing.sessionId !== input.sessionId && !isStale(existing, now, staleAfterMs)) {
    return { granted: false, owner: existing };
  }

  const owner: LeaseOwner = {
    projectPath: NodeFS.realpathSync(input.projectPath),
    sessionId: input.sessionId,
    provider: input.provider,
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    acquiredAt: existing && existing.sessionId === input.sessionId ? existing.acquiredAt : now,
    lastHeartbeat: now,
  };
  writeLeaseAtomically(filePath, owner);
  return { granted: true, owner };
}

/** Renew an already-held lease's heartbeat. No-op (returns false) if the caller doesn't hold it. */
export function heartbeatProjectWriterLease(input: {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly cacheRoot?: string;
  readonly now?: number;
}): boolean {
  const filePath = leaseFilePath(input.projectPath, input.cacheRoot);
  const existing = readLease(filePath);
  if (!existing || existing.sessionId !== input.sessionId) return false;
  writeLeaseAtomically(filePath, { ...existing, lastHeartbeat: input.now ?? currentTimeMs() });
  return true;
}

/** Release a lease this session holds. No-op (returns false) if another session owns it -- never releases someone else's lease. */
export function releaseProjectWriterLease(input: {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly cacheRoot?: string;
}): boolean {
  const filePath = leaseFilePath(input.projectPath, input.cacheRoot);
  const existing = readLease(filePath);
  if (!existing || existing.sessionId !== input.sessionId) return false;
  NodeFS.rmSync(filePath, { force: true });
  return true;
}

/** Read-only inspection -- never grants, never blocks. What a concurrent read-only session (or `doctor`) uses. */
export function getProjectWriterLeaseOwner(input: {
  readonly projectPath: string;
  readonly cacheRoot?: string;
  readonly now?: number;
  readonly staleAfterMs?: number;
}): { readonly owner: LeaseOwner | undefined; readonly stale: boolean } {
  const filePath = leaseFilePath(input.projectPath, input.cacheRoot);
  const existing = readLease(filePath);
  if (!existing) return { owner: undefined, stale: false };
  const now = input.now ?? currentTimeMs();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return { owner: existing, stale: isStale(existing, now, staleAfterMs) };
}

/**
 * Explicit, deliberate recovery path for a stuck lease. Nothing in this
 * module calls this automatically -- per the design constraint that
 * force-release must never become the normal workflow.
 */
export function forceReleaseProjectWriterLease(input: {
  readonly projectPath: string;
  readonly cacheRoot?: string;
}): void {
  const filePath = leaseFilePath(input.projectPath, input.cacheRoot);
  NodeFS.rmSync(filePath, { force: true });
}
