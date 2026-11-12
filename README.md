# json-schema-for-llms

**Let an LLM work with JSON far larger than its context window, and keep that understanding up to date as new documents arrive.**

You have a 2 MB API response, or a feed that returns a new one every 15 minutes. You want a model to write a parser or JSONPath for it, once, and to know when the data has changed enough that the parser needs rewriting. Pasting the data doesn't fit; sampling it misses things.

This library reads every value and turns the data into a small JSON Schema with real examples and counts:

```
2.5 MB JSON (20,000 orders, ~640,000 tokens)  →  1.6 KB schema (~410 tokens)
```

The schema is the only thing you keep. New documents are merged into it, and checked against it, without any model call.

## Functions

| | |
|---|---|
| `describe(document)` | A JSON Schema of one document: types, counts, ranges, categories with frequencies, and real example records. |
| `merge(a, b)` | One schema for everything `a` and `b` describe, as if read together. |
| `fits(schema, document)` | Whether a document has fields the schema has never seen. |
| `compact(document)` | The smaller of the document and its schema, ready for a prompt. |

## Use

**Give a model a document too large to paste:**

```ts
import { compact } from 'json-schema-for-llms';

const text = await Bun.file('large.json').text();
const { kind, text: forModel } = compact(JSON.parse(text), { text });
// kind is 'schema' or 'document', whichever was smaller
```

Ask the model for something you can run (a parser, JSONPath, jq) rather than for the data, then run it on the full file.

**Keep one schema across many documents:**

```ts
import { describe, merge, fits } from 'json-schema-for-llms';

let schema = documents.map(d => describe(d)).reduce((a, b) => merge(a, b));   // many documents
schema = merge(schema, describe(next));                                         // one more

fits(schema, latest);
// { fits: false, added: ['$.races[*].called'], missing: [], widened: [] }
```

A document **fits** unless it has a field path the schema lacks (`added`). Fields it lacks (`missing`), new values, new IDs and new types at a known path (`widened`, e.g. `null` before and a number now) don't count. Reuse what the model built while documents fit; regenerate it when `added` isn't empty. Paths use `[*]` for array items and `{*}` for the values of an object keyed by IDs.

To choose among several schemas, run `fits` on each and prefer the fitting one with the fewest `missing` paths.

## What the schema says

Standard [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation) (`type`, `properties`, `required`, `items`, `minimum`, `enum`, ...), plus:

| | |
|---|---|
| `x-count` | How many times a value appears here, across everything read |
| `x-type-counts` | The count per type, when there is more than one |
| `x-frequency` | How often each listed value appears, beside `enum` (most frequent first) or a short `examples` list |
| `x-distinct` | How many different values, when they aren't all listed: a number, or `[low, high]` after merges, since the overlap between documents is unknown |
| `x-numeric` | The range of numeric strings, as XML and TSV give them |
| `x-format` | `json-schema-for-llms/2`; `merge` and `fits` refuse anything else |

- **Categories.** A field with at most 50 distinct short labels (40 characters, 4 words each) is listed in full as `enum` with frequencies. Free text and long identifiers get `x-distinct` and a few examples instead.
- **ID-keyed maps.** An object keyed by IDs (`{"13121": {...}, "13089": {...}}`) becomes one `additionalProperties` schema, so new IDs are never new fields. Once a schema has a map somewhere, a later document with only a few IDs there joins it.
- **Size.** `maxChars` (default 80,000) is met by cutting examples only. Field names, types and counts are never cut, so `fits` stays exact.

## Good to know

- Merging in any order or grouping gives the same statistics, except where the same place is an ID-keyed map in some documents and named fields in others. Example records keep document order.
- A field's `x-distinct` becomes a range once neither side lists its values; categories and short lists stay exact.
- A new field with the same type as an ID-keyed map's values, inside that map's object, counts as one more ID rather than as added.
- The whole document is held in memory. Tens of megabytes are fine.
- XML and TSV: parse to objects first (e.g. [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)) and pass the original text to `compact`.

## Install

```sh
bun add github:carmenaresearch/json-schema-for-llms
```

TypeScript source, no dependencies. Bun and Deno run it directly; Node needs a TypeScript-aware loader.

Options for `describe`, `merge`, `fits` and `compact`: `samples` (examples per field, 3), `enumLimit` (50), `mapMinKeys` (20), `distinctLimit` (distinct values tracked per document, 1000), `stringLimit` (characters per example string, 80), `maxChars` (80,000).

**2.0 is a breaking change.** Schemas from 1.x are refused; describe the documents again.

```sh
bun test && bun run typecheck   # development
```

MIT License.
