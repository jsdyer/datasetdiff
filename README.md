# Dataset Diff

[Compare two snapshots in your browser](https://coolcode.ca/datasetdiff/) · [CoolCode catalogue](https://coolcode.ca/)

Choose an earlier and a later CSV or GeoJSON file, then select a stable record ID. Inspect added, removed and changed records, expand the before/after values and download JSON or a flat CSV. The built-in comparison opens two small CSVs drawn from the original Nova Scotia bridge-inspection disclosures. The extracts contain the same nine structures, ANN001–ANN009, from the first Annapolis page in each release. They retain each finalised Level 1 overall rating. Download the [2020 extract](web/inspections/Annapolis-Level-1-2020.csv) and [2023 extract](web/inspections/Annapolis-Level-1-2023.csv), or read [the 2020 release, PDF p. 2](https://openinformation.novascotia.ca/api/views/8psg-54u5/files/d1162ffb-acd0-4911-8983-5074ef4c8bd9?download=true&filename=2020-00906-TIR_PublicPackage.pdf#page=2) and [the 2023 release, PDF p. 3](https://openinformation.novascotia.ca/download/5twe-uvhv/application/pdf#page=3). Province of Nova Scotia, Transportation and Infrastructure Renewal and Public Works. The browser processes files locally in a worker and keeps no user data between visits. It requires no account or installation.

<!-- coolcode:guide -->
Compare the 2020 and 2023 Nova Scotia bridge releases by record_id. Four of the nine Annapolis County bridges changed Level 1 rating. Open ANN002 to see Anderson Brook Bridge move from 3 to 2.
<!-- /coolcode:guide -->

## Matching rules

- Files must share a format. CSV uses UTF-8, comma delimiters, one unique header per column and standard double-quote escaping. Multiline quoted fields are supported. Blank lines outside records are skipped. Spaces, leading zeros, blank values and case matter.
- GeoJSON accepts a FeatureCollection. Match on a top-level feature ID or a shared scalar property. String and numeric IDs remain distinct. A missing, blank, duplicate or non-scalar key stops comparison. String-encode integer identifiers outside JavaScript's safe range before importing.
- Field and record order can change without producing an edit. The report distinguishes missing properties from JSON null, and compares nested fields and geometry exactly. A geometry difference may reflect rounding, vertex order or a changed survey. Coordinate equality uses the values as supplied.
- The browser labels the local file modification date separately from publisher dates. The JSON report holds file names and modification times, IDs, record-level additions/removals, before/after field values, feature metadata and counts. The change CSV contains one line per edited field or added/removed record. An empty before/after CSV cell indicates an absent value. JSON null appears as `null`. The CSV prefixes spreadsheet formula-like cells with an apostrophe. Use JSON when exact unescaped keys matter.
- Each input may contain up to 32 MiB of UTF-8 text. Selecting the same file twice is valid. Empty CSV exports must retain their header, and an empty GeoJSON snapshot must contain an empty features array.
- A change records what differed between two retrieved snapshots. The observation times indicate when the collector retrieved a version. The publisher may supply its own event dates, survey dates or coverage periods.

## Linux companion

The companion uses **Node.js 24+** and its bundled SQLite driver. No database service or npm dependencies are required. The browser and CLI import the same parser and comparator.

Install into your user account with Git, Node.js and npm:

```sh
git clone https://github.com/jsdyer/datasetdiff.git
cd datasetdiff
npm install --global --prefix "$HOME/.local" .
export PATH="$HOME/.local/bin:$PATH"
datasetdiff --help
```

You can also run `node cli/datasetdiff.mjs` from the checkout. Keep the checkout in place when npm installs it as a local symlink.

Collect a CSV named `permits.csv` from the current directory. Run this again after replacing the file with an updated export:

```sh
datasetdiff collect --db permits.sqlite --name permits --source ./permits.csv --key permit_id
datasetdiff history --db permits.sqlite --name permits
datasetdiff diff --db permits.sqlite --name permits > changes.json
datasetdiff diff --db permits.sqlite --name permits --from 1 --to 2 --format csv > changes.csv
```

Use an HTTPS download URL as `--source` to fetch an agency's export. Use `--feature-id` in place of `--key` to match GeoJSON's top-level feature IDs. The collector validates the keys before writing. Each series retains its source, format and key. Choose a new series name when any of these changes.

SQLite stores compressed original bytes and a SHA-256 digest per distinct body. Consecutive identical downloads update the last-check timestamp. A return to an earlier version creates a new observation referencing the existing body. Invalid downloads or duplicate keys leave history intact. Collection uses one short-lived process and a write transaction per run. Concurrent collectors sharing a database wait up to 60 seconds and may be retried.

### Schedule daily collection

Create the data and log directory and confirm `node` and `datasetdiff` are on your cron PATH. Add the following using `crontab -e`, replacing the example account, executable location, local file and ID column with your own. The schedule uses the host's local time. The source can also be an HTTPS export.

```cron
PATH=/home/alex/.local/bin:/usr/local/bin:/usr/bin:/bin
15 6 * * * /home/alex/.local/bin/datasetdiff collect --db /home/alex/data/history.sqlite --name permits --source /home/alex/data/permits.csv --key permit_id >> /home/alex/data/datasetdiff.log 2>&1
```

Use private filesystem permissions for snapshots containing personal or unpublished data. The scheduled process reads the configured source and writes only to the local SQLite database and your chosen log.

## Develop

Run `node --test tests/*.test.mjs`, `python3 -m unittest discover -s tests -v`, then `python3 scripts/build.py`. The static browser tool is written to `dist/`. GitHub Actions also checks file selection, downloads, validation and responsive layout in Chromium before publishing main to GitHub Pages.
