import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDataset,
  compare,
  keyOptions,
  changesCsv,
  propertyKey,
  FEATURE_ID,
} from "../web/model.mjs";

const csv = (text) => parseDataset(text, "sample.csv");
const geo = (features) =>
  parseDataset(
    JSON.stringify({ type: "FeatureCollection", features }),
    "sample.geojson",
  );
const feature = (id, properties, geometry = null) => ({
  type: "Feature",
  id,
  properties,
  geometry,
});
const key = propertyKey("id");

test("CSV honours BOM, escaped quotes, multiline fields, empty fields and text IDs", () => {
  const a = csv('\uFEFFid,v\r\n01,"a,""b""\nc"\r\n02,\r\n');
  assert.equal(a.rows[0].fields.v, 'a,"b"\nc');
  const b = csv("v,id\n,02\nnext,3\n");
  const diff = compare(a, b, key);
  assert.deepEqual(diff.counts, {
    added: 1,
    removed: 1,
    changed: 0,
    unchanged: 1,
  });
  assert.equal(diff.changes[0].id, "01");
});
test("reject invalid headers, quoting, widths and ambiguous matching", () => {
  for (const bad of ["a,a\nx,y", " ,x", "a,b\nx", 'id,v\n1,"bad', 'id\na"b'])
    assert.throws(() => csv(bad));
  assert.throws(
    () => compare(csv("id,v\n1,x\n1,y"), csv("id,v"), key),
    /repeats ID/,
  );
  assert.throws(
    () => compare(csv("id,v\n ,x"), csv("id,v"), key),
    /missing or invalid/,
  );
  assert.throws(() => compare(csv("other"), csv("id"), key), /no column/);
});
test("GeoJSON matches by ID and compares geometry, property presence, property names and types", () => {
  const a = geo([
    feature(
      5,
      { v: null, id: "attr", "@geometry": "x", nested: { a: 1, b: 2 } },
      { type: "Point", coordinates: [0, 1] },
    ),
  ]);
  const b = geo([
    feature(
      5,
      {
        v: "",
        id: "attr",
        "@geometry": "x",
        added: null,
        nested: { b: 2, a: 1 },
      },
      { type: "Point", coordinates: [1, 0] },
    ),
  ]);
  const c = compare(a, b, FEATURE_ID).changes[0];
  assert.deepEqual(
    c.fields.map((f) => [f.scope, f.field]),
    [
      ["property", "v"],
      ["property", "added"],
      ["feature", "geometry"],
    ],
  );
  assert.equal("before" in c.fields[1], false);
  assert.deepEqual(
    keyOptions(a, geo([]))
      .map((k) => k.value)
      .includes(propertyKey("v")),
    true,
  );
  assert.equal(
    compare(geo([feature("5", {})]), geo([feature(5, {})]), FEATURE_ID).counts
      .removed,
    1,
  );
  assert.throws(
    () =>
      parseDataset(
        '{"type":"FeatureCollection","features":[{"type":"Feature","id":999999999999999999,"properties":null,"geometry":null}]}',
      ),
    /safe precision/,
  );
});
test("schema and prototype-like properties compare safely and CSV exports are spreadsheet resistant", () => {
  const report = compare(
    csv("id,__proto__,old\n=x,1,a"),
    csv("id,__proto__,new\n=x,2,b"),
    key,
  );
  assert.deepEqual(
    report.changes[0].fields.map((f) => f.field),
    ["__proto__", "old", "new"],
  );
  const output = changesCsv(report);
  assert.match(output, /"'=x"/);
  assert.match(output, /__proto__/);
  assert.deepEqual(
    compare(csv("id,v\na,1\nb,2"), csv("v,id\n2,b\n1,a"), key).counts.unchanged,
    2,
  );
});

test("distinguishes null property sets and rejects malformed coordinates", () => {
  const r = compare(geo([feature(1, null)]), geo([feature(1, {})]), FEATURE_ID);
  assert.deepEqual(r.changes[0].fields, [
    { scope: "feature", field: "properties", before: null, after: {} },
  ]);
  assert.throws(
    () => geo([feature(1, {}, { type: "Point", coordinates: ["x", "y"] })]),
    /Invalid GeoJSON/,
  );
});
