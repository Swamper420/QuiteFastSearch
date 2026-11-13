// Correctness, resumability and fidelity tests for the Sluice Sort wasm engine.
// Usage: node test/test.mjs [path/to/sluice.wasm]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, "..", "build", "sluice.wasm");

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const memory = ex.memory;

const OP = {
  CMP: 0, SWAP: 1, PIVOT: 2, RANGE: 3, LANE: 4, ORD: 5,
  REV: 6, INS: 7, DONE: 8, CMPV: 9, SET: 10, LANE2: 11,
};
const KNOWN_OPS = new Set(Object.values(OP));
const MAX_EVENT_U32 = 3;

/*
 * Drive the resumable engine. With collect=false the interaction log is read
 * but discarded (large arrays); the sort itself is unaffected.
 */
function runAll(values, { collect = true, batch = 30000 } = {}) {
  const n = values.length;
  new Int32Array(memory.buffer, ex.arr_ptr(), Math.max(n, 1)).set(values);
  ex.begin_sort(n);

  let buf = collect ? new Uint32Array(1 << 14) : null;
  let len = 0;
  let steps = 0;

  for (;;) {
    const count = ex.eng_batch(batch);
    steps++;
    if (count > 0 && collect) {
      const need = len + count * MAX_EVENT_U32;
      if (need > buf.length) {
        const grow = new Uint32Array(Math.max(buf.length * 2, need));
        grow.set(buf.subarray(0, len));
        buf = grow;
      }
      buf.set(new Uint32Array(memory.buffer, ex.evbuf_ptr(), count * MAX_EVENT_U32), len);
      len = need;
    }
    if (ex.is_done()) break;
    if (count === 0) throw new Error(`engine stalled after ${steps} batches`);
    if (steps > 100000) throw new Error("runaway engine");
  }

  const sorted = new Int32Array(memory.buffer, ex.arr_ptr(), n);
  return {
    sorted,
    events: collect ? buf.subarray(0, len) : null,
    cmp: ex.cmp_total(),
    swaps: ex.swap_total(),
    dropped: ex.events_dropped(),
    totalEvents: ex.events_total(),
    batches: steps,
  };
}

// Replay only swap records; the sequence must reproduce the sorted array.
function replaySwaps(values, events) {
  const mirror = Int32Array.from(values);
  for (let k = 0; k < events.length; k += MAX_EVENT_U32) {
    const op = events[k];
    const i = events[k + 1];
    const j = events[k + 2];
    if (!KNOWN_OPS.has(op)) throw new Error(`unknown op ${op}`);
    if (op === OP.SWAP) {
      if (i >= mirror.length || j >= mirror.length) throw new Error(`swap out of range: ${i},${j}`);
      const t = mirror[i];
      mirror[i] = mirror[j];
      mirror[j] = t;
    }
    if (op === OP.CMP && (i >= mirror.length || j >= mirror.length)) {
      throw new Error(`compare out of range: ${i},${j}`);
    }
  }
  return mirror;
}

let failures = 0;
let checks = 0;
let worstRatio = 0;
let worstCase = "";

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function check(name, values, { eventBudget = 0 } = {}) {
  checks++;
  const expected = Int32Array.from(values).sort();
  const r = runAll(values);
  const got = Array.from(r.sorted);

  if (!sameArray(got, Array.from(expected))) {
    failures++;
    console.error(`FAIL sort  ${name}: expected ${expected.slice(0, 12)}... got ${got.slice(0, 12)}...`);
    return;
  }
  if (r.dropped !== 0) {
    failures++;
    console.error(`FAIL drops ${name}: ${r.dropped} interactions lost`);
    return;
  }
  if (!sameArray(Array.from(replaySwaps(values, r.events)), Array.from(expected))) {
    failures++;
    console.error(`FAIL trace ${name}: replay diverged`);
    return;
  }

  const n = values.length;
  const bound = 12 * n * Math.max(1, Math.log2(Math.max(n, 2))) + 256;
  if (r.cmp > bound) {
    failures++;
    console.error(`FAIL budget ${name}: ${r.cmp} comparisons, bound ${bound.toFixed(0)}`);
    return;
  }
  if (eventBudget && r.events.length / 3 > eventBudget) {
    failures++;
    console.error(`FAIL events ${name}: ${r.events.length / 3} > ${eventBudget}`);
  }
  if (n > 16) {
    const ratio = r.cmp / (n * Math.log2(n));
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstCase = `${name} (n=${n}, ${r.cmp} compares, ${r.totalEvents} interactions)`;
    }
  }
}

// Large arrays: no event log, but the array must still be sorted and the
// snapshot must sample the live array from end to end.
function checkBig(name, values) {
  checks++;
  const n = values.length;
  const expected = Int32Array.from(values).sort();
  const r = runAll(values, { collect: false });

  if (!sameArray(Array.from(r.sorted), Array.from(expected))) {
    failures++;
    console.error(`FAIL big sort ${name}`);
    return;
  }
  if (r.dropped !== 0) {
    failures++;
    console.error(`FAIL big drops ${name}: ${r.dropped}`);
  }
  const buckets = ex.snapshot(512);
  const samples = new Int32Array(memory.buffer, ex.snap_ptr(), buckets);
  checks++;
  if (buckets !== 512 || samples[0] !== expected[0] || samples[511] !== expected[n - 1]) {
    failures++;
    console.error(`FAIL snapshot endpoints ${name}: ${samples[0]}..${samples[511]}`);
  }
  const bound = 12 * n * Math.max(1, Math.log2(Math.max(n, 2))) + 256;
  if (r.cmp > bound) {
    failures++;
    console.error(`FAIL big budget ${name}: ${r.cmp}`);
  }
}

function shuffle(n, seed) {
  const v = new Int32Array(n);
  for (let i = 0; i < n; i++) v[i] = i + 1;
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = v[i]; v[i] = v[j]; v[j] = t;
  }
  return v;
}

const sizes = [0, 1, 2, 3, 4, 5, 7, 8, 16, 17, 23, 24, 25, 33, 40, 41, 100, 257, 512, 1024, 2048, 8192];

for (const n of sizes) {
  check(`random n=${n}`, shuffle(n, 12345 + n));
  check(`sorted n=${n}`, Int32Array.from({ length: n }, (_, i) => i + 1));
  check(`reversed n=${n}`, Int32Array.from({ length: n }, (_, i) => n - i));
  check(`equal n=${n}`, new Int32Array(n).fill(7));
  check(`two-values n=${n}`, Int32Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 2)));
  check(`organ-pipe n=${n}`, Int32Array.from({ length: n }, (_, i) => (i < n / 2 ? i + 1 : n - i)));
  check(`sawtooth n=${n}`, Int32Array.from({ length: n }, (_, i) => (i % 7) + 1));
  check(`negatives n=${n}`, Int32Array.from({ length: n }, (_, i) => ((i * 37) % 101) - 50));
}

for (const n of [64, 300, 1000]) {
  const v = Int32Array.from({ length: n }, (_, i) => i + 1);
  for (let k = 0; k < Math.max(1, n / 100); k++) {
    const i = Math.floor((k * 7919) % n);
    const j = Math.min(n - 1, i + 1 + (k % 5));
    const t = v[i]; v[i] = v[j]; v[j] = t;
  }
  check(`nearly-sorted n=${n}`, v);
}

// Determinism: identical input must produce an identical interaction stream.
{
  const v = shuffle(500, 99);
  const a = runAll(v);
  const b = runAll(v);
  checks++;
  if (a.events.length !== b.events.length || !sameArray(Array.from(a.events), Array.from(b.events))) {
    failures++;
    console.error("FAIL determinism");
  }
}

// Resumability: consuming the run in tiny batches must not change anything.
{
  const v = shuffle(700, 7);
  const once = runAll(v, { batch: 100000 });
  const many = runAll(v, { batch: 9 });
  checks++;
  if (!sameArray(Array.from(once.events), Array.from(many.events))) {
    failures++;
    console.error(`FAIL resumability: ${once.events.length} vs ${many.events.length} events`);
  }
}

// Monotone inputs must be linear: n+1 compares or fewer.
for (const n of [256, 1024, 2048]) {
  const asc = runAll(Int32Array.from({ length: n }, (_, i) => i + 1), { collect: false });
  const desc = runAll(Int32Array.from({ length: n }, (_, i) => n - i), { collect: false });
  checks++;
  if (asc.cmp > n + 2 || desc.cmp > n + 2) {
    failures++;
    console.error(`FAIL linear monotone n=${n}: asc=${asc.cmp} desc=${desc.cmp}`);
  }
}

// Duplicate-heavy input must stay near n log n.
for (const n of [1024, 2048]) {
  const v = Int32Array.from({ length: n }, (_, i) => (i * 2654435761) % 5);
  const r = runAll(v, { collect: false });
  checks++;
  if (r.cmp > 6 * n * Math.log2(n)) {
    failures++;
    console.error(`FAIL duplicates n=${n}: ${r.cmp} compares`);
  }
}

// Large-array path: every interaction still runs, nothing is sampled away.
for (const n of [8193, 32768, 65536, 262144]) {
  checkBig(`big random n=${n}`, shuffle(n, 77 + n));
  checkBig(`big reversed n=${n}`, Int32Array.from({ length: n }, (_, i) => n - i));
}
checkBig("big random 1M", shuffle(1 << 20, 31337));
checkBig("big sorted 1M", Int32Array.from({ length: 1 << 20 }, (_, i) => i + 1));

// Interaction counts scale as expected; guard against an accidental O(n^2) log.
{
  const n = 1 << 20;
  const r = runAll(shuffle(n, 4242), { collect: false });
  checks++;
  const perElement = r.totalEvents / (n * Math.log2(n));
  if (perElement > 8) {
    failures++;
    console.error(`FAIL event volume at 1M: ${r.totalEvents} interactions (${perElement.toFixed(2)} per n log n)`);
  }
  console.log(`1M interactions: ${r.totalEvents.toLocaleString()} (${perElement.toFixed(2)} per n log2 n)`);
}

checks++;
if (memory.buffer.byteLength !== 64 * 1024 * 1024) {
  failures++;
  console.error(`FAIL memory grew to ${memory.buffer.byteLength}`);
}

console.log(`worst compare ratio vs n*log2(n): ${worstRatio.toFixed(2)} — ${worstCase}`);
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
