import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../cli/datasetdiff.mjs", import.meta.url));
test("collect retains validated versions, skips repeat bytes, tracks rollback and exports comparisons", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "datasetdiff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "records.csv"),
    db = join(dir, "history.sqlite");
  const args = (cmd, ...extra) => [
    cli,
    cmd,
    "--db",
    db,
    "--name",
    "permits",
    ...extra,
  ];
  const run = (cmd, ...extra) =>
    execFileSync(process.execPath, args(cmd, ...extra), { encoding: "utf8" });
  const flags = ["--source", source, "--key", "id"];
  writeFileSync(source, "id,status\n1,open\n");
  assert.equal(JSON.parse(run("collect", ...flags)).newSnapshot, true);
  assert.equal(JSON.parse(run("collect", ...flags)).newSnapshot, false);
  writeFileSync(source, "id,status\n1,closed\n2,new\n");
  const second = JSON.parse(run("collect", ...flags));
  writeFileSync(source, "id,status\n1,broken\n1,duplicate\n");
  assert.notEqual(
    spawnSync(process.execPath, args("collect", ...flags)).status,
    0,
  );
  assert.equal(JSON.parse(run("history")).snapshots.length, 2);
  const report = JSON.parse(run("diff"));
  assert.equal(report.counts.added, 1);
  assert.equal(report.counts.changed, 1);
  assert.match(
    run("diff", "--format", "csv", "--from", "1", "--to", String(second.id)),
    /"changed"/,
  );
  assert.notEqual(
    spawnSync(
      process.execPath,
      args("collect", "--source", source, "--key", "status"),
    ).status,
    0,
  );
  writeFileSync(source, "id,status\n1,open\n");
  assert.equal(JSON.parse(run("collect", ...flags)).newSnapshot, true);
  assert.equal(JSON.parse(run("history")).snapshots.length, 3);
});
