export const MAX_BYTES = 32 * 1024 * 1024;
export const FEATURE_ID = '@id';
export const propertyKey = name => 'property:' + name;
const owns = (object, key) => Object.hasOwn(object, key);

function csvRows(text) {
  const rows = [];
  let row = [], value = '', quoted = false, closed = false, started = false;
  function endRow() {
    if (started || value || row.length) rows.push([...row, value]);
    row = []; value = ''; started = false; closed = false;
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else value += ch;
    } else if (ch === ',') {
      row.push(value); value = ''; closed = false; started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '"' && !value && !closed) {
      quoted = true; started = true;
    } else {
      if (closed || ch === '"') throw Error('Invalid CSV quoting near record ' + (rows.length + 1) + '.');
      value += ch; started = true;
    }
  }
  if (quoted) throw Error('A CSV quoted field is missing its closing quote.');
  endRow();
  return rows;
}

function validGeometry(geometry) {
  if (geometry === null) return true;
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return false;
  if (geometry.type === 'GeometryCollection') {
    return Array.isArray(geometry.geometries) && geometry.geometries.every(g => g !== null && validGeometry(g));
  }
  const depths = {Point:0, MultiPoint:1, LineString:1, MultiLineString:2, Polygon:2, MultiPolygon:3};
  if (!owns(depths, geometry.type)) return false;
  function positions(coords, depth) {
    if (!Array.isArray(coords)) return false;
    if (depth === 0) return coords.length >= 2 && coords.every(Number.isFinite);
    return coords.every(c => positions(c, depth - 1));
  }
  return positions(geometry.coordinates, depths[geometry.type]);
}

export function parseDataset(input, name = '') {
  const text = input.replace(/^\uFEFF/, '');
  const path = name.split(/[?#]/)[0].toLowerCase();
  const geo = /\.(geojson|json)$/.test(path) || (!path.endsWith('.csv') && text.trimStart().startsWith('{'));
  if (geo) {
    const data = JSON.parse(text, (_key, value) => {
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        throw Error('A JSON number exceeds safe precision. Encode large identifiers as strings.');
      }
      return value;
    });
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw Error('Expected a GeoJSON FeatureCollection.');
    const fields = new Set();
    const rows = data.features.map((f, i) => {
      if (f?.type !== 'Feature' || !owns(f, 'geometry') || !owns(f, 'properties') ||
          (f.properties !== null && (typeof f.properties !== 'object' || Array.isArray(f.properties))) ||
          !validGeometry(f.geometry)) {
        throw Error('Invalid GeoJSON feature at position ' + (i + 1) + '.');
      }
      Object.keys(f.properties ?? {}).forEach(key => fields.add(key));
      const row = { fields: f.properties, geometry: f.geometry };
      if (owns(f, 'id')) row.id = f.id;
      return row;
    });
    return { format: 'GeoJSON', fields: [...fields], rows };
  }
  const [fields, ...values] = csvRows(text);
  if (!fields || fields.some(f => !f.trim()) || new Set(fields).size !== fields.length) {
    throw Error('CSV needs one header row with unique, nonempty column names.');
  }
  const rows = values.map((r, i) => {
    if (r.length !== fields.length) throw Error('CSV record ' + (i + 2) + ' has ' + r.length + ' fields. Expected ' + fields.length + '.');
    return { fields: Object.fromEntries(fields.map((k, j) => [k, r[j]])) };
  });
  return { format: 'CSV', fields, rows };
}

export function keyOptions(before, after) {
  if (before.format !== after.format) throw Error('Both snapshots must have the same format.');
  const left = new Set(before.fields), right = new Set(after.fields);
  const fields = [...new Set([...left, ...right])].filter(k =>
    (left.has(k) || (before.format === 'GeoJSON' && !before.rows.length)) &&
    (right.has(k) || (after.format === 'GeoJSON' && !after.rows.length)));
  const preferred = /^(globalid|id|uid|uuid|record[_ ]?id|application[_ ]?id|objectid|fid)$/i;
  fields.sort((a, b) => Number(preferred.test(b)) - Number(preferred.test(a)) || a.localeCompare(b));
  const options = fields.map(name => ({ value: propertyKey(name), label: name }));
  if (before.format === 'GeoJSON') options.unshift({value: FEATURE_ID, label: 'Feature ID (top-level)'});
  return options;
}

function indexed(data, key, side) {
  if (key !== FEATURE_ID && !key.startsWith('property:')) throw Error('Choose a record ID.');
  if (key === FEATURE_ID && data.format !== 'GeoJSON') throw Error('CSV requires a column name as its key.');
  const field = key.slice(9);
  if (key !== FEATURE_ID && !data.fields.includes(field) && (data.format === 'CSV' || data.rows.length)) {
    throw Error(side + ' snapshot has no column named ' + field + '.');
  }
  const map = new Map();
  for (const [i, row] of data.rows.entries()) {
    const id = key === FEATURE_ID ? row.id : (row.fields && owns(row.fields, field) ? row.fields[field] : undefined);
    if ((typeof id !== 'number' && typeof id !== 'string') || (typeof id === 'string' && !id.trim())) {
      throw Error(side + ' snapshot has a missing or invalid key at record ' + (i + 1) + '. Select a populated string or numeric ID.');
    }
    const token = JSON.stringify(id);
    if (map.has(token)) throw Error(side + ' snapshot repeats ID ' + token.slice(0, 140) + '. Select a unique key.');
    map.set(token, {id, row});
  }
  return map;
}

export function validateKey(data, key) { indexed(data, key, 'Input'); }

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => owns(b,k) && equal(a[k], b[k]));
}

function recordChanges(a, b) {
  const out = [];
  function inspect(scope, field, source, target) {
    const hasBefore = owns(source, field), hasAfter = owns(target, field);
    if (hasBefore === hasAfter && equal(source[field], target[field])) return;
    const diff = {scope, field};
    if (hasBefore) diff.before = source[field];
    if (hasAfter) diff.after = target[field];
    out.push(diff);
  }
  const earlier = a.fields ?? {}, later = b.fields ?? {};
  if ((a.fields === null) !== (b.fields === null)) {
    out.push({scope:'feature', field:'properties', before:a.fields, after:b.fields});
  } else {
    for (const k of new Set([...Object.keys(earlier), ...Object.keys(later)])) inspect('property', k, earlier, later);
  }
  inspect('feature', 'id', a, b);
  inspect('feature', 'geometry', a, b);
  return out;
}

export function compare(before, after, key) {
  if (before.format !== after.format) throw Error('Both snapshots must have the same format.');
  const old = indexed(before, key, 'Earlier'), current = indexed(after, key, 'Later');
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  const changes = [];
  for (const [token, item] of old) {
    const next = current.get(token);
    if (!next) { counts.removed++; changes.push({kind:'removed',id:item.id,before:item.row}); continue; }
    const fields = recordChanges(item.row, next.row);
    if (fields.length) { counts.changed++; changes.push({kind:'changed',id:item.id,fields}); }
    else counts.unchanged++;
  }
  for (const [token, item] of current) {
    if (!old.has(token)) { counts.added++; changes.push({kind:'added',id:item.id,after:item.row}); }
  }
  return { format: before.format, key, earlierRecords: old.size, laterRecords: current.size, counts, changes };
}

export function changesCsv(report) {
  const rows = [['change', 'record_id', 'scope', 'field', 'earlier_json', 'later_json']];
  for (const c of report.changes) {
    if (c.kind === 'changed') {
      for (const f of c.fields) rows.push([c.kind, c.id, f.scope, f.field, JSON.stringify(f.before), JSON.stringify(f.after)]);
    } else rows.push([c.kind, c.id, 'record', '', JSON.stringify(c.before), JSON.stringify(c.after)]);
  }
  const cell = value => {
    let s = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"','""') + '"';
  };
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
