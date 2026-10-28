import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(ROOT, "deploy", "continuity-listener", "container-entrypoint.sh");
const VENDOR = join(ROOT, "deploy", "continuity-listener", "vendor", "letta-code");

test("generic listener container entrypoint preserves prior locks and launches in state home", async () => {
  const home = await mkdtemp(join(tmpdir(), "continuity-entrypoint-"));
  const listeners = join(home, ".letta", "listeners");
  await mkdir(listeners, { recursive: true, mode: 0o700 });
  await writeFile(join(listeners, "primary.lock"), "old lock\n", { mode: 0o600 });
  const result = spawnSync(ENTRYPOINT, [process.execPath, "-e", "process.stdout.write(process.cwd())"], {
    env: { ...process.env, CONTINUITY_HOME: home, CONTINUITY_EXPECTED_UID: String(process.getuid?.() ?? 0) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, home);
  const entries = await readdir(listeners);
  assert.equal(entries.includes("primary.lock"), false);
  assert.equal(entries.some(name => /^primary\.lock\.orphaned-.*-container-[0-9a-f]{16}$/.test(name)), true);
});

test("generic listener container entrypoint rejects an unsafe lock path", async () => {
  const home = await mkdtemp(join(tmpdir(), "continuity-entrypoint-unsafe-"));
  const listeners = join(home, ".letta", "listeners");
  await mkdir(listeners, { recursive: true, mode: 0o700 });
  const target = join(home, "target");
  await writeFile(target, "do not move\n", { mode: 0o600 });
  await symlink(target, join(listeners, "unsafe.lock"));
  const result = spawnSync(ENTRYPOINT, ["true"], {
    env: { ...process.env, CONTINUITY_HOME: home, CONTINUITY_EXPECTED_UID: String(process.getuid?.() ?? 0) },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe listener lock path/);
  assert.equal(await readFile(target, "utf8"), "do not move\n");
  assert.equal((await lstat(join(listeners, "unsafe.lock"))).isSymbolicLink(), true);
});

test("vendored Letta runtime has exact artifact, patch, checksum, and source provenance", async () => {
  const tarball = join(VENDOR, "letta-ai-letta-code-0.34.24.tgz");
  const checksums = await readFile(join(VENDOR, "SHA256SUMS"), "utf8");
  const checksum = checksums.trim().split(/\s+/)[0];
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  assert.equal(digest, "3b347b7c220d137c7dcc6792c6f5972b173137d19c0f83f902d9de2b23f0088c");
  assert.equal(digest, checksum);
  const patchBytes = await readFile(join(VENDOR, "git-diff.patch"));
  const patchDigest = createHash("sha256").update(patchBytes).digest("hex");
  assert.equal(patchDigest, "9690355d57a4324b89e8b5d97d2c1fbc76ef819d4bac70ef8c6f3426c3cb5c35");
  assert.match(checksums, new RegExp(`${patchDigest}\\s+git-diff\\.patch`));
  const provenance = JSON.parse(await readFile(join(VENDOR, "provenance.json"), "utf8"));
  assert.equal(provenance.package, "@letta-ai/letta-code");
  assert.equal(provenance.version, "0.34.24");
  assert.equal(provenance.upstreamTag, "v0.34.24");
  assert.equal(provenance.upstreamCommit, "6f4e4886c");
  assert.match(provenance.statement, /not the npm registry artifact/);

  const humanProvenance = await readFile(join(VENDOR, "PROVENANCE.md"), "utf8");
  assert.match(humanProvenance, /custom patched build/);
  assert.match(humanProvenance, /v0\.34\.24/);
  assert.match(humanProvenance, /6f4e4886c/);
  assert.match(humanProvenance, /not the npm registry artifact/);
  assert.match(humanProvenance, /includes `npm-shrinkwrap\.json`/);
  assert.match(humanProvenance, /npm honors that packaged shrinkwrap/);
  assert.match(humanProvenance, /top-level `LICENSE` remains the separate MIT license/);

  const vendorLicense = await readFile(join(VENDOR, "LICENSE"), "utf8");
  assert.match(vendorLicense, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(vendorLicense, /Copyright 2025, Letta authors/);

  const directory = await mkdtemp(join(tmpdir(), "continuity-vendor-"));
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", directory, "--strip-components=1"], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.34.24");
  assert.equal((await lstat(join(directory, "npm-shrinkwrap.json"))).isFile(), true);

  for (const dockerfile of [
    join(ROOT, "Dockerfile.listener"),
    join(ROOT, "deploy", "continuity-listener", "Dockerfile"),
  ]) {
    const source = await readFile(dockerfile, "utf8");
    assert.match(source, /sha256sum --check SHA256SUMS/);
    assert.match(source, /npm install --global \.\/letta-ai-letta-code-0\.34\.24\.tgz/);
    assert.doesNotMatch(source, /--ignore-scripts/);
  }
});
