import { getEncoding } from 'js-tiktoken';
import { describe, fits, merge } from 'json-schema-for-llms';

const tokens = text => getEncoding('o200k_base').encode(text).length;
const statuses = ['paid', 'pending', 'refunded'];
const order = i => ({
  id: `ord_${100000 + i}`, status: statuses[i % 3], total: Math.round((i * 37) % 50000) / 100,
  items: Array.from({ length: 1 + (i % 4) }, (_, j) => ({ sku: `SKU-${(i + j) % 250}`, qty: 1 + ((i + j) % 3) })),
  ...(i % 10 === 0 ? { coupon: 'SAVE10' } : {}),
});

const document = { generatedAt: '2026-01-15T09:00:00Z', orders: Array.from({ length: 20000 }, (_, i) => order(i)) };
const schema = describe(document);
console.log(`document: ${tokens(JSON.stringify(document)).toLocaleString()} tokens`);
console.log(`schema:   ${tokens(JSON.stringify(schema)).toLocaleString()} tokens\n`);
console.log(JSON.stringify(schema, null, 2).slice(0, 1200), '\n...\n');

const sameShape = { generatedAt: '2026-01-16T09:00:00Z', orders: [order(7), order(8)] };
console.log('next document, same structure:', fits(schema, describe(sameShape)));

const changed = { generatedAt: '2026-01-17T09:00:00Z', orders: [{ ...order(9), giftWrap: true }] };
console.log('next document, a new field:   ', fits(merge(schema, describe(sameShape)), describe(changed)));
