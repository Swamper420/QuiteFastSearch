# Sluice Sort

A new sorting algorithm with a WebAssembly implementation and a single-file
browser visualizer. The whole demo — algorithm, UI, and the compiled wasm
module — is one HTML file with no network requests and no dependencies.

```
dist/sluice-sort.html     ← open this; 49 KiB, works offline
```

## What the algorithm does

Sluice Sort is an adaptive, in-place, three-lane quicksort. It is built from
known primitives composed in a particular way, not a claim of asymptotic
novelty.

1. **Gate check** — scan the range once for non-decreasing order and exit if it
   holds. Sorted input costs `n-1` comparisons, no swaps.
2. **Spillway check** — scan once for non-increasing order, then reverse in
   place. Reverse-sorted input is also `O(n)`.
3. **Gate pick** — median of five evenly spaced probes (`median-of-3` for
   ranges under 40). Stratified probes cannot cluster in one region, which
   keeps partitions balanced on partially ordered data.
4. **Three-lane split** — a Dutch-flag pass routes each element to `< pivot`,
   `= pivot`, or `> pivot`. The equal lane is final immediately, so inputs with
   few distinct keys never recurse on duplicates.
5. **Settle** — lanes smaller than 24 elements finish with insertion sort,
   which is faster than another partition at that size.
6. **Drift** — loop on the smaller lane and push the larger one. The explicit
   stack is therefore bounded by `O(log n)` even when pivots are bad, and no
   recursion can overflow the wasm stack.

| case | comparisons | notes |
| --- | --- | --- |
| sorted / reverse-sorted | `n-1` | monotone absorption |
| random | ~`1.1–1.2 n log₂n` | measured, see tests |
| few distinct keys | `O(n log k)` | equal lane is final |
| worst | `O(n²)` | adversarial pivot sampling |

Auxiliary space: `O(log n)` stack, zero heap allocation. All comparisons and
moves are appended to a trace log (8 bytes per record), so a host can replay
and animate the sort deterministically instead of re-running it.

## Why WebAssembly in one file

The wasm module has **zero imports**: no libc, no allocator, no JavaScript glue.
It exports `ssort(n)` plus a few accessors and owns its memory. The page needs
only `WebAssembly.instantiate(bytes)`.

The module is embedded as base64 inside a `<script>` tag, so the page has no
`fetch`, no `.wasm` file, no build step at runtime, and works from `file://`:

```js
const bytes = Uint8Array.from(atob(WASM_B64), (c) => c.charCodeAt(0));
const { instance } = await WebAssembly.instantiate(bytes, {});
```

That is the whole integration story. It is not just possible — the compiled
module is 8.3 KiB, smaller than most icon fonts.

## Build

Needs `clang` with the wasm32 target and a wasm linker. `rust-lld` (shipped with
Rust) works and is what the script prefers; `wasm-ld` from LLVM's lld also works.

```bash
./tools/build-wasm.sh      # C -> build/sluice.wasm
node tools/build-html.mjs  # build/sluice.wasm + web/template.html -> dist/sluice-sort.html
```

No emscripten, no wabt, no npm dependencies.

## Test

```bash
node test/test.mjs
```

202 checks: sizes 0–1,048,576, random / sorted / reversed / constant / duplicate /
organ-pipe / sawtooth / negative inputs, plus:

- **trace fidelity** — replaying only the `SWAP` records from the log must
  reproduce the sorted array, so the animation cannot drift from the algorithm;
- **determinism** — same input, byte-identical trace;
- **linear monotone** — sorted and reversed inputs use at most `n+1` compares;
- **budget** — no input exceeds `12 n log₂n + 256` compares.

Latest run: `202/202 checks passed`, worst case `1.14–1.23 n log₂n`.

## Using the demo

| control | meaning |
| --- | --- |
| size / input | 16 … 1,048,576 on a log slider, a number field, or the 1k/8k/64k/262k/1M presets |
| speed | steps per second (10 … 100k); frames per second in time-lapse mode |
| step, restart, new array | manual control; `space`, `s`, `r`, `n` |
| ♪ sound | synthesized blips on/off; `m` |
| timeline | scrub anywhere; seeking backwards replays from the start |

Deep links: `dist/sluice-sort.html?n=512&pattern=dupes&step=1200` opens paused at
that step, which is handy for screenshots and bug reports.

Sound is synthesized on the fly with Web Audio — no audio files, so the page stays
one file. Comparisons tick, swaps bloop downward, pivots chime, settled ranges
sparkle, and the finished sort plays a short arpeggio. Pitches come from a
pentatonic scale mapped to element values, so dense playback stays musical
instead of turning to noise; notes are rate-limited to ~55/s. Browsers keep
audio suspended until a click or key press, so press anything once.

### Large arrays

Per-step tracing costs `O(n log n)` 8-byte records, so it is capped at 8,192
elements (worst observed: ~300k records of the 1M budget). Above that the wasm
module switches to **time-lapse** mode: it sorts with tracing off and samples
512 strided elements into 256 fixed frames (512 KiB total, independent of `n`).
The viewer interpolates between frames, so a million elements still animate
smoothly without holding a million-element replay log.

Measured in Chromium (headless, this machine): 1,000,000 shuffled elements sort
in ~280 ms with 22.6M comparisons (1.16× `n log₂n`), verified sorted on readback.
Memory is fixed: 4 MiB array, 8 MiB trace buffer, 0.5 MiB snapshots, 64 MiB wasm
memory. Deep links accept any size: `?n=1000000&step=90`.

Colours: blue = `< pivot` lane, teal = `= pivot` lane, slate = still unexamined,
amber = `> pivot`, green = settled, magenta marker = pivot, warm flash =
comparison/swap activity.

## Layout

```
src/sluice.c          algorithm + host API (freestanding C)
web/template.html     visualizer + player (placeholder for the wasm blob)
tools/build-wasm.sh   clang + rust-lld compile and link
tools/build-html.mjs  base64 inline and single-file check
test/test.mjs         correctness, trace fidelity, budgets
dist/sluice-sort.html generated artifact
```

## Caveats

- Worst case stays `O(n²)`; sampling quicksorts always keep that risk. The
  equal-lane split removes the duplicate-key pathology but not adversarial
  pivot selection.
- The "novelty" is compositional. If you need a literature claim, benchmark
  against pdqsort/IPS⁴o before making one.
- Per-step tracing costs memory and writes: ~317k records at the 8,192-element
  cap, against a 1,048,576-record (8 MiB) budget. If a run ever overflows that
  budget the viewer falls back to time-lapse automatically. The sorting path
  itself does not allocate: all buffers are fixed at compile time.
