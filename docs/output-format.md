# Output format reference

`describe()` returns a [JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation) document that describes **every value** in the input, plus real examples. This page lists the keywords it uses and explains how the summary is built.

## Standard keywords

| Keyword | Meaning in the output |
|---|---|
| `type` | Every type seen at this position. Several types give an array, such as `["string", "null"]`. `integer` is folded into `number` when both appear. |
| `properties` | Fields of an object, one schema each. |
| `required` | Fields present in every instance of the object. Fields not listed are optional. |
| `minProperties`, `maxProperties` | The smallest and largest number of keys seen in an instance. |
| `additionalProperties` | The merged schema of the members of an ID-keyed map. See [ID-keyed maps](#id-keyed-maps). |
| `propertyNames` | The map's keys: `enum` lists them all when there are at most `enumLimit`; otherwise `examples` shows a few. |
| `items` | The merged schema of every array item. Omitted when every array at this position is empty. |
| `minItems`, `maxItems` | The shortest and longest array seen. |
| `minLength`, `maxLength` | The shortest and longest string, in characters. |
| `minimum`, `maximum` | The smallest and largest number. |
| `const` | The field always has this one value. |
| `enum` | Every value the field takes, when there are few (at most `enumLimit`) and they repeat. |
| `examples` | Real values for a scalar field, or real records for a repeated object, copied from the input. |

## Custom keywords

Statistics that JSON Schema has no keyword for use an `x-` prefix. You can include this explanation in a prompt:

| Keyword | Meaning |
|---|---|
| `x-count` | How many times a value appears at this position across the whole file. For array items, this is the total number of items in every array at that position. |
| `x-distinct` | How many different values the field has, or `">1000"` when there are more than `distinctLimit`. |
| `x-numeric` | `{ "minimum", "maximum" }` for strings that all contain numbers, as XML and TSV parsers produce. |
| `x-omitted` | This branch was reduced to fit the size budget because it contains no numbers. Gives `reason`, and for objects `keyCount` and the first `keys`. |

## How the summary is built

### Every value is read

The input is walked once, in full. Nothing is sampled, so counts, ranges, distinct values and optional fields are exact for the whole file. Each position in the tree (such as "every item of `orders`") gets one schema, no matter how many times it occurs.

### Per-field statistics

For each position, following the approach of Microsoft LIDA's dataset summarizer, the library records the types, occurrence count, minimum and maximum, string lengths, and distinct values (up to `distinctLimit`), then renders:

- `const` if there is a single value;
- `enum` if there are at most `enumLimit` values and they repeat;
- otherwise up to `samples` example values.

### Example records

For each repeated object, the first `samples` instances are kept. When an instance with a new set of keys appears, it replaces a repeated one, so optional fields and variants are represented. Examples are clipped: two items per array, three keys per map, 80 characters per string, eight levels deep.

Fields inside an object that already shows example records don't repeat their own examples, since the records already contain them.

### ID-keyed maps

Many APIs key objects by an ID instead of a field name, for example `{"10234": {...}, "10235": {...}}`. Describing each key as a separate field would make the summary grow with the data, so these are merged into one `additionalProperties` schema. An object counts as a map when at least 90% of its values are members, where members are:

- values of one shared type, when the object has at least `mapMinKeys` values; or
- objects that share at least 80% of their keys, when there are three or more of them.

Values that aren't members, such as a `summary` or `lastModified` field next to the IDs, stay ordinary `properties`.

IDs can also be spread across instances, with only a few in each object: for example, each record listing two or three members keyed by ID. After reading the file, any object position with more than `enumLimit` fields of one type, each present in fewer than half of the instances, has those fields folded into one map.

### Size budget

The output is rendered, measured, and reduced in steps until it fits `maxChars`:

1. the full summary;
2. branches with no numbers anywhere (including numeric strings) reduced to their key names, as `x-omitted`;
3. the same, with fewer examples, down to none.

Branches without numbers are cut first because they are usually page text, settings or styling rather than data. If the summary is still over budget after the last step, it is returned as is. `maxChars` is a target, not a guarantee.

## Determinism

The same input always produces the same output: examples are chosen by position, not at random. Two files with the same structure produce the same schema apart from statistics and examples, which makes it possible to tell when a file's structure has changed.
