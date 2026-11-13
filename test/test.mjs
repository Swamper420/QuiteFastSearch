// Correctness + trace-fidelity tests for the compiled Sluice Sort wasm module.
// Usage: node test/test.mjs [path/to/sluice.wasm]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, "..", "build", "sluice.wasm");

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const memory = ex.memory;

function run(values) {
  const n = values.length;
  const arr = new Int32Array(memory.buffer, ex.arr_ptr(), Math.max(n, 1));
  arr.set(values);
  ex.ssort(n);
  const sorted = Array.from(new Int32Array(memory.buffer, ex.arr_ptr(), n));

  const len = ex.trace_len();
  const raw = new Uint32Array(memory.buffer, ex.trace_ptr(), len * 2);
  const trace = new Uint32Array(raw); // copy before further calls clobber it

  return {
    sorted,
    trace,
    cmp: ex.cmp_total(),
    swaps: ex.swap_total(),
    steps: len,
  };
}

const OP = { CMP: 0, SWAP: 1, PIVOT: 2, RANGE: 3, LANE: 4, ORD: 5, REV: 6, INS: 7, DONE: 8, CMPV: 9, SET: 10, LANE2: 11 };

// Replay only the swap records; the result must equal the sorted array.
function replay(values, trace) {
  const mirror = Int32Array.from(values);
  const ops = new Set([OP.CMP, OP.SWAP, OP.PIVOT, OP.RANGE, OP.LANE, OP.ORD, OP.REV, OP.INS, OP.DONE, OP.CMPV, OP.SET, OP.LANE2]);
  let sawDone = false;
  for (let k = 0; k < trace.length; k += 2) {
    const op = trace[k];
    const i = trace[k + 1] & 0xffff;
    const j = trace[k + 1] >>> 16;
    if (!ops.has(op)) throw new Error(`unknown trace op ${op}`);
    if (op === OP.SWAP) {
      const t = mirror[i];
      mirror[i] = mirror[j];
      mirror[j] = t;
    } else if (op === OP.CMP || op === OP.SWAP || op === OP.PIVOT) {
      if (i >= mirror.length || (op === OP.CMP && j >= mirror.length)) {
        throw new Error(`op ${op} index out of range: ${i},${j}`);
      }
    } else if (op === OP.DONE) {
      sawDone = true;
    }
  }
  if (!sawDone) throw new Error("missing DONE record");
  return mirror;
}

let failures = 0;
let checks = 0;
let worstRatio = 0;
let worstCase = "";

function check(name, values) {
  checks++;
  const expected = [...values].sort((x, y) => x - y);
  const { sorted, trace, cmp, swaps, steps } = run(values);
  const got = Array.from(sorted);

  const same = got.length === expected.length && got.every((v, i) => v === expected[i]);
  if (!same) {
    failures++;
    console.error(`FAIL sort  ${name}: expected ${expected.slice(0, 16)}... got ${got.slice(0, 16)}...`);
    return;
  }

  const played = Array.from(replay(values, trace));
  const fidelity = played.every((v, i) => v === expected[i]);
  if (!fidelity) {
    failures++;
    console.error(`FAIL trace ${name}: replay diverged`);
    return;
  }

  // Sanity bound: sampling quicksort should stay far below n^2.
  const n = values.length;
  const bound = 12 * n * Math.max(1, Math.log2(Math.max(n, 2))) + 256;
  if (cmp > bound) {
    failures++;
    console.error(`FAIL budget ${name}: ${cmp} comparisons, bound ${bound.toFixed(0)}`);
    return;
  }

  if (n > 16) {
    const ratio = cmp / (n * Math.log2(n));
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstCase = `${name} (n=${n}, ${cmp} compares, ${swaps} swaps, ${steps} records)`;
    }
  }
}

function shuffle(n, seed) {
  const v = Array.from({ length: n }, (_, i) => i + 1);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [v[i], v[j]] = [v[j], v[i]];
  }
  return v;
}

// Time-lapse path: no per-operation trace, fixed-size sampled snapshots.
function runLapse(values, frames = 256, buckets = 512) {
  const n = values.length;
  new Int32Array(memory.buffer, ex.arr_ptr(), n).set(values);
  const got = ex.ssort_lapse(n, frames, buckets);
  const bk = ex.snap_bucket_count();
  const snap = new Int32Array(new Int32Array(memory.buffer, ex.snap_ptr(), got * bk));
  const sorted = new Int32Array(memory.buffer, ex.arr_ptr(), n);
  return { frames: got, buckets: bk, snap, sorted, cmp: ex.cmp_total(), swaps: ex.swap_total() };
}

function checkLapse(name, values) {
  checks++;
  const n = values.length;
  const r = runLapse(values);
  const expected = Int32Array.from(values).sort();

  for (let i = 0; i < n; i++) {
    if (r.sorted[i] !== expected[i]) {
      failures++;
      console.error(`FAIL lapse sort ${name}: wrong element at ${i}`);
      return;
    }
  }
  if (r.frames < 2 || r.frames > 256 || r.buckets !== 512) {
    failures++;
    console.error(`FAIL lapse shape ${name}: ${r.frames} frames x ${r.buckets}`);
    return;
  }

  const first = values[0], last = expected[n - 1];
  if (r.snap[0] !== first || r.snap[r.snap.length - 1] !== last) {
    failures++;
    console.error(`FAIL lapse endpoints ${name}: ${r.snap[0]}..${r.snap[r.snap.length - 1]}`);
    return;
  }

  const bound = 12 * n * Math.max(1, Math.log2(Math.max(n, 2))) + 256;
  if (r.cmp > bound) {
    failures++;
    console.error(`FAIL lapse budget ${name}: ${r.cmp} > ${bound.toFixed(0)}`);
  }
}

const sizes = [0, 1, 2, 3, 4, 5, 7, 8, 16, 17, 23, 24, 25, 33, 40, 41, 100, 257, 512, 1024, 2048, 8192];

for (const n of sizes) {
  check(`random n=${n}`, shuffle(n, 12345 + n));
  check(`sorted n=${n}`, Array.from({ length: n }, (_, i) => i + 1));
  check(`reversed n=${n}`, Array.from({ length: n }, (_, i) => n - i));
  check(`equal n=${n}`, new Array(n).fill(7));
  check(`two-values n=${n}`, Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 2)));
  check(`organ-pipe n=${n}`, Array.from({ length: n }, (_, i) => (i < n / 2 ? i + 1 : n - i)));
  check(`sawtooth n=${n}`, Array.from({ length: n }, (_, i) => (i % 7) + 1));
  check(`negatives n=${n}`, Array.from({ length: n }, (_, i) => ((i * 37) % 101) - 50));
}

// Nearly sorted: 1% of elements displaced.
for (const n of [64, 300, 1000]) {
  const v = Array.from({ length: n }, (_, i) => i + 1);
  for (let k = 0; k < Math.max(1, n / 100); k++) {
    const i = Math.floor((k * 7919) % n);
    const j = Math.min(n - 1, i + 1 + (k % 5));
    [v[i], v[j]] = [v[j], v[i]];
  }
  check(`nearly-sorted n=${n}`, v);
}

// Determinism: identical input must produce an identical trace.
{
  const v = shuffle(500, 99);
  const a = run(v);
  const b = run(v);
  checks++;
  if (a.trace.length !== b.trace.length || a.trace.some((x, i) => x !== b.trace[i])) {
    failures++;
    console.error("FAIL determinism");
  }
}

// Monotone inputs must be linear: n+1 compares or fewer.
for (const n of [256, 1024, 2048]) {
  const asc = run(Array.from({ length: n }, (_, i) => i + 1));
  const desc = run(Array.from({ length: n }, (_, i) => n - i));
  checks++;
  if (asc.cmp > n + 2 || desc.cmp > n + 2) {
    failures++;
    console.error(`FAIL linear monotone n=${n}: asc=${asc.cmp} desc=${desc.cmp}`);
  }
}

// Duplicate-heavy input must stay near linear-ish, not quadratic.
for (const n of [1024, 2048]) {
  const v = Array.from({ length: n }, (_, i) => (i * 2654435761) % 5);
  const r = run(v);
  checks++;
  if (r.cmp > 6 * n * Math.log2(n)) {
    failures++;
    console.error(`FAIL duplicates n=${n}: ${r.cmp} compares`);
  }
}

// Per-step tracing must not overflow its record budget at the largest
// size the viewer still animates step by step.
for (const n of [4096, 8192]) {
  run(shuffle(n, 4242 + n));
  checks++;
  if (ex.trace_over() !== 0) {
    failures++;
    console.error(`FAIL trace overflow at n=${n}: ${ex.trace_over()} dropped`);
  }
  checks++;
  if (ex.trace_len() > ex.trace_cap()) {
    failures++;
    console.error(`FAIL trace over capacity at n=${n}`);
  }
}

// Time-lapse path, including the 1M ceiling.
for (const n of [8193, 65536, 262144]) {
  checkLapse(`lapse random n=${n}`, shuffle(n, 77 + n));
  checkLapse(`lapse reversed n=${n}`, Array.from({ length: n }, (_, i) => n - i));
  checkLapse(`lapse dupes n=${n}`, Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 0) % 7));
}
checkLapse("lapse sorted 1M", Int32Array.from({ length: 1 << 20 }, (_, i) => i + 1));
checkLapse("lapse reversed 1M", Int32Array.from({ length: 1 << 20 }, (_, i) => (1 << 20) - i));
checkLapse("lapse random 1M", shuffle(1 << 20, 31337));

// wasm memory must stay at its declared size, no growth during big sorts.
checks++;
if (memory.buffer.byteLength !== 64 * 1024 * 1024) {
  failures++;
  console.error(`FAIL memory grew to ${memory.buffer.byteLength}`);
}

console.log(`worst compare ratio vs n*log2(n): ${worstRatio.toFixed(2)} — ${worstCase}`);
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
