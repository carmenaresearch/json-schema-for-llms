// json-schema-for-llms 2: one schema per kind of document, small enough for an LLM and mergeable.
//
// describe(document)     reads every value of a document into a JSON Schema (draft 2020-12) with statistics and
//                        real examples. Exact within the document.
// merge(a, b)            one schema for everything a and b describe. Order and grouping do not change the statistics.
// fits(schema, other)    whether other (usually describe(document)) has fields schema has never seen (no model).
// compact(document)      the smaller of the document and its schema, ready for a prompt.
//
// The schema is the only state: there is nothing else to store. Statistics JSON Schema has no keyword for use an
// x- prefix. Every schema carries "x-format": FORMAT; merge() and fits() refuse anything else.

export const FORMAT = 'json-schema-for-llms/2';

export interface Options {
  samples?: number;       // example values or records kept per field (default 3)
  enumLimit?: number;     // a field with at most this many distinct short labels is a category (enum) (default 50)
  mapMinKeys?: number;    // an object with at least this many same-typed values is an ID-keyed map (default 20)
  distinctLimit?: number; // distinct values tracked per field within one document (default 1000)
  stringLimit?: number;   // characters kept per example string (default 80)
  maxChars?: number;      // size target; only examples are cut to meet it, never fields (default 80000)
}
type Settings = Required<Options>;
const settings = (options: Options): Settings => ({ samples: 3, enumLimit: 50, mapMinKeys: 20, distinctLimit: 1000, stringLimit: 80, maxChars: 80000, ...options });

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, any>;

const FOLD = 12;   // more rare same-typed fields than this are spread-out map keys (see fold)
const SCALARS = ['string', 'number', 'integer', 'boolean'];
const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
const numeric = /^\s*-?\d+(\.\d+)?\s*$/;
const range = (current: [number, number] | undefined, value: number): [number, number] => current ? [Math.min(current[0], value), Math.max(current[1], value)] : [value, value];
const step = (key: string) => /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

// ===== One document: exact statistics =====

interface Node {
  count: number;
  types: Map<string, number>;
  properties: Map<string, Node>;
  map?: Node;
  mapKeys: string[];
  keyRange?: [number, number];
  items?: Node;
  itemRange?: [number, number];
  lengthRange?: [number, number];
  numberRange?: [number, number];
  numericRange?: [number, number];
  strings: number;
  numericStrings: number;
  values: Map<string, { value: Json; count: number }>;
  overflow: boolean;
  records: Json[];
}
const node = (): Node => ({ count: 0, types: new Map(), properties: new Map(), mapKeys: [], strings: 0, numericStrings: 0, values: new Map(), overflow: false, records: [] });

// An object is an ID-keyed map when at least 90% of its values are members: with many values, members share one
// type; with three or more, members are objects sharing most keys. Returns the membership test.
function mapMember(value: Record<string, unknown>, o: Settings): ((item: unknown) => boolean) | undefined {
  const values = Object.values(value);
  const dominant = (member: (item: unknown) => boolean) => values.filter(member).length >= values.length * 0.9 ? member : undefined;
  if (values.length >= o.mapMinKeys) {
    const counts = new Map<string, number>();
    for (const item of values) counts.set(typeOf(item), (counts.get(typeOf(item)) ?? 0) + 1);
    const [type] = [...counts].sort((left, right) => right[1] - left[1])[0];
    return dominant(item => typeOf(item) === type);
  }
  const objectValues = values.filter(item => typeOf(item) === 'object') as object[];
  if (objectValues.length < 3) return undefined;
  for (const reference of objectValues.slice(0, 2).map(item => Object.keys(item)).filter(keys => keys.length)) {
    const member = dominant(item => typeOf(item) === 'object' && Object.keys(item as object).filter(key => reference.includes(key)).length >= 0.8 * Math.max(Object.keys(item as object).length, reference.length));
    if (member) return member;
  }
  return undefined;
}

// A bounded copy for examples: short strings, two items per array, three keys per map, limited depth.
function clip(value: unknown, o: Settings, depth = 0): Json {
  if (typeof value === 'string') return value.length > o.stringLimit ? `${value.slice(0, o.stringLimit)}…` : value;
  if (value === null || typeof value !== 'object') return value as Json;
  if (depth >= 8) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.slice(0, 2).map(item => clip(item, o, depth + 1));
  const entries = Object.entries(value);
  return Object.fromEntries((mapMember(value as Record<string, unknown>, o) ? entries.slice(0, 3) : entries).map(([key, item]) => [key, clip(item, o, depth + 1)]));
}

function visit(target: Node, value: unknown, o: Settings): void {
  const type = typeOf(value);
  target.count++;
  target.types.set(type, (target.types.get(type) ?? 0) + 1);
  if (Array.isArray(value)) {
    target.itemRange = range(target.itemRange, value.length);
    target.items ??= node();
    for (const item of value) visit(target.items, item, o);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>, keys = Object.keys(record);
    target.keyRange = range(target.keyRange, keys.length);
    const member = mapMember(record, o);
    if (member) target.map ??= node();
    for (const key of keys) {
      if (member?.(record[key])) {
        if (!target.mapKeys.includes(key) && target.mapKeys.length < o.samples) target.mapKeys.push(key);
        visit(target.map!, record[key], o);
        continue;
      }
      const property = target.properties.get(key) ?? node();
      target.properties.set(key, property);
      visit(property, record[key], o);
    }
    if (target.records.length < 4 * o.samples) target.records.push(clip(record, o));
  } else if (value !== null) {
    if (typeof value === 'number') target.numberRange = range(target.numberRange, value);
    if (typeof value === 'string') {
      target.strings++;
      target.lengthRange = range(target.lengthRange, value.length);
      if (numeric.test(value)) { target.numericStrings++; target.numericRange = range(target.numericRange, Number(value)); }
    }
    const key = JSON.stringify(value), seen = target.values.get(key);
    if (seen) seen.count++;
    else if (target.values.size < o.distinctLimit) target.values.set(key, { value: value as Json, count: 1 });
    else target.overflow = true;
  }
}

// ===== The schema =====

const types = (schema: Schema): string[] => [schema.type].flat().filter(Boolean);
// How many times each type appeared. One type: x-count; several: x-type-counts.
const typeCounts = (schema: Schema): Record<string, number> => schema['x-type-counts'] ?? (types(schema).length ? { [types(schema)[0]]: schema['x-count'] } : {});
const scalarCount = (schema: Schema) => Object.entries(typeCounts(schema)).filter(([type]) => SCALARS.includes(type)).reduce((sum, [, count]) => sum + count, 0);
const objectCount = (schema: Schema) => typeCounts(schema).object ?? 0;

// Sets type, x-count and x-type-counts from per-type counts. integer folds into number when both appear.
function setTypes(schema: Schema, counts: Record<string, number>): void {
  if (counts.integer && counts.number) { counts.number += counts.integer; delete counts.integer; }
  const names = Object.keys(counts);
  schema.type = names.length === 1 ? names[0] : names;
  schema['x-count'] = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (names.length > 1) schema['x-type-counts'] = counts; else delete schema['x-type-counts'];
}

// A category: at most enumLimit distinct values, all short labels (at most 40 characters and 4 words), so free text
// never is. Decided only by the set of values, which merging can only grow: the result does not depend on the order
// in which documents are merged.
function isCategory(values: { value: Json; count: number }[], o: Settings): boolean {
  return values.length > 0 && values.length <= o.enumLimit
    && values.every(({ value }) => typeof value !== 'string' || (value.length <= 40 && value.trim().split(/\s+/).length <= 4));
}

// The field's values, when the schema lists all of them, with how often each appeared: const, enum, or examples
// with x-frequency (a few values that are not yet a category). A field with no values lists none.
function listed(schema: Schema): { value: Json; count: number }[] | undefined {
  if (!scalarCount(schema)) return [];
  if ('const' in schema) return [{ value: schema.const, count: scalarCount(schema) }];
  const values = schema.enum ?? schema.examples;
  if (schema['x-frequency'] && values?.length === schema['x-frequency'].length) return values.map((value: Json, index: number) => ({ value, count: schema['x-frequency'][index] }));
  return undefined;
}
// How many distinct values: exact when listed, else x-distinct (a number, or [low, high] after merges).
function distinct(schema: Schema): [number, number] {
  const values = listed(schema);
  if (values) return [values.length, values.length];
  const known = schema['x-distinct'];
  return (known === undefined ? [0, 0] : Array.isArray(known) ? known : [known, known]) as [number, number];
}

// Writes the value statistics: const for a single value, enum (with x-frequency, most frequent first) for a
// category, otherwise x-distinct and a few example values.
function setValues(schema: Schema, values: { value: Json; count: number }[] | undefined, bounds: [number, number], examples: Json[], o: Settings, covered: boolean): void {
  delete schema.const; delete schema.enum; delete schema['x-frequency']; delete schema['x-distinct']; delete schema.examples;
  if (values && values.length === 1 && types(schema).length === 1) { schema.const = values[0].value; return; }
  if (values && isCategory(values, o)) {
    const sorted = values.map((entry, index) => ({ ...entry, index })).sort((left, right) => right.count - left.count || left.index - right.index);
    schema.enum = sorted.map(entry => entry.value);
    schema['x-frequency'] = sorted.map(entry => entry.count);
    return;
  }
  if (bounds[1] > 0) schema['x-distinct'] = bounds[0] === bounds[1] ? bounds[0] : bounds;
  // A few values, all of them known: list them with their frequencies, so the next merge stays exact.
  if (values && values.length <= o.samples) {
    schema.examples = values.map(entry => entry.value);
    schema['x-frequency'] = values.map(entry => entry.count);
    return;
  }
  const kept = [...new Map(examples.map(value => [JSON.stringify(value), value])).values()].slice(0, o.samples);
  if (!covered && kept.length) schema.examples = kept;
}

// Example records: one of each key set first, so optional fields and variants show, then the earliest ones.
function pickRecords(records: Json[], o: Settings): Json[] {
  const keySet = (record: Json) => record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record).join('\u0000') : JSON.stringify(record);
  const out: Json[] = [], seen = new Set<string>();
  for (const record of records) if (out.length < o.samples && !seen.has(keySet(record))) { out.push(record); seen.add(keySet(record)); }
  for (const record of records) if (out.length < o.samples && !out.includes(record)) out.push(record);
  return out;
}

// required: the fields present in every object instance (their x-count equals the parent's object count).
function setRequired(schema: Schema): void {
  const all = objectCount(schema);
  const required = Object.entries(schema.properties ?? {}).filter(([, property]) => (property as Schema)['x-count'] === all).map(([key]) => key);
  if (required.length) schema.required = required; else delete schema.required;
}

// One document's node as a schema. covered: an ancestor shows example records, so scalars here need none.
function render(target: Node, o: Settings, covered = false): Schema {
  const schema: Schema = {};
  setTypes(schema, Object.fromEntries(target.types));
  // Example records, unless the field also holds plain values: then examples list those (see setValues).
  const showRecords = !covered && target.records.length > 0 && target.count > 1 && target.values.size === 0;
  if (target.properties.size) schema.properties = Object.fromEntries([...target.properties].map(([key, property]) => [key, render(property, o, covered || showRecords)]));
  if (target.map) {
    schema.additionalProperties = render(target.map, o, covered || showRecords);
    schema.propertyNames = { examples: target.mapKeys };
  }
  if (target.keyRange) Object.assign(schema, { minProperties: target.keyRange[0], maxProperties: target.keyRange[1] });
  setRequired(schema);
  if (target.itemRange) Object.assign(schema, target.items?.count ? { items: render(target.items, o, covered || showRecords) } : {}, { minItems: target.itemRange[0], maxItems: target.itemRange[1] });
  if (target.lengthRange) Object.assign(schema, { minLength: target.lengthRange[0], maxLength: target.lengthRange[1] });
  if (target.numberRange) Object.assign(schema, { minimum: target.numberRange[0], maximum: target.numberRange[1] });
  if (target.strings && target.numericStrings === target.strings) schema['x-numeric'] = { minimum: target.numericRange![0], maximum: target.numericRange![1] };
  if (target.values.size) {
    const values = [...target.values.values()];
    setValues(schema, target.overflow ? undefined : values, target.overflow ? [o.distinctLimit, scalarCount(schema)] : [values.length, values.length], values.map(entry => clip(entry.value, o)), o, covered);
  }
  if (showRecords) schema.examples = pickRecords(target.records, o);
  return schema;
}

// ===== Merging =====

function addKey(schema: Schema, key: string, o: Settings): void {
  const names = schema.propertyNames ??= { examples: [] };
  if (!names.examples.includes(key) && names.examples.length < o.samples) names.examples.push(key);
}

// Map keys can be spread across instances, a few IDs per object. More than FOLD fields of one type, each present in
// under half of the object instances, are such keys: fold them into the map.
function fold(schema: Schema, o: Settings): void {
  const all = objectCount(schema), properties: Record<string, Schema> = schema.properties ?? {};
  const rare = Object.entries(properties).filter(([, property]) => property['x-count'] * 2 < all);
  if (all > 1 && rare.length > FOLD && new Set(rare.map(([, property]) => types(property).sort().join())).size === 1) {
    let map = schema.additionalProperties;
    for (const [key, property] of rare) {
      map = map ? join(map, property, o) : property;
      delete properties[key];
      addKey(schema, key, o);
    }
    schema.additionalProperties = map;
    if (!Object.keys(properties).length) delete schema.properties;
    setRequired(schema);
  }
  for (const child of [...Object.values(schema.properties ?? {}), schema.additionalProperties, schema.items]) if (child) fold(child as Schema, o);
}

// One field's statistics joined with another's (both schema nodes); a and b are not changed.
function join(a: Schema, b: Schema, o: Settings): Schema {
  const out: Schema = {};
  const counts = { ...typeCounts(a) };
  for (const [type, count] of Object.entries(typeCounts(b))) counts[type] = (counts[type] ?? 0) + count;
  setTypes(out, counts);
  for (const [low, high] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minProperties', 'maxProperties']]) {
    const lows = [a[low], b[low]].filter(value => value !== undefined), highs = [a[high], b[high]].filter(value => value !== undefined);
    if (lows.length) out[low] = Math.min(...lows);
    if (highs.length) out[high] = Math.max(...highs);
  }
  // Numeric strings stay numeric only when every string on both sides was.
  const strings = (schema: Schema) => (typeCounts(schema).string ?? 0) > 0;
  if ((a['x-numeric'] || !strings(a)) && (b['x-numeric'] || !strings(b)) && (a['x-numeric'] || b['x-numeric'])) {
    const sides = [a['x-numeric'], b['x-numeric']].filter(Boolean);
    out['x-numeric'] = { minimum: Math.min(...sides.map(side => side.minimum)), maximum: Math.max(...sides.map(side => side.maximum)) };
  }
  // Fields. Where one side is an ID-keyed map, the other side's fields it does not know and whose types fit the
  // map's values are more IDs: the same rule both ways, so the result does not depend on the order.
  const fitsMap = (map: Schema | undefined, property: Schema) => !!map && types(property).every(type => types(map).includes(type) || (type === 'integer' && types(map).includes('number')));
  const properties: Record<string, Schema> = {}, keys: string[] = [];
  let map: Schema | undefined = a.additionalProperties && b.additionalProperties ? join(a.additionalProperties, b.additionalProperties, o) : a.additionalProperties ?? b.additionalProperties;
  for (const [side, other] of [[a, b], [b, a]] as const) {
    for (const [key, property] of Object.entries((side.properties ?? {}) as Record<string, Schema>)) {
      if (properties[key] || keys.includes(key)) continue;
      const theirs = other.properties?.[key];
      if (theirs) properties[key] = join(property, theirs, o);
      else if (fitsMap(other.additionalProperties, property)) { map = map ? join(map, property, o) : property; keys.push(key); }
      else properties[key] = property;
    }
  }
  if (Object.keys(properties).length) out.properties = properties;
  if (map) {
    out.additionalProperties = map;
    out.propertyNames = { examples: [...new Set([...(a.propertyNames?.examples ?? []), ...(b.propertyNames?.examples ?? []), ...keys])].slice(0, o.samples) };
  }
  setRequired(out);
  if (a.items || b.items) out.items = a.items && b.items ? join(a.items, b.items, o) : a.items ?? b.items;
  // Values: exact when both sides list theirs; otherwise [low, high], since the overlap is unknown.
  if (scalarCount(out)) {
    const listA = listed(a), listB = listed(b);
    let values: { value: Json; count: number }[] | undefined;
    if (listA && listB) {
      const union = new Map<string, { value: Json; count: number }>();
      for (const entry of [...listA, ...listB]) {
        const key = JSON.stringify(entry.value), seen = union.get(key);
        if (seen) seen.count += entry.count; else union.set(key, { ...entry });
      }
      values = [...union.values()];
    }
    const [lowA, highA] = distinct(a), [lowB, highB] = distinct(b);
    const bounds: [number, number] = values ? [values.length, values.length] : [Math.max(lowA, lowB), Math.min(highA + highB, scalarCount(out))];
    const scalarExamples = (side: Schema) => listed(side)?.map(entry => entry.value) ?? (scalarCount(side) ? side.examples ?? [] : []);
    const covered = !(scalarExamples(a).length || scalarExamples(b).length);
    setValues(out, values, bounds, [...scalarExamples(a), ...scalarExamples(b)], o, covered);
  }
  const recordExamples = (side: Schema) => objectCount(side) && !scalarCount(side) ? side.examples ?? [] : [];
  if (objectCount(out) && !scalarCount(out) && (recordExamples(a).length || recordExamples(b).length)) out.examples = pickRecords([...recordExamples(a), ...recordExamples(b)], o);
  return out;
}

// ===== Budget =====

// Cuts examples until the schema fits maxChars; field names, types and counts are never cut.
function budget(schema: Schema, o: Settings): Schema {
  for (let keep = o.samples - 1; keep >= 0 && JSON.stringify(schema).length > o.maxChars; keep--) {
    const cut = (target: Schema) => {
      if (Array.isArray(target.examples) && target.examples.length > keep) {
        if (keep) target.examples = target.examples.slice(0, keep); else delete target.examples;
        if (!target.enum) delete target['x-frequency'];   // the values are no longer all listed
      }
      if (target.propertyNames) target.propertyNames.examples = target.propertyNames.examples.slice(0, keep);
      for (const child of [...Object.values(target.properties ?? {}), target.additionalProperties, target.items]) if (child) cut(child as Schema);
    };
    cut(schema);
  }
  return schema;
}

const root = (body: Schema, o: Settings): Schema => budget({ $schema: 'https://json-schema.org/draft/2020-12/schema', 'x-format': FORMAT, ...body }, o);
const check = (schema: Schema) => {
  if (schema?.['x-format'] !== FORMAT) throw new Error(`Not a ${FORMAT} schema: describe the documents again with this version`);
};

// ===== API =====

export function describe(document: unknown, options: Options = {}): Schema {
  const o = settings(options), top = node();
  visit(top, document, o);
  const schema = render(top, o);
  fold(schema, o);
  return root(schema, o);
}

// One schema for everything a and b describe. Counts add, ranges widen, types unite, categories add their
// frequencies. Distinct counts stay exact where both sides list their values, and become [low, high] otherwise.
export function merge(a: Schema, b: Schema, options: Options = {}): Schema {
  check(a); check(b);
  const o = settings(options), strip = ({ $schema, 'x-format': format, ...body }: Schema) => body;
  const schema = join(strip(a), strip(b), o);
  fold(schema, o);
  return root(schema, o);
}

export interface Fit {
  fits: boolean;      // no field path the schema lacks
  added: string[];    // paths the schema has never seen: these make the document not fit
  missing: string[];  // paths the document lacks (optional fields): no effect on fits
  widened: string[];  // known paths where the document has a type the schema has not seen there
}

// Whether what other describes stays within what schema has seen: other is usually describe(document), made once
// and compared with as many schemas as needed. Paths are JSONPath style, with [*] for array items and {*} for an
// ID-keyed map's values (its keys are data). Only new paths make it not fit.
export function fits(schema: Schema, other: Schema): Fit {
  check(schema); check(other);
  const paths = (target: Schema, path = '$', out = new Map<string, Schema>()) => {
    out.set(path, target);
    for (const [key, property] of Object.entries((target.properties ?? {}) as Record<string, Schema>)) paths(property, path + step(key), out);
    if (target.additionalProperties) paths(target.additionalProperties, `${path}{*}`, out);
    if (target.items) paths(target.items, `${path}[*]`, out);
    return out;
  };
  const before = paths(schema), after = paths(merge(schema, other, { maxChars: Infinity }));
  const added: string[] = [], missing: string[] = [], widened: string[] = [];
  for (const [path, now] of after) {
    const was = before.get(path);
    if (!was) added.push(path);
    else if (now['x-count'] === was['x-count']) missing.push(path);
    else if (types(now).some(type => !types(was).includes(type) && !(type === 'number' && types(was).includes('integer')))) widened.push(path);
  }
  return { fits: added.length === 0, added, missing, widened };
}

export interface Compacted {
  kind: 'document' | 'schema'; // which one text holds
  text: string;
  schema?: Schema;             // present when kind is 'schema'
}

// The smaller of the document and its schema. Pass the original text (XML, TSV) so the comparison uses its real size.
export function compact(document: unknown, options: Options & { text?: string } = {}): Compacted {
  const { text = JSON.stringify(document), ...rest } = options;
  const schema = describe(document, rest), schemaText = JSON.stringify(schema);
  return text.length <= schemaText.length ? { kind: 'document', text } : { kind: 'schema', text: schemaText, schema };
}
