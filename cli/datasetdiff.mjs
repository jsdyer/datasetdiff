#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  FEATURE_ID,
  MAX_BYTES,
  compare,
  changesCsv,
  parseDataset,
  propertyKey,
  validateKey,
} from "../web/model.mjs";

const usage = `Dataset Diff • local SQLite snapshot companion
  datasetdiff collect --db PATH --name SERIES --source FILE_OR_HTTPS --key COLUMN
  datasetdiff collect --db PATH --name SERIES --source FILE_OR_HTTPS --feature-id
  datasetdiff history --db PATH --name SERIES
  datasetdiff diff --db PATH --name SERIES [--from ID --to ID] [--format json|csv]
Omit the two snapshot IDs to compare the latest two distinct snapshots.`;

async function readSource(source) {
  if (!/^https?:\/\//i.test(source)) {
    const file = await open(source, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw Error("Source must be a regular file no larger than 32 MiB.");
      return await bounded(file.createReadStream({ autoClose: false }));
    } finally {
      await file.close();
    }
  }
  if (new URL(source).protocol !== "https:")
    throw Error("Remote sources require HTTPS.");
  const signal = AbortSignal.timeout(45000);
  let url = new URL(source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": "CoolCode-DatasetDiff/1.0" },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (!location) throw Error("Redirect lacks a destination.");
      url = new URL(location, url);
      if (url.protocol !== "https:")
        throw Error("Feed redirected away from HTTPS.");
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw Error("Feed returned HTTP " + res.status + ".");
    }
    return bounded(res.body);
  }
  throw Error("Feed exceeded the redirect limit.");
}

async function bounded(stream) {
  const parts = [];
  let size = 0;
  for await (const bytes of stream) {
    size += bytes.length;
    if (size > MAX_BYTES) throw Error("Snapshot exceeds 32 MiB.");
    parts.push(bytes);
  }
  return Buffer.concat(parts, size);
}
function decode(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS series (
    name TEXT PRIMARY KEY, source TEXT NOT NULL, key_spec TEXT NOT NULL, format TEXT NOT NULL, checked TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bodies (digest TEXT PRIMARY KEY, compressed BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL REFERENCES series(name),
    collected TEXT NOT NULL, digest TEXT NOT NULL REFERENCES bodies(digest), records INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS snapshots_series ON snapshots(name,id);`);
}
async function collect(db, o) {
  if (!o.source || !!o.key === !!o["feature-id"])
    throw Error(
      "Collect needs --source and exactly one of --key or --feature-id.",
    );
  const source = /^https?:\/\//i.test(o.source)
    ? new URL(o.source).href
    : resolve(o.source);
  const key = o["feature-id"] ? FEATURE_ID : propertyKey(o.key);
  // Serialize collection, including acquisition, so two scheduled calls cannot publish stale reads out of order.
  db.exec("BEGIN IMMEDIATE");
  try {
    const stored = db.prepare("SELECT * FROM series WHERE name=?").get(o.name);
    if (stored && (stored.source !== source || stored.key_spec !== key))
      throw Error(
        "This series already has a different source or key. Use a new series name.",
      );
    const bytes = await readSource(source);
    const parsed = parseDataset(decode(bytes), source);
    validateKey(parsed, key);
    if (stored && stored.format !== parsed.format)
      throw Error("The source format changed. Use a new series name.");
    const digest = createHash("sha256").update(bytes).digest("hex"),
      now = new Date().toISOString();
    db.prepare(
      "INSERT INTO series VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET checked=excluded.checked",
    ).run(o.name, source, key, parsed.format, now);
    const last = db
      .prepare(
        "SELECT id,digest FROM snapshots WHERE name=? ORDER BY id DESC LIMIT 1",
      )
      .get(o.name);
    let id = last?.id;
    if (last?.digest !== digest) {
      db.prepare("INSERT OR IGNORE INTO bodies VALUES(?,?)").run(
        digest,
        gzipSync(bytes),
      );
      id = Number(
        db
          .prepare(
            "INSERT INTO snapshots(name,collected,digest,records) VALUES(?,?,?,?)",
          )
          .run(o.name, now, digest, parsed.rows.length).lastInsertRowid,
      );
    }
    db.exec("COMMIT");
    console.log(
      JSON.stringify({
        series: o.name,
        id,
        records: parsed.rows.length,
        checked: now,
        newSnapshot: last?.digest !== digest,
      }),
    );
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
function show(db, command, o) {
  const series = db.prepare("SELECT * FROM series WHERE name=?").get(o.name);
  if (!series) throw Error("Unknown series: " + o.name);
  if (command === "history") {
    const snapshots = db
      .prepare(
        "SELECT id,collected,records,digest FROM snapshots WHERE name=? ORDER BY id",
      )
      .all(o.name);
    console.log(
      JSON.stringify(
        {
          series: o.name,
          key: series.key_spec,
          lastChecked: series.checked,
          snapshots,
        },
        null,
        2,
      ),
    );
    return;
  }
  let ids;
  if (o.from || o.to) {
    if (!/^\d+$/.test(o.from) || !/^\d+$/.test(o.to))
      throw Error("Specify both --from and --to as snapshot IDs.");
    ids = [Number(o.from), Number(o.to)];
  } else
    ids = db
      .prepare("SELECT id FROM snapshots WHERE name=? ORDER BY id DESC LIMIT 2")
      .all(o.name)
      .map((x) => x.id)
      .reverse();
  if (ids.length !== 2)
    throw Error("Collect at least two distinct snapshots before comparing.");
  const get = db.prepare(
    "SELECT s.id, s.collected, s.digest, b.compressed FROM snapshots s JOIN bodies b USING(digest) WHERE s.id=? AND s.name=?",
  );
  const snapshots = ids.map((id) => {
    const row = get.get(id, o.name);
    if (!row) throw Error("Snapshot " + id + " is unavailable in this series.");
    return row;
  });
  const datasets = snapshots.map((s) =>
    parseDataset(decode(gunzipSync(s.compressed)), series.source),
  );
  const report = {
    ...compare(datasets[0], datasets[1], series.key_spec),
    series: o.name,
    snapshots: snapshots.map(({ id, collected, digest }) => ({
      id,
      collected,
      digest,
    })),
  };
  if (o.format === "csv") process.stdout.write(changesCsv(report));
  else console.log(JSON.stringify(report, null, 2));
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage);
    return;
  }
  if (!["collect", "history", "diff"].includes(command)) throw Error(usage);
  const options = Object.fromEntries(
    ["db", "name", "source", "key", "from", "to", "format"].map((k) => [
      k,
      { type: "string" },
    ]),
  );
  options["feature-id"] = { type: "boolean" };
  const { values: o } = parseArgs({ args, options });
  if (!o.db || !o.name?.trim()) throw Error("Specify --db and --name.");
  if (o.format && !["json", "csv"].includes(o.format))
    throw Error("Use --format json or csv.");
  const db = new DatabaseSync(o.db, { readOnly: command !== "collect" });
  try {
    db.exec("PRAGMA busy_timeout=60000; PRAGMA foreign_keys=ON;");
    if (command === "collect") {
      initialize(db);
      await collect(db, o);
    } else show(db, command, o);
  } finally {
    db.close();
  }
}
main().catch((err) => {
  console.error("datasetdiff: " + err.message);
  process.exitCode = 1;
});
