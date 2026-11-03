// Describe any parsed document as a JSON Schema (draft 2020-12) with examples, small enough for an LLM.
// Every value is read; nothing is sampled. Per node, following LIDA's summarizer: types, min/max,
// distinct count and a few real non-null examples. Repetition collapses: array items merge into one
// schema, and objects with many same-typed values (ID-keyed maps) merge into additionalProperties.
// Non-standard keywords use an x- prefix: x-count (occurrences), x-distinct (distinct values),
// x-numeric (range of numeric strings, as in XML or TSV) and x-omitted (branches cut for the budget).

export interface DescribeOptions {
  samples?: number;       // examples per node (default 3)
  enumLimit?: number;     // list every value as enum when there are at most this many (default 12)
  mapMinKeys?: number;    // an object with at least this many same-typed values is a map (default 20)
  distinctLimit?: number; // distinct scalar values tracked per node (default 1000)
  stringLimit?: number;   // characters kept per example string (default 80)
  maxChars?: number;      // output budget (default 80000, about 20k tokens)
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, unknown>;

interface Node {
  count: number;
  types: Set<string>;
  objects: number;
  properties: Map<string, { node: Node; present: number }>;
  map?: Node;
  mapKeys: string[];
  keyRange?: [number, number];
  items?: Node;
  lengthRange?: [number, number];
  valueRange?: [number, number];
  numericStrings: number;
  strings: number;
  distinct: Map<string, Json>;
  overflow: boolean;
  examples: { shape: string; value: Json }[];
}

const node = (): Node => ({ count: 0, types: new Set(), objects: 0, properties: new Map(), mapKeys: [], numericStrings: 0, strings: 0, distinct: new Map(), overflow: false, examples: [] });
const range = (current: [number, number] | undefined, value: number): [number, number] => current ? [Math.min(current[0], value), Math.max(current[1], value)] : [value, value];
const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
const numeric = /^\s*-?\d+(\.\d+)?\s*$/;

export function describe(document: unknown, options: DescribeOptions = {}): Schema {
  const { samples = 3, enumLimit = 12, mapMinKeys = 20, distinctLimit = 1000, stringLimit = 80, maxChars = 80000 } = options;

  // An object is a map (keyed by IDs, not field names) when at least 90% of its values are members:
  // with many values, members share one type; with three or more, members are objects sharing most keys.
  // Returns the membership test; non-members stay ordinary properties.
  const mapMember = (value: Record<string, unknown>): ((item: unknown) => boolean) | undefined => {
    const values = Object.values(value);
    const dominant = (member: (item: unknown) => boolean) => values.filter(member).length >= values.length * 0.9 ? member : undefined;
    if (values.length >= mapMinKeys) {
      const counts = new Map<string, number>();
      for (const item of values) counts.set(typeOf(item), (counts.get(typeOf(item)) ?? 0) + 1);
      const [type] = [...counts].sort((left, right) => right[1] - left[1])[0];
      return dominant(item => typeOf(item) === type);
    }
    const objects = values.filter(item => typeOf(item) === 'object') as object[];
    if (objects.length < 3) return undefined;
    for (const reference of objects.slice(0, 2).map(item => Object.keys(item)).filter(keys => keys.length)) {
      const member = dominant(item => typeOf(item) === 'object' && Object.keys(item as object).filter(key => reference.includes(key)).length >= 0.8 * Math.max(Object.keys(item as object).length, reference.length));
      if (member) return member;
    }
    return undefined;
  };
  const isMap = (value: Record<string, unknown>) => mapMember(value) !== undefined;
  // A bounded copy for examples: short strings, two items per array, three keys per map, limited depth.
  const clip = (value: unknown, depth = 0): Json => {
    if (typeof value === 'string') return value.length > stringLimit ? `${value.slice(0, stringLimit)}…` : value;
    if (value === null || typeof value !== 'object') return value as Json;
    if (depth >= 8) return Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) return value.slice(0, 2).map(item => clip(item, depth + 1));
    const entries = Object.entries(value);
    return Object.fromEntries((isMap(value as Record<string, unknown>) ? entries.slice(0, 3) : entries).map(([key, item]) => [key, clip(item, depth + 1)]));
  };

  function visit(target: Node, value: unknown): void {
    target.count++;
    target.types.add(typeOf(value));
    if (Array.isArray(value)) {
      target.lengthRange = range(target.lengthRange, value.length);
      target.items ??= node();
      for (const item of value) visit(target.items, item);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>, keys = Object.keys(record);
      target.keyRange = range(target.keyRange, keys.length);
      // Map members merge into one schema; any other keys stay ordinary properties.
      const member = mapMember(record);
      if (member) target.map ??= node();
      target.objects++;
      for (const key of keys) {
        if (member?.(record[key])) {
          if (target.mapKeys.length <= enumLimit && !target.mapKeys.includes(key)) target.mapKeys.push(key);
          visit(target.map!, record[key]);
          continue;
        }
        const property = target.properties.get(key) ?? { node: node(), present: 0 };
        property.present++;
        target.properties.set(key, property);
        visit(property.node, record[key]);
      }
      // Keep the first few instances; a new key set replaces a repeated one, so optional fields and variants appear.
      const shape = keys.join('\u0000'), kept = target.examples;
      if (kept.length < samples) kept.push({ shape, value: clip(record) });
      else if (!kept.some(example => example.shape === shape)) {
        for (let index = kept.length - 1; index > 0; index--) {
          if (kept.findIndex(example => example.shape === kept[index].shape) !== index) { kept[index] = { shape, value: clip(record) }; break; }
        }
      }
    } else if (value !== null) {
      if (typeof value === 'number') target.valueRange = range(target.valueRange, value);
      if (typeof value === 'string') {
        target.strings++;
        target.lengthRange = range(target.lengthRange, value.length);
        if (numeric.test(value)) { target.numericStrings++; target.valueRange = range(target.valueRange, Number(value)); }
      }
      const key = JSON.stringify(value);
      if (target.distinct.size < distinctLimit) target.distinct.set(key, value as Json);
      else if (!target.distinct.has(key)) target.overflow = true;
    }
  }

  function merge(into: Node, from: Node): void {
    into.count += from.count;
    into.objects += from.objects;
    into.strings += from.strings;
    into.numericStrings += from.numericStrings;
    into.overflow ||= from.overflow;
    for (const type of from.types) into.types.add(type);
    for (const [key, property] of from.properties) {
      const existing = into.properties.get(key);
      if (existing) { existing.present += property.present; merge(existing.node, property.node); } else into.properties.set(key, property);
    }
    for (const key of from.mapKeys) if (into.mapKeys.length <= enumLimit && !into.mapKeys.includes(key)) into.mapKeys.push(key);
    if (from.map) into.map ? merge(into.map, from.map) : into.map = from.map;
    if (from.items) into.items ? merge(into.items, from.items) : into.items = from.items;
    for (const name of ['keyRange', 'lengthRange', 'valueRange'] as const) {
      const value = from[name];
      if (value) into[name] = range(range(into[name], value[0]), value[1]);
    }
    for (const [key, value] of from.distinct) {
      if (into.distinct.size < distinctLimit) into.distinct.set(key, value);
      else if (!into.distinct.has(key)) into.overflow = true;
    }
    for (const example of from.examples) if (into.examples.length < samples && !into.examples.some(kept => kept.shape === example.shape)) into.examples.push(example);
  }

  // Map keys can also be spread across instances, a few IDs per object. Many same-typed fields that each
  // appear in under half of their parent's instances are such keys: fold them into one map schema.
  function fold(target: Node): void {
    const rare = [...target.properties].filter(([, property]) => property.present * 2 < target.objects);
    const sameType = new Set(rare.map(([, property]) => [...property.node.types].sort().join())).size === 1;
    if (target.objects > 1 && rare.length > enumLimit && sameType) {
      target.map ??= node();
      for (const [key, property] of rare) {
        merge(target.map, property.node);
        target.properties.delete(key);
        if (target.mapKeys.length <= enumLimit && !target.mapKeys.includes(key)) target.mapKeys.push(key);
      }
    }
    for (const property of target.properties.values()) fold(property.node);
    if (target.map) fold(target.map);
    if (target.items) fold(target.items);
  }

  // Whether a branch holds any number, including numeric strings; branches without one are cut first.
  const hasNumbers = (target: Node): boolean => target.types.has('integer') || target.types.has('number') || target.numericStrings > 0
    || [...target.properties.values()].some(property => hasNumbers(property.node)) || (!!target.map && hasNumbers(target.map)) || (!!target.items && hasNumbers(target.items));

  // examples: examples per node; prune: cut branches without numbers; covered: an ancestor already shows example records.
  function render(target: Node, examples: number, prune: boolean, covered = false): Schema {
    const types = [...target.types].filter(type => !(type === 'integer' && target.types.has('number')));
    const schema: Schema = { type: types.length === 1 ? types[0] : types, 'x-count': target.count };
    // A scalar that always holds one value is just that value.
    if (types.length === 1 && target.distinct.size === 1 && !target.overflow) return { ...schema, const: clip([...target.distinct.values()][0]) };
    if (prune && target.count && !hasNumbers(target) && (target.properties.size || target.map || target.items)) {
      const keys = [...target.properties.keys()];
      schema['x-omitted'] = { reason: 'no numbers in branch', ...(keys.length ? { keyCount: keys.length, keys: keys.slice(0, enumLimit) } : {}) };
      return schema;
    }
    const showRecords = !covered && examples > 0 && target.examples.length > 0 && target.count > 1;
    const childCovered = covered || showRecords;
    if (target.properties.size) {
      schema.properties = Object.fromEntries([...target.properties].map(([key, property]) => [key, render(property.node, examples, prune, childCovered)]));
      const required = [...target.properties].filter(([, property]) => property.present === target.objects).map(([key]) => key);
      if (required.length) schema.required = required;
    }
    // A few map keys are listed in full; many are shown by example.
    const keyNames = target.mapKeys.length <= enumLimit ? { enum: target.mapKeys } : { examples: target.mapKeys.slice(0, Math.max(examples, 1)) };
    if (target.map) Object.assign(schema, { propertyNames: keyNames, additionalProperties: render(target.map, examples, prune, childCovered) });
    if (target.keyRange) Object.assign(schema, { minProperties: target.keyRange[0], maxProperties: target.keyRange[1] });
    if (target.items) Object.assign(schema, target.items.count ? { items: render(target.items, examples, prune, childCovered) } : {}, { minItems: target.lengthRange![0], maxItems: target.lengthRange![1] });
    else if (target.lengthRange) Object.assign(schema, { minLength: target.lengthRange[0], maxLength: target.lengthRange[1] });
    if (target.valueRange && target.strings === 0) Object.assign(schema, { minimum: target.valueRange[0], maximum: target.valueRange[1] });
    if (target.valueRange && target.strings > 0 && target.numericStrings === target.strings) schema['x-numeric'] = { minimum: target.valueRange[0], maximum: target.valueRange[1] };
    if (target.distinct.size) {
      const values = [...target.distinct.values()];
      schema['x-distinct'] = target.overflow ? `>${distinctLimit}` : values.length;
      if (!target.overflow && values.length <= enumLimit && target.count > values.length) schema.enum = values;
      else if (examples && !covered) schema.examples = values.slice(0, examples).map(value => clip(value));
    }
    if (showRecords) schema.examples = target.examples.slice(0, examples).map(example => example.value);
    return schema;
  }

  const root = node();
  visit(root, document);
  fold(root);
  // Shrink until the budget fits: first cut branches without numbers, then use fewer examples.
  const steps = [{ examples: samples, prune: false }, ...Array.from({ length: samples + 1 }, (_, index) => ({ examples: samples - index, prune: true }))];
  let schema: Schema = {};
  for (const step of steps) {
    schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...render(root, step.examples, step.prune) };
    if (JSON.stringify(schema).length <= maxChars) break;
  }
  return schema;
}

export interface Compacted {
  kind: 'document' | 'schema'; // which one text holds
  text: string;
  schema?: Schema;             // present when kind is 'schema'
}

// Give an LLM whichever is smaller: the document itself, or its schema. Small or flat documents can
// produce a schema larger than the original, so always compare. Pass the original text when you have
// it (XML, TSV), so the comparison uses the real size; otherwise the document is serialized as JSON.
export function compact(document: unknown, options: DescribeOptions & { text?: string } = {}): Compacted {
  const { text = JSON.stringify(document), ...rest } = options;
  const schema = describe(document, rest), schemaText = JSON.stringify(schema);
  return text.length <= schemaText.length ? { kind: 'document', text } : { kind: 'schema', text: schemaText, schema };
}
