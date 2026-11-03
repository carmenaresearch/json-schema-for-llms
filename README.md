# json-schema-for-llms: let an LLM read JSON larger than its context window

**Give Claude, GPT or any large language model a JSON file too large to paste into a prompt.** `json-schema-for-llms` reads every value in a large JSON, XML or TSV document and turns it into a compact **JSON Schema with real examples**: field names, types, counts, value ranges and sample records. The LLM gets the structure of the whole file in a few thousand tokens instead of millions.

```
2.5 MB JSON (20,000 orders, ~640,000 tokens)  →  1.5 KB JSON Schema with examples (~380 tokens)
```

- **For large JSON and LLM context limits:** summarize a file that exceeds the context window, or would cost too many tokens, so the model can understand it, write a parser, or generate JSONPath queries.
- **Exact, not a guess:** every value is read, so the counts, ranges and distinct values are true for the entire file, not for a sample.
- **Real examples:** sample records are copied verbatim from your data, so paths and value formats the model writes from them match the file.
- **Standard output:** valid [JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation), with a few `x-` annotations for statistics.
- **Never larger than it needs to be:** `compact()` returns whichever is smaller, the document or its schema.
- **Small and dependency-free:** one TypeScript file for Bun, Node.js or Deno, with no election, domain or vendor assumptions.

## Contents

- [Quick start](#quick-start)
- [Use the smaller of the two](#use-the-smaller-of-the-two)
- [Example output](#example-output)
- [How it compresses large JSON](#how-it-compresses-large-json)
- [Options](#options)
- [Real-world results](#real-world-results)
- [Limits](#limits)
- [FAQ](#faq)
- [Related tools](#related-tools)
- [Documentation](docs/guide.md) · [Output format reference](docs/output-format.md)

## Quick start

Install from GitHub:

```sh
bun add github:carmenaresearch/json-schema-for-llms
```

Summarize a large JSON file and give the result to an LLM:

```ts
import { compact } from 'json-schema-for-llms';

const text = await Bun.file('large.json').text();
const { kind, text: forModel } = compact(JSON.parse(text), { text });

const prompt = kind === 'schema'
  ? `This JSON Schema, with real examples, describes a JSON file too large to include:\n${forModel}`
  : `Here is the JSON file:\n${forModel}`;
```

The package exports TypeScript source (`src/index.ts`). Bun and Deno run it directly; with Node.js, use a TypeScript-aware loader or bundler.

## Use the smaller of the two

**A schema is not always smaller than the data.** Large repetitive files shrink by hundreds or thousands of times, but a small or flat document can produce a schema *larger* than the original: in our tests, a 1.4 KB response produced a 7.3 KB schema.

So always send the model whichever is smaller. `compact()` does this for you:

```ts
const result = compact(document, { text });  // text: the original file, if you have it
result.kind;    // 'document' or 'schema': which one result.text holds
result.text;    // the smaller of the two, ready for a prompt
result.schema;  // the schema object, when kind is 'schema'
```

Pass the original `text` whenever you have it. XML and TSV text often has a different size from its parsed form, and the comparison should use what you would actually send. Without `text`, the document is measured as compact JSON.

Use `describe()` when you always want the schema, for example to cache it or compare file structures.

## Example output

For the 2.5 MB file above (`{ generatedAt, orders: [20,000 orders] }`), the schema says, among other things:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "generatedAt": { "type": "string", "x-count": 1, "const": "2026-01-15T09:00:00Z" },
    "orders": {
      "type": "array",
      "minItems": 20000,
      "maxItems": 20000,
      "items": {
        "type": "object",
        "x-count": 20000,
        "properties": {
          "id": { "type": "string", "x-count": 20000, "minLength": 10, "maxLength": 10, "x-distinct": ">1000" },
          "status": { "type": "string", "x-count": 20000, "x-distinct": 3, "enum": ["paid", "pending", "refunded"] },
          "total": { "type": "number", "x-count": 20000, "minimum": 0, "maximum": 499.98, "x-distinct": ">1000" },
          "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
              "type": "object",
              "x-count": 50000,
              "properties": {
                "sku": { "type": "string", "x-count": 50000, "x-distinct": 250 },
                "qty": { "type": "integer", "x-count": 50000, "enum": [1, 2, 3] }
              }
            }
          },
          "coupon": { "type": "string", "x-count": 2000, "const": "SAVE10" }
        },
        "required": ["id", "status", "total", "items"],
        "examples": [
          { "id": "ord_100000", "status": "paid", "total": 0, "items": [{ "sku": "SKU-0", "qty": 1 }], "coupon": "SAVE10" },
          { "id": "ord_100001", "status": "pending", "total": 0.37, "items": [{ "sku": "SKU-1", "qty": 2 }, { "sku": "SKU-2", "qty": 3 }] }
        ]
      }
    }
  }
}
```

(Shortened here; the real output also has length ranges and a third example.) From this, a model can tell that there are 20,000 orders and 50,000 line items, that `coupon` is optional and appears on 2,000 orders, and what every value looks like, without seeing the 2.5 MB.

## How it compresses large JSON

Most large JSON is large because the same structure repeats. The summary grows with the number of **distinct shapes** in the file, not with its size in bytes.

1. **Arrays collapse.** All items merge into one `items` schema, with the item count and length range.
2. **ID-keyed objects collapse.** Objects keyed by IDs rather than field names, such as `{"10234": {...}, "10235": {...}}`, become one `additionalProperties` schema with example keys. This is detected from shape, not from what the keys look like, including keys spread a few at a time across many objects.
3. **Statistics per field**, as in Microsoft LIDA's dataset summarizer: types, occurrence count, min/max, distinct count, and up to three real non-null examples. Fields with one value become `const`; fields with few values become `enum`.
4. **Real example records** for each repeated level, copied verbatim and clipped (two items per array, 80 characters per string). New record shapes are preferred, so optional fields appear.
5. **A size budget.** If the summary is still larger than `maxChars`, branches with no numbers anywhere are reduced to their key names, then fewer examples are used.

XML and TSV work too: parse them into objects first (for example with [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)). Numeric strings get an `x-numeric` range.

Details: [docs/output-format.md](docs/output-format.md).

## Options

```ts
describe(document, {
  samples: 3,          // examples per field and per repeated record
  enumLimit: 12,       // list all values as enum when there are at most this many
  mapMinKeys: 20,      // an object with this many same-typed values is an ID-keyed map
  distinctLimit: 1000, // distinct values tracked per field
  stringLimit: 80,     // characters kept per example string
  maxChars: 80000,     // output budget in characters (about 20,000 tokens)
});
```

`compact()` takes the same options plus `text`.

## Real-world results

Measured on 22 public API responses (election-results feeds from news organizations and government sites), using the default options:

| Input | Schema | Approximate tokens |
|---|---|---|
| 956 KB precinct results | 4.8 KB | 1,200 |
| 979 KB web-page data feed | 63 KB | 16,000 |
| 634 KB national results with candidate metadata | 75 KB | 19,000 |
| 541 KB official results with contest details | 44 KB | 11,000 |
| 333 KB XML results file | 1.4 KB | 360 |
| 329 KB tab-separated precinct file | 1.7 KB | 430 |
| 23 KB county results | 15 KB | 3,900 |
| 1.4 KB small summary | 7.3 KB | 1,900, **larger than the input; `compact()` returns the input** |

Each took under 50 ms in Bun. Repetitive files compress the most; wide files with many different fields compress less (about 1.5–15× in these tests).

## Limits

- **`maxChars` is a target, not a guarantee.** A file with very many distinct numeric fields can stay above it. Check the size, or let `compact()` choose.
- **The whole document is held in memory** after parsing. Files of tens of megabytes are fine; much larger files need a streaming parser.
- **The map rule is a heuristic.** A record with 20 or more fields of the same type is treated as an ID-keyed map, and only a few of its field names are shown, as example keys. Raise `mapMinKeys` if that happens to your data.
- **Examples are clipped**, so a deeply nested example may end in empty `[]` or `{}` beyond eight levels.

## FAQ

**How do I give a large JSON file to ChatGPT, Claude or another LLM?**
If the file is larger than the model's context window, or too expensive to send, give it a summary that keeps the structure and real examples instead of the raw data. `compact()` produces that summary and returns the raw file instead when the file is small enough.

**Why not truncate the file or send a random sample?**
Truncation cuts JSON mid-structure and only shows the beginning. A sample can miss rare fields and variants, and the model can't tell how much data there is. This library reads every value, so counts, ranges and optional fields are exact.

**Can the LLM extract data from the full file using only the schema?**
Yes: that's the main use. Ask the model to write JSONPath, jq or code against the schema, then run it on the real file. The examples are verbatim, so the paths match. Validate the result, for example by comparing row counts with `x-count`.

**Does it work with XML, CSV or TSV?**
Yes, once parsed into JavaScript values. Numeric strings from those formats are recognized.

**Does it send data anywhere?**
No. It is a pure function with no network access and no dependencies.

## Related tools

- [genson](https://github.com/wolverdude/GenSON) and [quicktype](https://github.com/glideapps/quicktype) infer JSON Schema from samples, but don't add counts, statistics or examples, or keep the output within a token budget.
- [Microsoft LIDA](https://github.com/microsoft/lida) summarizes flat tables for LLMs with per-column statistics and samples; this library applies the same idea to nested JSON.
- [TOON](https://github.com/toon-format/toon) re-encodes JSON losslessly in fewer tokens; it doesn't reduce how much data there is.
- [LangChain's JSON toolkit](https://docs.langchain.com/oss/python/integrations/tools/json) lets an agent explore large JSON key by key; a schema from this library is a good starting point for that exploration.

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

[MIT](LICENSE) © 2026 Carmena Research
