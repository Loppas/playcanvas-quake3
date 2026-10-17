// A run kept: its result.json and every frame log under logs/, as one gzipped JSON.
//
//     node scripts/perf/perf-keep.mjs <run dir> <out.json.gz>
//
// Read back with `JSON.parse(zlib.gunzipSync(readFileSync(file)))`: `{ result, logs: { name: log } }`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: perf-keep.mjs <run dir> <out.json.gz>');
const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
const logs = {};
for (const file of readdirSync(join(dir, 'logs'))) {
  logs[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, 'logs', file), 'utf8'));
}
const body = gzipSync(JSON.stringify({ result, logs }), { level: 9 });
writeFileSync(out, body);
console.log(`${out}: ${(body.length / 1e6).toFixed(2)} MB`);
