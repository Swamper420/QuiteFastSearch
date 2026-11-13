/*
 * Sluice Sort — resumable engine.
 *
 * The sort is a state machine, not a loop: every call to eng_batch() advances
 * the algorithm by a bounded number of interactions and leaves the exact
 * continuation on an explicit frame stack. That means the host can watch
 * *every* comparison and swap without the engine ever allocating a trace of
 * O(n log n) records, and without the sort being restarted to seek.
 *
 * Layout is fixed at compile time:
 *   a[]      4 MiB   the array (up to 1M ints)
 *   evbuf    ~400 KiB   one batch of interactions, 3 u32 each
 *   st[]     ~7 KiB   continuation frames
 *   snap     ~2 KiB   downsampled column samples for the viewer
 *
 * Freestanding wasm32: no libc, no allocator, no imports.
 */

#define MAXN 1048576
#define CUTOFF 24
#define EVBUF 262144
#define SNAP_MAX 512
#define MAXDEPTH 128

typedef unsigned int u32;

enum {
  OP_CMP   = 0,  /* compare a[i] with a[j]                      */
  OP_SWAP  = 1,  /* swap a[i] and a[j]                          */
  OP_PIVOT = 2,  /* pivot parked at index i                     */
  OP_RANGE = 3,  /* partition range [i, j) becomes active       */
  OP_LANE  = 4,  /* gate: provisional boundaries (lt, gt)       */
  OP_ORD   = 5,  /* range [i, j) proved ordered                 */
  OP_REV   = 6,  /* range [i, j) proved reversed, reversing     */
  OP_INS   = 7,  /* insertion sort starts on [i, j)             */
  OP_DONE  = 8,  /* whole array settled                         */
  OP_CMPV  = 9,  /* compare a[i] with the pivot value           */
  OP_SET   = 10, /* range [i, j) is final                       */
  OP_LANE2 = 11  /* gate: equals/unknown boundary at index i    */
};

enum {
  F_RANGE = 1, F_ORDER, F_REVCHK, F_REVERSE, F_MED3, F_MED5, F_SPLIT, F_INSERT
};

struct frame {
  int kind, lo, hi, i, j, v, pp, gt, step;
  int s[5];
};

static int a[MAXN];
static struct frame st[MAXDEPTH];
static int sp;
static int n_global;

static u32 evbuf[EVBUF * 3];
static int ev_count, ev_cap;
static u32 cmp_count, swap_count, ev_total, ev_dropped;
static int done_flag;

static u32 snap[SNAP_MAX];
static int snap_n;

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

/* ---- interaction log --------------------------------------------------- */

static void emit(int op, int x, int y) {
  u32 *p;
  if (ev_count >= ev_cap) { ev_dropped++; return; }
  p = &evbuf[ev_count * 3];
  p[0] = (u32)op;
  p[1] = (u32)x;
  p[2] = (u32)y;
  ev_count++;
  ev_total++;
}

static void emit_force(int op, int x, int y) {
  u32 *p;
  if (ev_count >= EVBUF) { ev_dropped++; return; }
  p = &evbuf[ev_count * 3];
  p[0] = (u32)op;
  p[1] = (u32)x;
  p[2] = (u32)y;
  ev_count++;
  ev_total++;
}

static int cmp_at(int i, int j) {
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

/* ---- frame stack ------------------------------------------------------- */

static void push_frame(int kind, int lo, int hi) {
  struct frame *f;
  if (sp >= MAXDEPTH) return; /* unreachable: larger side stays in place */
  f = &st[sp++];
  f->kind = kind;
  f->lo = lo;
  f->hi = hi;
  f->i = f->j = f->v = f->pp = f->gt = f->step = 0;
  f->s[0] = f->s[1] = f->s[2] = f->s[3] = f->s[4] = 0;
}

static void samples5(struct frame *f) {
  int len = f->hi - f->lo, k;
  for (k = 0; k < 5; k++) {
    f->s[k] = f->lo + (len * (k + 1)) / 6;
    if (f->s[k] >= f->hi) f->s[k] = f->hi - 1;
  }
}

static void step_one(void) {
  struct frame *f = &st[sp - 1];
  int len;

  switch (f->kind) {
  case F_RANGE:
    len = f->hi - f->lo;
    if (len < 2) { sp--; return; }
    emit(OP_RANGE, f->lo, f->hi);
    if (len <= CUTOFF) {
      emit(OP_INS, f->lo, f->hi);
      f->kind = F_INSERT;
      f->i = f->lo + 1;
      f->j = f->lo + 1;
      return;
    }
    f->kind = F_ORDER;
    f->i = f->lo + 1;
    return;

  case F_ORDER:
    if (f->i >= f->hi) {
      emit(OP_ORD, f->lo, f->hi);
      emit(OP_SET, f->lo, f->hi);
      sp--;
      return;
    }
    if (cmp_at(f->i - 1, f->i) > 0) {
      f->kind = F_REVCHK;
      f->i = f->lo + 1;
      return;
    }
    f->i++;
    return;

  case F_REVCHK:
    if (f->i >= f->hi) {
      emit(OP_REV, f->lo, f->hi);
      f->kind = F_REVERSE;
      f->i = f->lo;
      f->j = f->hi - 1;
      return;
    }
    if (cmp_at(f->i - 1, f->i) < 0) {
      len = f->hi - f->lo;
      if (len <= 40) {
        f->kind = F_MED3;
        f->step = 0;
        f->i = f->lo;
        f->j = f->lo + (len >> 1);
        f->v = f->hi - 1;
      } else {
        f->kind = F_MED5;
        f->step = 0;
      }
      return;
    }
    f->i++;
    return;

  case F_REVERSE:
    if (f->i >= f->j) {
      emit(OP_SET, f->lo, f->hi);
      sp--;
      return;
    }
    swap_at(f->i, f->j);
    f->i++;
    f->j--;
    return;

  case F_MED3:
    switch (f->step) {
    case 0: f->step = cmp_at(f->i, f->j) > 0 ? 1 : 2; return;
    case 1: swap_at(f->i, f->j); f->step = 2; return;
    case 2: f->step = cmp_at(f->j, f->v) > 0 ? 3 : 4; return;
    case 3: swap_at(f->j, f->v); f->step = 4; return;
    case 4: f->step = cmp_at(f->i, f->j) > 0 ? 5 : 6; return;
    case 5: swap_at(f->i, f->j); f->step = 6; return;
    default:
      f->kind = F_SPLIT;
      f->pp = f->j;
      f->step = 0;
      return;
    }

  case F_MED5:
    if (f->step == 0) {
      samples5(f);
      f->i = 1;
      f->j = 1;
      f->step = 1;
      return;
    }
    if (f->i >= 5) {
      f->kind = F_SPLIT;
      f->pp = f->s[2];
      f->step = 0;
      return;
    }
    if (f->j > 0 && cmp_at(f->s[f->j - 1], f->s[f->j]) > 0) {
      int t = f->s[f->j - 1];
      f->s[f->j - 1] = f->s[f->j];
      f->s[f->j] = t;
      f->j--;
      return;
    }
    f->i++;
    f->j = f->i;
    return;

  case F_SPLIT:
    if (f->step == 0) {
      swap_at(f->pp, f->lo);
      emit(OP_PIVOT, f->lo, 0);
      f->v = a[f->lo];
      f->pp = f->lo;
      f->j = f->lo;      /* lt */
      f->i = f->lo + 1;  /* scan */
      f->gt = f->hi;
      f->step = 1;
      return;
    }
    if (f->i >= f->gt) {
      int e0 = f->j, e1 = f->i, lo = f->lo, hi = f->hi;
      int lsz = e0 - lo, rsz = hi - e1;
      emit(OP_SET, e0, e1);
      if (lsz == 0 && rsz == 0) { sp--; return; }
      if (lsz <= rsz) {
        push_frame(F_RANGE, lo, e0);
        f->kind = F_RANGE;
        f->lo = e1;
        f->hi = hi;
      } else {
        push_frame(F_RANGE, e1, hi);
        f->kind = F_RANGE;
        f->lo = lo;
        f->hi = e0;
      }
      return;
    }
    {
      int c = cmp_value(f->i, f->v);
      if (c < 0) {
        int moves = (f->j == f->pp);
        swap_at(f->j, f->i);
        if (moves) {
          f->pp = f->i;
          emit(OP_PIVOT, f->pp, 0);
        }
        f->j++;
        f->i++;
      } else if (c > 0) {
        f->gt--;
        swap_at(f->i, f->gt);
      } else {
        f->i++;
      }
      if ((f->i & 3) == 0) {
        emit(OP_LANE, f->j, f->gt);
        emit(OP_LANE2, f->i, 0);
      }
      return;
    }

  case F_INSERT:
    if (f->j > f->lo && cmp_at(f->j - 1, f->j) > 0) {
      swap_at(f->j - 1, f->j);
      f->j--;
      return;
    }
    f->i++;
    if (f->i >= f->hi) {
      emit(OP_SET, f->lo, f->hi);
      sp--;
      return;
    }
    f->j = f->i;
    return;

  default:
    sp--;
    return;
  }
}

/* ---- public API -------------------------------------------------------- */

int arr_ptr(void)   { return (int)(long)&a[0]; }
int evbuf_ptr(void) { return (int)(long)&evbuf[0]; }
int evbuf_cap(void) { return EVBUF; }
int cmp_total(void) { return (int)cmp_count; }
int swap_total(void){ return (int)swap_count; }
int events_total(void) { return (int)ev_total; }
int events_dropped(void) { return (int)ev_dropped; }
int is_done(void)   { return done_flag && sp == 0; }
int max_n(void)     { return MAXN; }
int snap_ptr(void)  { return (int)(long)&snap[0]; }
int snap_count(void){ return snap_n; }

int begin_sort(int n) {
  n_global = n < 0 ? 0 : (n > MAXN ? MAXN : n);
  cmp_count = 0;
  swap_count = 0;
  ev_total = 0;
  ev_dropped = 0;
  ev_count = 0;
  ev_cap = 0;
  done_flag = 0;
  sp = 0;
  if (n_global >= 2) push_frame(F_RANGE, 0, n_global);
  return n_global;
}

int eng_batch(int limit) {
  if (limit < 8) limit = 8;
  if (limit > EVBUF - 8) limit = EVBUF - 8;
  ev_count = 0;
  ev_cap = limit;
  while (sp > 0 && ev_count + 8 <= ev_cap) step_one();
  if (sp == 0 && !done_flag) {
    emit_force(OP_DONE, 0, n_global);
    done_flag = 1;
  }
  return ev_count;
}

/* Downsampled column samples of the live array, for the wide view. */
int snapshot(int buckets) {
  int b, n = n_global;
  if (buckets < 8) buckets = 8;
  if (buckets > SNAP_MAX) buckets = SNAP_MAX;
  snap_n = buckets;
  if (n <= 0) {
    for (b = 0; b < buckets; b++) snap[b] = 0;
    return buckets;
  }
  if (n == 1) {
    for (b = 0; b < buckets; b++) snap[b] = (u32)a[0];
    return buckets;
  }
  for (b = 0; b < buckets; b++)
    snap[b] = (u32)a[(int)(((long)b * (n - 1)) / (buckets - 1))];
  return buckets;
}
