import {
  MAX_BYTES,
  parseDataset,
  keyOptions,
  compare,
  changesCsv,
} from "./model.mjs";

let before, after, report, fileInfo;
async function load(file) {
  if (file.size > MAX_BYTES)
    throw Error(file.name + " exceeds the 32 MiB per-file limit.");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw Error(file.name + " could not be read as UTF-8 text.");
  }
  return parseDataset(source, file.name);
}

self.onmessage = async ({ data }) => {
  const { action, sequence } = data;
  const send = (type, values) =>
    self.postMessage({ type, sequence, ...values });
  try {
    if (action === "load") {
      [before, after] = await Promise.all(data.files.map(load));
      fileInfo = data.files.map((f) => ({
        name: f.name,
        fileModified: new Date(f.lastModified).toISOString(),
      }));
      const keys = keyOptions(before, after);
      const preferred =
        keys.find(
          (k) =>
            k.value === "@id" &&
            [before, after].every((d) =>
              d.rows.every((r) => r.id !== undefined),
            ),
        ) ??
        keys.find((k) =>
          /^(globalid|id|uuid|uid|record[_ ]?id|application[_ ]?id|permit[_ ]?id|fid)$/i.test(
            k.label,
          ),
        );
      send("loaded", {
        keys,
        preferred: preferred?.value || "",
        meta: [before, after].map((d, i) => ({
          fileModified: fileInfo[i].fileModified,
          format: d.format,
          count: d.rows.length,
        })),
      });
    } else if (action === "compare") {
      report = null;
      report = { ...compare(before, after, data.key), files: fileInfo };
      send("summary", { counts: report.counts });
    } else if (action === "page") {
      const filtered = report.changes.filter(
        (c) =>
          (data.kind === "all" || c.kind === data.kind) &&
          String(c.id).toLowerCase().includes(data.search.toLowerCase()),
      );
      send("page", {
        rows: filtered.slice(data.start, data.start + data.limit),
        total: filtered.length,
      });
    } else if (action === "export") {
      const csv = data.format === "csv";
      const content = csv
        ? changesCsv(report)
        : JSON.stringify(report, null, 2);
      send("download", {
        blob: new Blob([content], {
          type: csv ? "text/csv;charset=utf-8" : "application/json",
        }),
        format: data.format,
      });
    }
  } catch (error) {
    send("error", { message: error.message });
  }
};
