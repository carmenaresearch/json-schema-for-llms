import { describe as group, expect, test } from 'bun:test';
import { getEncoding } from 'js-tiktoken';
import { compact, describe, fits, FORMAT, merge, type Schema } from '../src/index';

const all = (documents: unknown[]) => documents.map(document => describe(document)).reduce((a, b) => merge(a, b));
const warehouse = (name: string, stock: unknown, extra: Record<string, unknown> = {}) => ({ warehouse: name, stock, aisles: 3, ...extra });
const ids = (count: number, start = 0) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${start + index}`, { stock: index }]));

group('describe', () => {
  test('reads every value and collapses array items into one schema', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: index, label: `row ${index}`, score: index % 7 }));
    const schema: Schema = describe({ rows });
    const items = schema.properties.rows.items;
    expect(schema['x-format']).toBe(FORMAT);
    expect(items['x-count']).toBe(5000);
    expect(items.properties.id).toMatchObject({ type: 'integer', minimum: 0, maximum: 4999, 'x-distinct': [1000, 5000] });
    expect(items.required).toEqual(['id', 'label', 'score']);
    expect(items.examples[0]).toEqual({ id: 0, label: 'row 0', score: 0 });
  });

  test('categories are listed with frequencies, most frequent first, beyond any small fixed limit', () => {
    const plans = ['FREE', 'PRO', 'TEAM', 'EDU', 'ENT'], regions = Array.from({ length: 30 }, (_, index) => `R${index}`);
    const rows = Array.from({ length: 600 }, (_, index) => ({ plan: plans[index % 7 < 3 ? 0 : index % 5], region: regions[index % 30] }));
    const schema: Schema = describe(rows);
    expect(schema.items.properties.plan.enum[0]).toBe('FREE');
    expect(schema.items.properties.plan['x-frequency'].reduce((a: number, b: number) => a + b)).toBe(600);
    expect(schema.items.properties.region.enum).toHaveLength(30);
  });

  test('free text and identifiers are not categories', () => {
    const notes = ['Customer asked for a refund by email', 'Parcel left with a neighbour after two attempts', 'No issues reported'];
    const schema: Schema = describe(Array.from({ length: 80 }, (_, index) => ({ note: notes[index % 3], id: `v-${index}` })));
    expect(schema.items.properties.note.enum).toBeUndefined();
    expect(schema.items.properties.note['x-distinct']).toBe(3);
    expect(schema.items.properties.id.enum).toBeUndefined();
    expect(schema.items.properties.id['x-distinct']).toBe(80);
  });

  test('treats many same-typed values as a map keyed by ID', () => {
    const schema: Schema = describe({ ...ids(50), updatedAt: '2026-01-01' });
    expect(schema.additionalProperties['x-count']).toBe(50);
    expect(schema.propertyNames.examples).toEqual(['p0', 'p1', 'p2']);
    expect(schema.properties.updatedAt.const).toBe('2026-01-01');
  });

  test('folds ID keys that are spread across instances into one map', () => {
    const groups = Array.from({ length: 30 }, (_, index) => ({ members: { [`m${index}a`]: { size: index }, [`m${index}b`]: { size: index + 1 } } }));
    const members: Schema = describe(groups).items.properties.members;
    expect(members.properties).toBeUndefined();
    expect(members.additionalProperties['x-count']).toBe(60);
  });

  test('reports numeric strings, as XML and TSV parsers produce', () => {
    expect(describe([{ qty: '12' }, { qty: '7' }, { qty: '40' }]).items.properties.qty['x-numeric']).toEqual({ minimum: 7, maximum: 40 });
  });

  test('the size budget cuts examples, never fields', () => {
    const rows = Array.from({ length: 200 }, (_, index) => Object.fromEntries([...Array.from({ length: 15 }, (_, field) => [`field_${field}`, `text ${'x'.repeat(60)} ${index}`]), ['n', index]]));
    const schema: Schema = describe(rows, { maxChars: 3000 });
    expect(Object.keys(schema.items.properties)).toHaveLength(16);
    expect(JSON.stringify(schema)).not.toContain('"examples":[{');
  });

  test('handles empty and scalar documents', () => {
    expect(describe([])).toMatchObject({ type: 'array', minItems: 0, maxItems: 0 });
    expect(describe('x')).toMatchObject({ type: 'string', const: 'x' });
    expect(describe(null)).toMatchObject({ type: 'null' });
  });
});

group('merge', () => {
  const documents = [warehouse('Leeds', null), warehouse('York', 812, { updated: '21:04' }), warehouse('Bath', 77), warehouse('Hull', '1,204')];
  const drop = ({ examples, ...rest }: Schema): Schema => Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? drop(value) : value]));

  test('a field null in one document and a number in another has both types', () => {
    const stock = all(documents.slice(0, 2)).properties.stock;
    expect(stock.type).toEqual(['null', 'integer']);
    expect(stock['x-type-counts']).toEqual({ null: 1, integer: 1 });
  });

  test('a field in only some documents is optional', () => {
    const schema = all(documents);
    expect(schema.required).toEqual(['warehouse', 'stock', 'aisles']);
    expect(schema.properties.updated['x-count']).toBe(1);
  });

  test('order and grouping do not change the statistics', () => {
    const [a, b, c, d] = documents.map(document => describe(document));
    const one = drop(merge(merge(merge(a, b), c), d)), two = drop(merge(merge(a, b), merge(c, d))), three = drop(merge(d, merge(c, merge(b, a))));
    const sortTypes = (schema: Schema) => JSON.parse(JSON.stringify(schema, (key, value) => key === 'type' && Array.isArray(value) ? [...value].sort() : value));
    expect(sortTypes(two)).toEqual(sortTypes(one));
    expect(sortTypes(three).properties.stock['x-count']).toBe(4);
    expect(sortTypes(three).properties.stock.type).toEqual(sortTypes(one).properties.stock.type);
  });

  test('categories add their frequencies and can become text', () => {
    const plan = (values: string[]) => describe(values.map(value => ({ plan: value })));
    const merged = merge(plan(['FREE', 'FREE', 'PRO', 'PRO']), plan(['FREE', 'FREE', 'TEAM', 'TEAM'])).items.properties.plan;
    expect(merged.enum).toEqual(['FREE', 'PRO', 'TEAM']);
    expect(merged['x-frequency']).toEqual([4, 2, 2]);
  });

  test('distinct counts are exact when values are listed, and bounds otherwise', () => {
    const idsOf = (start: number, count: number) => describe(Array.from({ length: count }, (_, index) => ({ id: `v${start + index}` })));
    expect(merge(idsOf(0, 30), idsOf(20, 30)).items.properties.id.enum).toHaveLength(50);      // both listed: exact
    expect(merge(idsOf(0, 60), idsOf(40, 60)).items.properties.id['x-distinct']).toEqual([60, 120]); // neither: bounds
  });

  test('a document with a few IDs joins the map earlier documents established', () => {
    const merged = merge(describe({ products: ids(30) }), describe({ products: { p99: { stock: 5 }, p100: { stock: 6 } } }));
    expect(merged.properties.products.properties).toBeUndefined();
    expect(merged.properties.products.additionalProperties['x-count']).toBe(32);
  });

  test('refuses schemas from another version', () => {
    expect(() => merge({ type: 'object' }, describe({}))).toThrow(FORMAT);
  });
});

group('fits', () => {
  const base = describe({ region: 'North', products: ids(30), updated: null });

  test('new IDs, missing optional fields and widened types still fit', () => {
    expect(fits(base, describe({ region: 'North', products: ids(2, 500), updated: '21:04' }))).toEqual({ fits: true, added: [], missing: [], widened: ['$.updated'] });
    expect(fits(base, describe({ region: 'South', products: ids(25, 40) }))).toMatchObject({ fits: true, missing: ['$.updated'] });
  });

  test('a new field does not fit, wherever it appears', () => {
    expect(fits(base, describe({ region: 'North', products: ids(30), updated: null, discontinued: true }))).toMatchObject({ fits: false, added: ['$.discontinued'] });
    const nested = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, { stock: index, price: 0.5 }]));
    expect(fits(base, describe({ region: 'North', products: nested, updated: null })).added).toEqual(['$.products{*}.price']);
    expect(fits(describe({ rows: [{ a: 1 }] }), describe({ rows: [{ a: 1, b: 2 }], 'odd key': 1 })).added).toEqual(['$.rows[*].b', '$["odd key"]']);
  });

  test('a document fits a schema it was merged into', () => {
    const document = { region: 'East', products: ids(10, 70), updated: 'now' };
    expect(fits(merge(base, describe(document)), describe(document)).fits).toBe(true);
  });
});

group('compact', () => {
  test('returns the document when it is smaller than its schema', () => {
    expect(compact({ status: 'ok', count: 3 })).toEqual({ kind: 'document', text: '{"status":"ok","count":3}' });
  });

  test('returns the schema when it is smaller than the document', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ id: index, value: index * 2 }));
    const result = compact(rows);
    expect(result.kind).toBe('schema');
    expect(result.text.length).toBeLessThan(JSON.stringify(rows).length);
  });

  test('compares against the original text when given', () => {
    const text = '<r><v>1</v></r>';
    expect(compact({ r: { v: '1' } }, { text })).toEqual({ kind: 'document', text });
  });
});

group('README figures', () => {
  test('20,000 orders: 936,288 tokens of JSON become a 541-token schema', () => {
    const statuses = ['paid', 'pending', 'refunded'];
    const orders = Array.from({ length: 20000 }, (_, i) => ({ id: `ord_${100000 + i}`, status: statuses[i % 3], total: Math.round((i * 37) % 50000) / 100,
      items: Array.from({ length: 1 + (i % 4) }, (_, j) => ({ sku: `SKU-${(i + j) % 250}`, qty: 1 + ((i + j) % 3) })), ...(i % 10 === 0 ? { coupon: 'SAVE10' } : {}) }));
    const document = { generatedAt: '2026-01-15T09:00:00Z', orders };
    const tokens = (text: string) => getEncoding('o200k_base').encode(text).length;
    expect(tokens(JSON.stringify(document))).toBe(936288);
    expect(tokens(JSON.stringify(describe(document)))).toBe(541);
  });
});
