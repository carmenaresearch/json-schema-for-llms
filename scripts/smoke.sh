#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$root"
tarball="$work/$(npm pack --silent --pack-destination "$work" | tail -1)"
echo "packed $(basename "$tarball"): $(tar -tzf "$tarball" | sed 's#^package/##' | sort | tr '\n' ' ')"

cat > "$work/use.mjs" <<'EOF'
import assert from 'node:assert/strict';
import { compact, describe, fits, merge, FORMAT } from 'json-schema-for-llms';
const a = describe({ region: 'North', products: [{ sku: 'A-1042', stock: null }] });
const b = describe({ region: 'North', products: [{ sku: 'A-1043', stock: 812 }] });
const schema = merge(a, b);
assert.equal(schema['x-format'], FORMAT, 'schemas carry the format marker');
assert.deepEqual(schema.properties.products.items.properties.stock.type, ['null', 'integer'], 'null and a number give both types');
assert.equal(fits(schema, b).fits, true, 'a described document fits its merged schema');
assert.deepEqual(fits(schema, describe({ region: 'North', products: [], discontinued: true })).added, ['$.discontinued'], 'a new field is reported');
assert.equal(compact({ ok: true }).kind, 'document', 'a small document is returned as is');
console.log('ok');
EOF

echo -n "node $(node --version) ESM: "
mkdir "$work/node" && cd "$work/node" && npm init -y >/dev/null && npm install --silent "$tarball" && cp ../use.mjs . && node use.mjs

echo -n "typescript (NodeNext): "
mkdir "$work/ts" && cd "$work/ts" && npm init -y >/dev/null && npm install --silent "$tarball" typescript@5
cat > index.ts <<'EOF'
import { describe, fits, type Fit, type Schema } from 'json-schema-for-llms';
const schema: Schema = describe({ a: 1 });
const result: Fit = fits(schema, describe({ a: 2 }));
const added: string[] = result.added;
console.log(added.length);
EOF
echo '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"target":"ES2022"}}' > tsconfig.json
node -e "const p=require('./package.json');p.type='module';require('fs').writeFileSync('package.json',JSON.stringify(p))"
npx --no-install tsc -p . && echo ok

echo -n "bun $(bun --version): "
mkdir "$work/bun" && cd "$work/bun" && echo '{"name":"smoke","type":"module"}' > package.json && bun add --silent "$tarball" >/dev/null && cp ../use.mjs . && bun use.mjs

deno=$(command -v deno || echo "npx -y deno@2")
echo -n "deno ($($deno --version | head -1)): "
cd "$work/node" && $deno run --node-modules-dir=manual use.mjs
