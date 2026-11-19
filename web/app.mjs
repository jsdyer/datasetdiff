const $ = (id) => document.getElementById(id);
const sides = ["old", "new"];
const chosen = [null, null];
const releaseSources = new WeakMap();
const size = 25;
let worker,
  sequence = 0,
  start = 0;
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
function ask(action, values = {}) {
  worker.postMessage({ action, sequence: ++sequence, ...values });
}
function page() {
  $("prev").disabled = $("next").disabled = true;
  ask("page", {
    start,
    limit: size,
    search: $("search").value.trim(),
    kind: $("kind").value,
  });
}
function cell(label, present, value) {
  const box = element("div", undefined, "value");
  const full = present ? JSON.stringify(value, null, 2) : "(absent)";
  box.append(
    element("small", label),
    element(
      "pre",
      full.length > 1500
        ? full.slice(0, 1500) + "… (full value in JSON)"
        : full,
    ),
  );
  return box;
}
function drawRow(row) {
  const details = element("details");
  const summary = element("summary");
  summary.append(
    element("span", row.kind, "badge " + row.kind),
    element("span", JSON.stringify(row.id)),
  );
  details.append(summary);
  if (row.fields) {
    for (const f of row.fields) {
      const box = element("div", undefined, "field");
      const pair = element("div", undefined, "pair");
      pair.append(
        cell("Earlier", Object.hasOwn(f, "before"), f.before),
        cell("Later", Object.hasOwn(f, "after"), f.after),
      );
      box.append(
        element(
          "div",
          (f.scope === "feature" ? "Feature · " : "") + f.field,
          "field-name",
        ),
        pair,
      );
      details.append(box);
    }
  } else {
    const added = row.kind === "added";
    details.append(
      cell(
        added ? "Later record" : "Earlier record",
        true,
        added ? row.after : row.before,
      ),
    );
  }
  return details;
}
function receive({ data }) {
  if (data.sequence !== sequence) return;
  if (data.type === "error") {
    status(data.message, true);
    $("results").hidden = true;
    return;
  }
  if (data.type === "loaded") {
    const select = $("key");
    select.replaceChildren(new Option("Choose a stable ID…", ""));
    for (const opt of data.keys) select.add(new Option(opt.label, opt.value));
    select.disabled = !data.keys.length;
    select.value = data.preferred;
    $("compare").disabled = !select.value;
    data.meta.forEach(
      (m, i) =>
        ($(sides[i] + "-meta").textContent =
          m.format +
          " · " +
          m.count.toLocaleString() +
          " records · " +
          (m.release ? m.release.title : "file modified " + m.fileModified.slice(0, 10) + " UTC")),
    );
    status(
      data.keys.length
        ? "Check the record ID, then compare the two snapshots."
        : "No common field names. Choose exports with a shared ID column.",
    );
  } else if (data.type === "summary") {
    $("results").hidden = false;
    $("stats").replaceChildren(
      ...Object.entries(data.counts).map(([kind, count]) => {
        const box = element("div", undefined, "stat");
        box.append(
          element("strong", count.toLocaleString()),
          element("small", kind),
        );
        return box;
      }),
    );
    $("kind").value = "all";
    $("search").value = "";
    start = 0;
    page();
    status("Comparison complete. Both files were processed locally.");
  } else if (data.type === "page") {
    $("entries").replaceChildren(...data.rows.map(drawRow));
    $("range").textContent = data.total
      ? start +
        1 +
        "–" +
        Math.min(start + size, data.total) +
        " of " +
        data.total.toLocaleString()
      : "No matching changes";
    $("prev").disabled = start === 0;
    $("next").disabled = start + size >= data.total;
  } else if (data.type === "download") {
    const url = URL.createObjectURL(data.blob),
      a = element("a");
    a.href = url;
    a.download = "dataset-diff." + data.format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
function reload() {
  worker?.terminate();
  sequence++;
  $("results").hidden = true;
  $("key").replaceChildren(new Option("Choose two snapshots first", ""));
  $("key").disabled = true;
  $("compare").disabled = true;
  sides.forEach((s, i) => {
    $(s + "-name").textContent = chosen[i]?.name || "Choose or drop a file";
    $(s + "-meta").textContent = "CSV or GeoJSON · up to 32 MiB";
  });
  if (!chosen.every(Boolean)) {
    status(
      chosen.some(Boolean)
        ? "Choose the other snapshot to continue."
        : "Your files stay in this browser tab.",
    );
    return;
  }
  worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    type: "module",
  });
  worker.onmessage = receive;
  worker.onerror = () =>
    status(
      "The comparison worker stopped. Reopen your files and try again.",
      true,
    );
  ask("load", { files: chosen, releases: chosen.map(file => releaseSources.get(file) ?? null) });
  status("Reading both snapshots locally…");
}
sides.forEach((s, i) => {
  const input = $(s + "-file"),
    zone = $(s + "-zone");
  input.onchange = () => {
    if (input.files[0]) {
      chosen[i] = input.files[0];
      reload();
    }
  };
  zone.ondragover = (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  };
  zone.ondragleave = () => zone.classList.remove("drag");
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (e.dataTransfer.files.length === 1) {
      chosen[i] = e.dataTransfer.files[0];
      reload();
    } else status("Drop one file in each snapshot slot.", true);
  };
});
$("key").onchange = () => {
  sequence++;
  $("compare").disabled = !$("key").value;
  $("results").hidden = true;
  status("Ready to compare using the selected ID.");
};
$("compare").onclick = () => {
  $("results").hidden = true;
  status("Comparing records…");
  ask("compare", { key: $("key").value });
};
$("kind").onchange = $("search").oninput = () => {
  start = 0;
  page();
};
$("prev").onclick = () => {
  start = Math.max(0, start - size);
  page();
};
$("next").onclick = () => {
  start += size;
  page();
};
for (const format of ["csv", "json"])
  $(format).onclick = () => ask("export", { format });
$("clear").onclick = () => {
  chosen.fill(null);
  sides.forEach((s) => ($(s + "-file").value = ""));
  reload();
};
const editions = [
  { year: 2020, title: "2020-00906-TIR, PDF page 2", url: "https://openinformation.novascotia.ca/d/8psg-54u5" },
  { year: 2023, title: "2023-01020-DPW, PDF page 3", url: "https://openinformation.novascotia.ca/d/5twe-uvhv" },
];

$("bridge-editions").onclick = async () => {
  const ticket = sequence;
  const button = $("bridge-editions");
  button.disabled = true;
  status("Opening both bridge inspection extracts…");
  try {
    const files = await Promise.all(editions.map(async edition => {
      const name = `Annapolis-Level-1-${edition.year}.csv`;
      const response = await fetch("./inspections/" + name);
      if (!response.ok) throw Error("The inspection extracts could not be loaded. Try again or choose two files.");
      const file = new File([await response.blob()], name, { type: "text/csv" });
      releaseSources.set(file, edition);
      return file;
    }));
    if (sequence !== ticket) return;
    chosen.splice(0, chosen.length, ...files);
    reload();
  } catch (error) {
    if (sequence === ticket) status(error.message, true);
  } finally {
    button.disabled = false;
  }
};
