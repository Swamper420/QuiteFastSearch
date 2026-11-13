/*
 * Sluice Sort — an adaptive three-lane in-place quicksort.
 *
 * Freestanding wasm32: no libc, no allocator, no imports, no start function.
 * The host fills `a[0..n)` in linear memory, calls ssort(n), then reads the
 * trace log to replay the sort deterministically.
 *
 * Algorithm
 * ---------
 * 1. Gate check: scan for a non-decreasing range and stop. O(n) on sorted
 *    input, and a cheap early exit (2 compares) on random input.
 * 2. Spillway check: scan for a non-increasing range, then reverse in place.
 *    O(n) on reverse-sorted input.
 * 3. Gate pick: stratified median-of-5 sample (median-of-3 for small ranges).
 * 4. Three-lane split (Dutch flag): < pivot | == pivot | > pivot. The equal
 *    lane is final and never revisited, so duplicate-heavy input collapses.
 * 5. Small lanes (< CUTOFF) settle with insertion sort.
 * 6. The larger lane is pushed; the smaller lane is looped on, bounding the
 *    explicit stack to O(log n) regardless of pivot quality.
 *
 * Complexity: O(n) best case, O(n log n) expected, O(log n) auxiliary stack.
 * Worst case O(n^2) remains possible (adversarial pivot sampling), as with
 * every sampling quicksort.
 */

#define MAXN 2048
#define TRACE_RECORDS 262144u
#define CUTOFF 24

typedef unsigned int u32;

enum {
  OP_CMP  = 0, /* compare a[i] with a[j]                     */
  OP_SWAP = 1, /* swap a[i] and a[j]                         */
  OP_PIVOT= 2, /* pivot parked at index i                    */
  OP_RANGE= 3, /* partition range [i, j) becomes active      */
  OP_LANE = 4, /* gate: provisional boundaries (lo_lt, gt)   */
  OP_ORD  = 5, /* range [i, j) proved ordered, settled       */
  OP_REV  = 6, /* range [i, j) proved reversed, reversing    */
  OP_INS  = 7, /* insertion sort starts on [i, j)            */
  OP_DONE = 8, /* whole array settled                        */
  OP_CMPV = 9, /* compare a[i] with the pivot value           */
  OP_SET  = 10, /* range [i, j) is final                     */
  OP_LANE2= 11  /* gate: equals/unknown boundary at index i   */
};

#define SLOT(i,j) (((u32)(i) & 0xFFFFu) | (((u32)(j) & 0xFFFFu) << 16))

static int a[MAXN];
static u32 trace[TRACE_RECORDS * 2u];
static u32 tcount;
static u32 cmp_count;
static u32 swap_count;

/* Freestanding helpers: clang may lower struct copies to these. */
void *memcpy(void *d, const void *s, u32 n) {
  unsigned char *dd = (unsigned char *)d;
  const unsigned char *ss = (const unsigned char *)s;
  while (n--) *dd++ = *ss++;
  return d;
}
void *memset(void *d, int c, u32 n) {
  unsigned char *dd = (unsigned char *)d;
  while (n--) *dd++ = (unsigned char)c;
  return d;
}
void *memmove(void *d, const void *s, u32 n) { return memcpy(d, s, n); }

static void emit(int op, int x, int y) {
  u32 *p;
  if (tcount >= TRACE_RECORDS) return;
  p = &trace[tcount * 2u];
  p[0] = (u32)op;
  p[1] = SLOT(x, y);
  tcount++;
}

static int cmp(int i, int j) {
  int x, y;
  cmp_count++;
  emit(OP_CMP, i, j);
  x = a[i]; y = a[j];
  return (x > y) - (x < y);
}

static int cmp_value(int i, int v) {
  int x = a[i];
  cmp_count++;
  emit(OP_CMPV, i, 0);
  return (x > v) - (x < v);
}

static void swap_at(int i, int j) {
  int t = a[i];
  a[i] = a[j];
  a[j] = t;
  if (i != j) swap_count++;
  emit(OP_SWAP, i, j);
}

static int range_ordered(int lo, int hi) {
  int i;
  for (i = lo + 1; i < hi; i++)
    if (cmp(i - 1, i) > 0) return 0;
  return 1;
}

static int range_reversed(int lo, int hi) {
  int i;
  for (i = lo + 1; i < hi; i++)
    if (cmp(i - 1, i) < 0) return 0;
  return 1;
}

static void reverse_range(int lo, int hi) {
  int i, j;
  emit(OP_REV, lo, hi);
  for (i = lo, j = hi - 1; i < j; i++, j--) swap_at(i, j);
}

static void insertion_sort(int lo, int hi) {
  int i;
  emit(OP_INS, lo, hi);
  for (i = lo + 1; i < hi; i++) {
    int j = i;
    while (j > lo && cmp(j - 1, j) > 0) {
      swap_at(j - 1, j);
      j--;
    }
  }
  emit(OP_SET, lo, hi);
}

/* Median-of-3 over positions lo, mid, hi-1. */
static int median3(int lo, int hi) {
  int x = lo, y = lo + ((hi - lo) >> 1), z = hi - 1;
  if (cmp(x, y) > 0) swap_at(x, y);
  if (cmp(y, z) > 0) swap_at(y, z);
  if (cmp(x, y) > 0) swap_at(x, y);
  return y;
}

/*
 * Stratified sampling: take five evenly spaced probes and return their
 * median. Beats median-of-3 on partially ordered input because the probes
 * cannot cluster in one region of the range.
 */
static int median5_stratified(int lo, int hi) {
  int s[5], i, j, t, len = hi - lo;
  for (i = 0; i < 5; i++) {
    s[i] = lo + (len * (i + 1)) / 6;
    if (s[i] >= hi) s[i] = hi - 1;
  }
  for (i = 1; i < 5; i++) {
    t = s[i];
    for (j = i - 1; j >= 0 && cmp(s[j], t) > 0; j--) s[j + 1] = s[j];
    s[j + 1] = t;
  }
  return s[2];
}

/* Dutch-flag split. Leaves [lo,e0) < v, [e0,e1) == v, [e1,hi) > v.
 * Emits gate records every few probes so a viewer can watch the two
 * frontiers close in: [lo,lt) settled under, [lt,i) equal, [i,gt) unknown,
 * [gt,hi) settled over. */
static void split3(int lo, int hi, int pivot, int *e0, int *e1) {
  int v, lt, i, gt, ppos;
  swap_at(pivot, lo);
  emit(OP_PIVOT, lo, 0);
  v = a[lo];
  ppos = lo;
  lt = lo;
  i = lo + 1;
  gt = hi;
  while (i < gt) {
    int c = cmp_value(i, v);
    if (c < 0) {
      int moves = (lt == ppos);
      swap_at(lt, i);
      if (moves) {
        ppos = i;
        emit(OP_PIVOT, ppos, 0);
      }
      lt++;
      i++;
    } else if (c > 0) swap_at(i, --gt);
    else i++;
    if ((i & 3) == 0) {
      emit(OP_LANE, lt, gt);
      emit(OP_LANE2, i, 0);
    }
  }
  emit(OP_LANE, lt, gt);
  emit(OP_LANE2, i, 0);
  *e0 = lt;
  *e1 = i;
}

struct span { int lo, hi; };
static struct span stack_[64];
static int sp;

static void push_range(int lo, int hi) {
  if (sp < 64) {
    stack_[sp].lo = lo;
    stack_[sp].hi = hi;
    sp++;
  }
}

int ssort(int n) {
  tcount = 0;
  cmp_count = 0;
  swap_count = 0;
  sp = 0;
  if (n < 0) n = 0;
  if (n > MAXN) n = MAXN;
  if (n < 2) {
    emit(OP_DONE, 0, n);
    return 0;
  }
  push_range(0, n);
  while (sp > 0) {
    int lo, hi;
    sp--;
    lo = stack_[sp].lo;
    hi = stack_[sp].hi;
    for (;;) {
      int len = hi - lo, e0, e1, lsz, rsz;
      if (len < 2) break;
      emit(OP_RANGE, lo, hi);
      if (len <= CUTOFF) {
        insertion_sort(lo, hi);
        break;
      }
      if (range_ordered(lo, hi)) {
        emit(OP_ORD, lo, hi);
        emit(OP_SET, lo, hi);
        break;
      }
      if (range_reversed(lo, hi)) {
        reverse_range(lo, hi);
        emit(OP_SET, lo, hi);
        break;
      }
      split3(lo, hi,
             len <= 40 ? median3(lo, hi) : median5_stratified(lo, hi),
             &e0, &e1);
      emit(OP_SET, e0, e1);
      lsz = e0 - lo;
      rsz = hi - e1;
      if (lsz == 0 && rsz == 0) break;
      if (lsz < rsz) {
        push_range(e1, hi);
        hi = e0;
      } else {
        push_range(lo, e0);
        lo = e1;
      }
    }
  }
  emit(OP_DONE, 0, n);
  return (int)cmp_count;
}

/* Host API -------------------------------------------------------------- */

int arr_ptr(void)   { return (int)(long)&a[0]; }
int trace_ptr(void) { return (int)(long)&trace[0]; }
int trace_len(void) { return (int)tcount; }
int cmp_total(void) { return (int)cmp_count; }
int swap_total(void){ return (int)swap_count; }
int max_n(void)     { return MAXN; }
