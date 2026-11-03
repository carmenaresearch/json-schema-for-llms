# Guide: reading large JSON with an LLM

This guide shows how to use `json-schema-for-llms` to let a large language model (Claude, GPT, Gemini, Llama or any other) work with a JSON, XML or TSV file that is too large for its context window, or too expensive to send in full.

The pattern is:

1. **Summarize** the file in code, reading every value.
2. **Send the smaller** of the file and its summary to the model.
3. **Ask the model for something you can run**, such as a JSONPath query, a jq filter or a parser, rather than for the data itself.
4. **Run it on the full file** in code, and check the result against the summary's counts.

The model never needs to see the large file, and the work on the full data is done by code.

## 1. Summarize the file

```ts
import { compact } from 'json-schema-for-llms';

const text = await Bun.file('large.json').text();
const result = compact(JSON.parse(text), { text });
```

For XML or TSV, parse the text into JavaScript values first, and still pass the original text:

```ts
import { XMLParser } from 'fast-xml-parser';

const text = await Bun.file('results.xml').text();
const document = new XMLParser({ ignoreAttributes: false }).parse(text);
const result = compact(document, { text });
```

## 2. Send the smaller of the two

`compact()` compares the original text with the schema and returns the smaller one:

| `result.kind` | `result.text` holds | When |
|---|---|---|
| `'schema'` | the JSON Schema with examples | the schema is smaller than the file, usually for large or repetitive files |
| `'document'` | the original text, unchanged | the file is small or flat, so its schema would be the same size or larger |

**Always check `kind`.** A schema adds keywords for every field, so a small file can produce a summary several times its own size (in our tests, 1.4 KB became 7.3 KB). Sending the smaller one keeps prompts as short as possible and avoids describing a file that could simply be shown.

Tell the model which one it is getting:

```ts
const intro = result.kind === 'schema'
  ? 'The file is too large to include. This JSON Schema (draft 2020-12) describes all of it. ' +
    'Counts, ranges and distinct values cover every value in the file; "examples" are real records copied from it. ' +
    'Keywords starting with x- are explained below.'
  : 'Here is the complete file.';
```

When sending a schema, include a short explanation of the `x-` keywords. You can copy it from the [output format reference](output-format.md#custom-keywords).

## 3. Ask for something you can run

The summary is enough for the model to understand the structure, but not to read every value. Ask for an artifact that code can apply to the full file:

```text
Write a JSONPath expression (RFC 9535) that selects every line item in every order,
and list the fields to read from each one.
```

Other good requests:

- a jq filter or JSONata expression
- a small parsing function in the language you use
- a mapping from the file's fields to your own data model

Because the examples are copied verbatim, paths and field names the model takes from them match the real file.

## 4. Run it and check it

Run what the model wrote on the full file, then compare the result with the summary:

- **Row counts:** if the model iterates `orders[*].items[*]`, the number of rows should equal that node's `x-count` (50,000 in the README example).
- **Values:** numbers should fall within each field's `minimum` and `maximum`, and categorical fields should only contain `enum` values.
- **Spot checks:** compare a few output rows with the matching records in the file.

If a check fails, send the error back to the model with the summary and ask for a correction.

## Reusing a summary

The same file structure produces the same schema apart from its statistics and examples, so a mapping written for one file usually works for later versions of it. To detect when the structure changes, compare the schemas with `examples`, `x-count`, `x-distinct`, `minimum`, `maximum` and similar statistics removed. If the structure differs, generate a new mapping.

## Choosing options

- **Smaller summaries:** lower `samples` (fewer examples) or `maxChars` (a tighter budget).
- **More detail:** raise `samples`, or raise `enumLimit` to list more categorical values.
- **ID-keyed objects not detected,** or ordinary records treated as maps: adjust `mapMinKeys`. See [how maps are detected](output-format.md#id-keyed-maps).

## When the summary is still too large

`maxChars` is a target. If a file has a very large number of different numeric fields, the summary can stay above it even after branches without numbers are cut and examples are removed. In that case:

- describe one part of the file at a time, for example `describe(document.results)`;
- or let the model explore step by step, starting from the schema and asking for specific parts of the file through tools.
