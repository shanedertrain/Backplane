// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  buildKiStackInstructions,
  createKiStackSkills,
  getKiStackProviderSkills,
  installKiStackSkills,
  isKiStackProviderSkill,
  mergeKiStackProviderSkills,
} from "./KiStackSkills.ts";
import bundle from "./kistack.bundle.json" with { type: "json" };

it("installs all bundled skills and supporting files offline, and repairs missing resources", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "backplane-kistack-test-"),
  );
  try {
    await installKiStackSkills(directory);
    expect(bundle.skills).toHaveLength(10);
    for (const [relative, contents] of Object.entries(bundle.files)) {
      expect(await NodeFSP.readFile(NodePath.join(directory, relative), "utf8")).toBe(contents);
    }
    const schematic = NodePath.join(directory, "skills/schematic/SKILL.md");
    const before = (await NodeFSP.stat(schematic)).mtimeMs;
    const helper = NodePath.join(directory, "skills/export/scripts/convert_position.py");
    await NodeFSP.unlink(helper);
    await installKiStackSkills(directory);
    expect((await NodeFSP.stat(schematic)).mtimeMs).toBe(before);
    expect(await NodeFSP.readFile(helper, "utf8")).toBe(
      bundle.files["skills/export/scripts/convert_position.py"],
    );
    const instructions = buildKiStackInstructions(directory);
    for (const skill of bundle.skills) {
      expect(instructions).toContain(JSON.stringify(NodePath.join(directory, skill.path)));
    }
    expect(instructions).toContain("User instructions take precedence");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("reports installation errors instead of advertising unavailable skills", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "backplane-kistack-error-"),
  );
  try {
    const file = NodePath.join(directory, "not-a-directory");
    await NodeFSP.writeFile(file, "existing");
    await expect(installKiStackSkills(file)).rejects.toThrow();
    expect(await NodeFSP.readFile(file, "utf8")).toBe("existing");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("omits a bundled skill from the injected instructions when the project pins its own copy of the same name", async () => {
  // Regression test for the root cause found in the Albatross Automata
  // hardware repo: buildRuntimeInstructions -> buildKiStackInstructions()
  // was called with no project context at all, so the *injected system-
  // prompt text* always asserted Backplane's own bundled/cached KiStack
  // content for every skill name, even when a project had its own pinned
  // copy of the same name on disk (e.g. a git submodule symlinked into
  // .claude/skills/<name>). mergeKiStackProviderSkills (used only for the
  // `$` picker) already got this right; buildKiStackInstructions (used for
  // the actual runtime instructions every provider adapter injects) did not
  // consult the project at all.
  const project = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-project-"));
  try {
    const overriddenDir = NodePath.join(project, ".claude", "skills", "kicad-export");
    await NodeFSP.mkdir(overriddenDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(overriddenDir, "SKILL.md"),
      "---\nname: kicad-export\ndescription: Project-pinned copy\n---\nPROJECT_MARKER: CPL rotation guidance lives here.\n",
    );

    const bundledDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "backplane-kistack-bundled-"),
    );
    try {
      await installKiStackSkills(bundledDir);

      const withoutProjectContext = buildKiStackInstructions(bundledDir);
      expect(withoutProjectContext).toContain("kicad-export:");

      const withProjectContext = buildKiStackInstructions(bundledDir, project);
      expect(withProjectContext).not.toContain(
        JSON.stringify(NodePath.join(bundledDir, "skills/export/SKILL.md")),
      );
      expect(withProjectContext).toContain("kicad-export");
      expect(withProjectContext).toContain("The project has its own pinned copy of: kicad-export.");
      // Every other bundled skill is unaffected -- this is a per-name check,
      // not a blanket "project exists" switch.
      expect(withProjectContext).toContain(
        JSON.stringify(NodePath.join(bundledDir, "skills/layout/SKILL.md")),
      );
    } finally {
      await NodeFSP.rm(bundledDir, { recursive: true, force: true });
    }
  } finally {
    await NodeFSP.rm(project, { recursive: true, force: true });
  }
});

it("end-to-end: this project's real pinned KiStack fork shadows the bundled catalog entry it duplicates", async () => {
  // Uses the actual hardware repo checkout this bug was found in, not a
  // synthetic fixture -- proves the fix against the real pinned fork commit
  // (.claude/vendor/kistack @ 775ba27), which carries a real, distinctive
  // CPL-rotation-guidance addition to skills/export/SKILL.md that the
  // bundled catalog does not have.
  const hardwareRepo = "/home/cbash23/projects/hardware";
  const pinnedExportSkill = NodePath.join(hardwareRepo, ".claude/skills/kicad-export/SKILL.md");
  const pinnedContent = await NodeFSP.readFile(pinnedExportSkill, "utf8").catch(() => undefined);
  if (pinnedContent === undefined) {
    // Environment-specific fixture unavailable (e.g. CI without that repo
    // checked out) -- the synthetic test above covers the same logic.
    return;
  }
  expect(pinnedContent).toContain("TPS2553DBVR");

  const instructions = buildKiStackInstructions(undefined, hardwareRepo);
  // This repo pins ALL ten kistack skills as submodule symlinks (not just
  // kicad-export), so the provenance line lists all ten -- proving the
  // check is genuinely per-name across the whole catalog, not a special
  // case for the one skill this bug was first found through.
  expect(instructions).toMatch(/The project has its own pinned copy of:.*\bkicad-export\b/);
  expect(instructions).not.toMatch(/Read ".*\/backplane\/kistack\/.*skills\/export\/SKILL\.md"/);
});

it("exposes KiStack skills in the provider catalog without replacing native skills", () => {
  const native = {
    name: "kicad-pcb",
    description: "Provider copy",
    path: "/provider/skills/kicad-pcb/SKILL.md",
    enabled: true,
  } as const;
  const merged = mergeKiStackProviderSkills([native]);
  expect(merged[0]).toEqual(native);
  expect(merged.filter((skill) => skill.name === "kicad-pcb")).toHaveLength(1);
  expect(merged.map((skill) => skill.name)).toContain("kicad-layout");
  expect(getKiStackProviderSkills().every((skill) => skill.scope === "system")).toBe(true);
});

it("replaces stale app catalog rows when a KiStack revision changes", () => {
  const stale = {
    name: "kicad-layout",
    description: "Old catalog entry",
    path: "/home/test/.cache/backplane/kistack/old/skills/layout/SKILL.md",
    scope: "system",
    enabled: true,
  } as const;
  const merged = mergeKiStackProviderSkills([stale]);
  expect(isKiStackProviderSkill(stale)).toBe(true);
  expect(merged.find((skill) => skill.name === stale.name)?.path).not.toBe(stale.path);
  expect(merged.some((skill) => skill.path === stale.path)).toBe(false);
});

it("replaces an older cached catalog when the bundled skill set grows", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-kistack-upgrade-"));
  const oldRevision = "97934211326a03c0541b784c616c6582cdc14107";
  try {
    await installKiStackSkills(root);
    const oldDirectory = NodePath.join(root, oldRevision);
    await NodeFSP.mkdir(oldDirectory, { recursive: true });
    const metadata = {
      revision: oldRevision,
      skills: bundle.skills.filter((skill) => skill.name !== "kicad-layout"),
      files: Object.keys(bundle.files).filter((file) => file !== "skills/layout/SKILL.md"),
    };
    for (const file of metadata.files) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(oldDirectory, file)), {
        recursive: true,
      });
      const contents = bundle.files[file as keyof typeof bundle.files];
      if (contents === undefined) throw new Error(`Missing bundled file: ${file}`);
      await NodeFSP.writeFile(NodePath.join(oldDirectory, file), contents);
    }
    await NodeFSP.writeFile(
      NodePath.join(oldDirectory, ".backplane-kistack.json"),
      JSON.stringify(metadata),
    );
    await NodeFSP.writeFile(
      NodePath.join(root, ".backplane-active.json"),
      JSON.stringify({ sha: oldRevision }),
    );

    const instance = createKiStackSkills({
      cacheDirectory: root,
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    await instance.install();
    expect(instance.revision).toBe(bundle.revision);
    expect(instance.skills.map((skill) => skill.name)).toContain("kicad-layout");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

const revision = "a".repeat(40);
const skill = "---\nname: kicad-test\ndescription: A test skill\n---\n\nUse it.\n";
const tree = [
  { path: "LICENSE", type: "blob", mode: "100644", size: 5 },
  { path: "skills/test/SKILL.md", type: "blob", mode: "100644", size: skill.length },
];

it("refreshes an immutable revision, coalesces concurrent checks, and restores it after restart", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-kistack-refresh-"));
  let calls = 0;
  const fetchImpl = async (input: string): Promise<Response> => {
    calls += 1;
    if (input.endsWith("/commits/HEAD"))
      return new Response(JSON.stringify({ sha: revision }), { headers: { etag: '"test"' } });
    if (input.includes("/git/trees/")) return new Response(JSON.stringify({ tree }));
    if (input.endsWith("/LICENSE")) return new Response("test\n");
    return new Response(skill);
  };
  try {
    const instance = createKiStackSkills({ cacheDirectory: root, fetchImpl });
    const [first, second] = await Promise.all([instance.refresh(), instance.refresh()]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(calls).toBe(4);
    expect(instance.revision).toBe(revision);
    expect(
      await NodeFSP.readFile(NodePath.join(root, revision, "skills/test/SKILL.md"), "utf8"),
    ).toBe(skill);
    const restarted = createKiStackSkills({
      cacheDirectory: root,
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    await restarted.install();
    expect(restarted.revision).toBe(revision);
    expect(restarted.directory).toBe(NodePath.join(root, revision));
    await expect(restarted.refresh()).rejects.toThrow("network");
    expect(restarted.revision).toBe(revision);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("uses the ETag for an unchanged check", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-kistack-etag-"));
  let calls = 0;
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls += 1;
    if (input.endsWith("/commits/HEAD")) {
      if (calls === 1)
        return new Response(JSON.stringify({ sha: revision }), { headers: { etag: '"same"' } });
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"same"');
      return new Response(null, { status: 304 });
    }
    if (input.includes("/git/trees/")) return new Response(JSON.stringify({ tree }));
    return new Response(input.endsWith("/LICENSE") ? "test\n" : skill);
  };
  try {
    const instance = createKiStackSkills({ cacheDirectory: root, fetchImpl });
    await instance.install();
    expect(await instance.refresh()).toBe(true);
    expect(await instance.refresh()).toBe(false);
    expect(calls).toBe(5);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("keeps the previous snapshot after a partial download and retries the same revision", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-kistack-partial-"));
  let fail = true;
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/commits/HEAD")) {
      expect(new Headers(init?.headers).get("if-none-match")).toBeNull();
      return new Response(JSON.stringify({ sha: revision }), { headers: { etag: '"retry"' } });
    }
    if (input.includes("/git/trees/")) return new Response(JSON.stringify({ tree }));
    if (input.endsWith("/LICENSE")) return new Response("test\n");
    if (fail) {
      fail = false;
      return new Response("broken", { status: 503 });
    }
    return new Response(skill);
  };
  try {
    const instance = createKiStackSkills({ cacheDirectory: root, fetchImpl });
    await expect(instance.refresh()).rejects.toThrow();
    expect(instance.revision).toBe(bundle.revision);
    expect(
      await NodeFSP.stat(NodePath.join(root, revision)).catch(() => undefined),
    ).toBeUndefined();
    expect(await instance.refresh()).toBe(true);
    expect(instance.revision).toBe(revision);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects unsafe paths and preserves binary files while parsing multiline YAML", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-kistack-safety-"));
  const binaryRevision = "b".repeat(40);
  const binary = new Uint8Array([0, 255, 1, 2]);
  const multiline = "---\nname: kicad-binary\ndescription: >\n  A multiline\n  description.\n---\n";
  const fetchImpl = async (input: string): Promise<Response> => {
    if (input.endsWith("/commits/HEAD"))
      return new Response(JSON.stringify({ sha: binaryRevision }));
    if (input.includes("/git/trees/"))
      return new Response(
        JSON.stringify({
          tree: [
            { path: "LICENSE", type: "blob", mode: "100644", size: 1 },
            { path: "skills/test/SKILL.md", type: "blob", mode: "100644", size: multiline.length },
            { path: "skills/test/data.bin", type: "blob", mode: "100755", size: binary.length },
            { path: "skills/../escape", type: "blob", mode: "100644", size: 1 },
          ],
        }),
      );
    return new Response("x");
  };
  try {
    const instance = createKiStackSkills({ cacheDirectory: root, fetchImpl });
    await expect(instance.refresh()).rejects.toThrow();
    expect(
      await NodeFSP.stat(NodePath.join(root, binaryRevision)).catch(() => undefined),
    ).toBeUndefined();
    const validFetch = async (input: string): Promise<Response> => {
      if (input.endsWith("/commits/HEAD"))
        return new Response(JSON.stringify({ sha: binaryRevision }));
      if (input.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            tree: [
              { path: "LICENSE", type: "blob", mode: "100644", size: 1 },
              {
                path: "skills/test/SKILL.md",
                type: "blob",
                mode: "100644",
                size: multiline.length,
              },
              { path: "skills/test/data.bin", type: "blob", mode: "100755", size: binary.length },
            ],
          }),
        );
      if (input.endsWith("data.bin")) return new Response(binary);
      return new Response(multiline);
    };
    const valid = createKiStackSkills({ cacheDirectory: root, fetchImpl: validFetch });
    expect(await valid.refresh()).toBe(true);
    expect(
      new Uint8Array(
        await NodeFSP.readFile(NodePath.join(root, binaryRevision, "skills/test/data.bin")),
      ),
    ).toEqual(binary);
    expect(valid.buildInstructions()).toContain("A multiline description.");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("backs off after rate limiting and resumes when the retry window expires", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "backplane-kistack-rate-"));
  let current = 100;
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 429, headers: { "retry-after": "10" } });
    return new Response(JSON.stringify({ sha: bundle.revision }));
  };
  try {
    const instance = createKiStackSkills({ cacheDirectory: root, fetchImpl, now: () => current });
    await expect(instance.refresh()).rejects.toThrow();
    current = 5_000;
    expect(await instance.refresh()).toBe(false);
    expect(calls).toBe(1);
    current = 10_100;
    expect(await instance.refresh()).toBe(false);
    expect(calls).toBe(2);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
