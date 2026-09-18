// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  acquireProjectWriterLease,
  forceReleaseProjectWriterLease,
  getProjectWriterLeaseOwner,
  heartbeatProjectWriterLease,
  releaseProjectWriterLease,
} from "./ProjectWriterLease.ts";

async function withProjectAndCache(
  fn: (project: string, cacheRoot: string) => Promise<void> | void,
): Promise<void> {
  const project = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lease-project-"));
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lease-cache-"));
  try {
    await fn(project, cacheRoot);
  } finally {
    await NodeFSP.rm(project, { recursive: true, force: true });
    await NodeFSP.rm(cacheRoot, { recursive: true, force: true });
  }
}

// Test A: session A acquires, session B's mutation attempt is denied before
// anything about the project or lease state changes for B.
it("Test A: a second session is denied while the first session's lease is active", async () => {
  await withProjectAndCache((project, cacheRoot) => {
    const a = acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
    });
    expect(a.granted).toBe(true);

    const b = acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-b",
      provider: "Codex",
      cacheRoot,
    });
    expect(b.granted).toBe(false);
    expect(b.owner.sessionId).toBe("session-a");

    // B's failed attempt must not have displaced A as owner.
    const stillOwner = getProjectWriterLeaseOwner({ projectPath: project, cacheRoot });
    expect(stillOwner.owner?.sessionId).toBe("session-a");
  });
});

// Test B: read-only inspection never requires or blocks on acquiring.
it("Test B: read-only concurrent inspection succeeds while another session holds the lease", async () => {
  await withProjectAndCache((project, cacheRoot) => {
    acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
    });

    // A read-only session never calls acquire; it can always inspect.
    const inspected = getProjectWriterLeaseOwner({ projectPath: project, cacheRoot });
    expect(inspected.owner?.sessionId).toBe("session-a");
    expect(inspected.stale).toBe(false);
  });
});

// Test C: normal release, then a second session can acquire.
it("Test C: after a normal release, another session can acquire", async () => {
  await withProjectAndCache((project, cacheRoot) => {
    acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
    });
    const released = releaseProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      cacheRoot,
    });
    expect(released).toBe(true);

    const b = acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-b",
      provider: "Codex",
      cacheRoot,
    });
    expect(b.granted).toBe(true);
  });
});

// Test D: abnormal termination (no release call, heartbeat goes stale) ->
// the stale lease can be safely recovered by a new acquire, per documented
// policy -- distinct from stealing an *active* lease, which never happens.
it("Test D: a stale lease from an abnormally-terminated session can be recovered", async () => {
  await withProjectAndCache((project, cacheRoot) => {
    // @effect-diagnostics-next-line globalDate:off - fixed test-time baseline, not a real clock read
    const staleTime = Date.now() - 10 * 60_000; // 10 minutes ago
    acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
      now: staleTime,
    });
    // Session A never releases (simulating a crash) and never heartbeats again.

    // Immediately after, on a fresh clock read, another session is still denied --
    // staleness is relative to `now`, not automatic.
    const tooSoon = acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-b",
      provider: "Codex",
      cacheRoot,
      now: staleTime + 1_000,
      staleAfterMs: 60_000,
    });
    expect(tooSoon.granted).toBe(false);

    // Once the heartbeat is old enough to exceed the staleness threshold,
    // a new acquire recovers it.
    const recovered = acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-b",
      provider: "Codex",
      cacheRoot,
      now: staleTime + 61_000,
      staleAfterMs: 60_000,
    });
    expect(recovered.granted).toBe(true);
    expect(recovered.owner.sessionId).toBe("session-b");
  });
});

it("heartbeat keeps an active session's lease from going stale, and only the owner can heartbeat it", async () => {
  await withProjectAndCache((project, cacheRoot) => {
    // @effect-diagnostics-next-line globalDate:off - fixed test-time baseline, not a real clock read
    const start = Date.now() - 100_000;
    acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
      now: start,
    });

    // A non-owner heartbeat attempt is rejected and changes nothing.
    expect(
      heartbeatProjectWriterLease({
        projectPath: project,
        sessionId: "session-b",
        cacheRoot,
        now: start + 30_000,
      }),
    ).toBe(false);

    // The real owner's heartbeat succeeds and pushes the staleness clock forward.
    expect(
      heartbeatProjectWriterLease({
        projectPath: project,
        sessionId: "session-a",
        cacheRoot,
        now: start + 30_000,
      }),
    ).toBe(true);

    const stillActive = acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-b",
      provider: "Codex",
      cacheRoot,
      now: start + 89_000, // 59s after the heartbeat -- still under the 60s threshold
      staleAfterMs: 60_000,
    });
    expect(stillActive.granted).toBe(false);
  });
});

// Test E: acquiring, heartbeating, and releasing a lease must never touch
// any file inside the project itself -- the lease lives entirely in
// Backplane's own cache directory.
it("Test E: lease operations never write inside the project directory", async () => {
  await withProjectAndCache(async (project, cacheRoot) => {
    await NodeFSP.writeFile(NodePath.join(project, "bench-rig.kicad_pcb"), "unchanged");
    const before = await NodeFSP.readdir(project);

    acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
    });
    heartbeatProjectWriterLease({ projectPath: project, sessionId: "session-a", cacheRoot });
    releaseProjectWriterLease({ projectPath: project, sessionId: "session-a", cacheRoot });

    const after = await NodeFSP.readdir(project);
    expect(after).toEqual(before);
    expect(await NodeFSP.readFile(NodePath.join(project, "bench-rig.kicad_pcb"), "utf8")).toBe(
      "unchanged",
    );
  });
});

it("force-release is available as an explicit recovery path distinct from normal release", async () => {
  await withProjectAndCache((project, cacheRoot) => {
    acquireProjectWriterLease({
      projectPath: project,
      sessionId: "session-a",
      provider: "Claude Code",
      cacheRoot,
    });
    // An active lease still blocks a normal acquire from another session...
    expect(
      acquireProjectWriterLease({
        projectPath: project,
        sessionId: "session-b",
        provider: "Codex",
        cacheRoot,
      }).granted,
    ).toBe(false);

    // ...but force-release is available as the deliberate, explicit path.
    forceReleaseProjectWriterLease({ projectPath: project, cacheRoot });
    expect(
      acquireProjectWriterLease({
        projectPath: project,
        sessionId: "session-b",
        provider: "Codex",
        cacheRoot,
      }).granted,
    ).toBe(true);
  });
});
