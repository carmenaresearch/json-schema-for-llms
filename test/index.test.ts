import { describe as group, expect, test } from 'bun:test';
import { compact, describe } from '../src/index';

type Schema = Record<string, any>;

group('describe', () => {
  test('reads every value and collapses array items into one schema', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: index, label: `row ${index}`, score: index % 7 }));
    const schema: Schema = describe({ rows });
    const items = schema.properties.rows.items;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(items['x-count']).toBe(5000);
    expect(items.properties.id).toMatchObject({ type: 'integer', minimum: 0, maximum: 4999 });
    expect(items.properties.score.enum).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(items.required).toEqual(['id', 'label', 'score']);
    expect(items.examples[0]).toEqual({ id: 0, label: 'row 0', score: 0 });
  });

  test('treats many same-typed values as a map keyed by ID', () => {
    const byId: Record<string, unknown> = {};
    for (let index = 0; index < 50; index++) byId[`id-${index}`] = { total: index };
    byId.updatedAt = '2026-01-01';
    const schema: Schema = describe(byId);
    expect(schema.additionalProperties['x-count']).toBe(50);
    expect(schema.propertyNames.examples).toEqual(['id-0', 'id-1', 'id-2']);
    expect(schema.properties.updatedAt.const).toBe('2026-01-01');
  });

  test('treats a few similar objects as a map, keeping odd keys as properties', () => {
    const schema: Schema = describe({
      a1: { name: 'A', value: 1 }, b2: { name: 'B', value: 2 }, c3: { name: 'C', value: 3 },
      d4: { name: 'D', value: 4 }, e5: { name: 'E', value: 5 }, f6: { name: 'F', value: 6 },
      g7: { name: 'G', value: 7 }, h8: { name: 'H', value: 8 }, i9: { name: 'I', value: 9 },
      totals: { count: 9, sum: 45, max: 9 },
    });
    expect(schema.propertyNames.enum).toEqual(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9']);
    expect(Object.keys(schema.properties)).toEqual(['totals']);
  });

  test('folds ID keys that are spread across instances into one map', () => {
    const groups = Array.from({ length: 30 }, (_, index) => ({ members: { [`m${index}a`]: { size: index }, [`m${index}b`]: { size: index + 1 } } }));
    const members: Schema = (describe(groups) as Schema).items.properties.members;
    expect(members.properties).toBeUndefined();
    expect(members.additionalProperties['x-count']).toBe(60);
  });

  test('reports numeric strings, as XML and TSV parsers produce', () => {
    const schema: Schema = describe([{ votes: '12' }, { votes: '7' }, { votes: '40' }]);
    expect(schema.items.properties.votes['x-numeric']).toEqual({ minimum: 7, maximum: 40 });
  });

  test('cuts branches without numbers first when over budget', () => {
    // A wide configuration of mixed value types, with no numbers: not a map, and nothing to map rows from.
    const kinds = [(index: number) => `text ${'x'.repeat(index % 9)}`, () => true, () => null, () => ['a', 'b'], () => ({ label: 'on' })];
    const settings = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`setting_${String.fromCharCode(97 + (index % 26))}_${index.toString(36)}`, kinds[index % kinds.length](index)]));
    const schema: Schema = describe({ settings, data: [{ n: 1 }, { n: 2 }] }, { maxChars: 2000 });
    expect(JSON.stringify(schema).length).toBeLessThanOrEqual(2000);
    expect(schema.properties.settings['x-omitted'].reason).toBe('no numbers in branch');
    expect(schema.properties.data.items.properties.n).toBeDefined();
  });

  test('handles empty and scalar documents', () => {
    expect(describe([])).toMatchObject({ type: 'array', minItems: 0, maxItems: 0 });
    expect(describe('x')).toMatchObject({ type: 'string', const: 'x' });
    expect(describe(null)).toMatchObject({ type: 'null' });
  });
});

group('compact', () => {
  test('returns the document when it is smaller than its schema', () => {
    const result = compact({ status: 'ok', count: 3 });
    expect(result.kind).toBe('document');
    expect(result.text).toBe('{"status":"ok","count":3}');
  });

  test('returns the schema when it is smaller than the document', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ id: index, value: index * 2 }));
    const result = compact(rows);
    expect(result.kind).toBe('schema');
    expect(result.text.length).toBeLessThan(JSON.stringify(rows).length);
    expect(result.schema?.type).toBe('array');
  });

  test('compares against the original text when given', () => {
    const text = '<r><v>1</v></r>';
    expect(compact({ r: { v: '1' } }, { text })).toEqual({ kind: 'document', text });
  });
});
