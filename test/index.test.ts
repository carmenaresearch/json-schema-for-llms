import { describe as group, expect, test } from 'bun:test';
import { compact, describe, fits, FORMAT, merge, type Schema } from '../src/index';

const all = (documents: unknown[]) => documents.map(document => describe(document)).reduce((a, b) => merge(a, b));
const county = (name: string, votes: unknown, extra: Record<string, unknown> = {}) => ({ county: name, votes, precincts: 3, ...extra });
const ids = (count: number, start = 0) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`c${start + index}`, { votes: index }]));

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
    const parties = ['DEM', 'REP', 'NPA', 'LPF', 'GRE'], states = Array.from({ length: 30 }, (_, index) => `S${index}`);
    const rows = Array.from({ length: 600 }, (_, index) => ({ party: parties[index % 7 < 3 ? 0 : index % 5], state: states[index % 30] }));
    const schema: Schema = describe(rows);
    expect(schema.items.properties.party.enum[0]).toBe('DEM');
    expect(schema.items.properties.party['x-frequency'].reduce((a: number, b: number) => a + b)).toBe(600);
    expect(schema.items.properties.state.enum).toHaveLength(30);
  });

  test('free text and identifiers are not categories', () => {
    const notes = ['Recount requested by the county board', 'Late ballots counted after review', 'No issues reported'];
    const schema: Schema = describe(Array.from({ length: 80 }, (_, index) => ({ note: notes[index % 3], id: `v-${index}` })));
    expect(schema.items.properties.note.enum).toBeUndefined();
    expect(schema.items.properties.note['x-distinct']).toBe(3);
    expect(schema.items.properties.id.enum).toBeUndefined();
    expect(schema.items.properties.id['x-distinct']).toBe(80);
  });

  test('treats many same-typed values as a map keyed by ID', () => {
    const schema: Schema = describe({ ...ids(50), updatedAt: '2026-01-01' });
    expect(schema.additionalProperties['x-count']).toBe(50);
    expect(schema.propertyNames.examples).toEqual(['c0', 'c1', 'c2']);
    expect(schema.properties.updatedAt.const).toBe('2026-01-01');
  });

  test('folds ID keys that are spread across instances into one map', () => {
    const groups = Array.from({ length: 30 }, (_, index) => ({ members: { [`m${index}a`]: { size: index }, [`m${index}b`]: { size: index + 1 } } }));
    const members: Schema = describe(groups).items.properties.members;
    expect(members.properties).toBeUndefined();
    expect(members.additionalProperties['x-count']).toBe(60);
  });

  test('reports numeric strings, as XML and TSV parsers produce', () => {
    expect(describe([{ votes: '12' }, { votes: '7' }, { votes: '40' }]).items.properties.votes['x-numeric']).toEqual({ minimum: 7, maximum: 40 });
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
  const documents = [county('Fulton', null), county('Cobb', 812, { updated: '21:04' }), county('DeKalb', 77), county('Gwinnett', '1,204')];
  const drop = ({ examples, ...rest }: Schema): Schema => Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? drop(value) : value]));

  test('a field null in one document and a number in another has both types', () => {
    const votes = all(documents.slice(0, 2)).properties.votes;
    expect(votes.type).toEqual(['null', 'integer']);
    expect(votes['x-type-counts']).toEqual({ null: 1, integer: 1 });
  });

  test('a field in only some documents is optional', () => {
    const schema = all(documents);
    expect(schema.required).toEqual(['county', 'votes', 'precincts']);
    expect(schema.properties.updated['x-count']).toBe(1);
  });

  test('order and grouping do not change the statistics', () => {
    const [a, b, c, d] = documents.map(document => describe(document));
    const one = drop(merge(merge(merge(a, b), c), d)), two = drop(merge(merge(a, b), merge(c, d))), three = drop(merge(d, merge(c, merge(b, a))));
    const sortTypes = (schema: Schema) => JSON.parse(JSON.stringify(schema, (key, value) => key === 'type' && Array.isArray(value) ? [...value].sort() : value));
    expect(sortTypes(two)).toEqual(sortTypes(one));
    expect(sortTypes(three).properties.votes['x-count']).toBe(4);
    expect(sortTypes(three).properties.votes.type).toEqual(sortTypes(one).properties.votes.type);
  });

  test('categories add their frequencies and can become text', () => {
    const party = (values: string[]) => describe(values.map(value => ({ party: value })));
    const merged = merge(party(['DEM', 'DEM', 'REP', 'REP']), party(['DEM', 'DEM', 'NPA', 'NPA'])).items.properties.party;
    expect(merged.enum).toEqual(['DEM', 'REP', 'NPA']);
    expect(merged['x-frequency']).toEqual([4, 2, 2]);
  });

  test('distinct counts are exact when values are listed, and bounds otherwise', () => {
    const idsOf = (start: number, count: number) => describe(Array.from({ length: count }, (_, index) => ({ id: `v${start + index}` })));
    expect(merge(idsOf(0, 30), idsOf(20, 30)).items.properties.id.enum).toHaveLength(50);      // both listed: exact
    expect(merge(idsOf(0, 60), idsOf(40, 60)).items.properties.id['x-distinct']).toEqual([60, 120]); // neither: bounds
  });

  test('a document with a few IDs joins the map earlier documents established', () => {
    const merged = merge(describe({ counties: ids(30) }), describe({ counties: { c99: { votes: 5 }, c100: { votes: 6 } } }));
    expect(merged.properties.counties.properties).toBeUndefined();
    expect(merged.properties.counties.additionalProperties['x-count']).toBe(32);
  });

  test('refuses schemas from another version', () => {
    expect(() => merge({ type: 'object' }, describe({}))).toThrow(FORMAT);
  });
});

group('fits', () => {
  const base = describe({ race: 'Senate', counties: ids(30), updated: null });

  test('new IDs, missing optional fields and widened types still fit', () => {
    expect(fits(base, { race: 'Senate', counties: ids(2, 500), updated: '21:04' })).toEqual({ fits: true, added: [], missing: [], widened: ['$.updated'] });
    expect(fits(base, { race: 'House', counties: ids(25, 40) })).toMatchObject({ fits: true, missing: ['$.updated'] });
  });

  test('a new field does not fit, wherever it appears', () => {
    expect(fits(base, { race: 'Senate', counties: ids(30), updated: null, called: true })).toMatchObject({ fits: false, added: ['$.called'] });
    const nested = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`c${index}`, { votes: index, margin: 0.5 }]));
    expect(fits(base, { race: 'Senate', counties: nested, updated: null }).added).toEqual(['$.counties{*}.margin']);
    expect(fits(describe({ rows: [{ a: 1 }] }), { rows: [{ a: 1, b: 2 }], 'odd key': 1 }).added).toEqual(['$.rows[*].b', '$["odd key"]']);
  });

  test('a document fits a schema it was merged into', () => {
    const document = { race: 'Governor', counties: ids(10, 70), updated: 'now' };
    expect(fits(merge(base, describe(document)), document).fits).toBe(true);
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
