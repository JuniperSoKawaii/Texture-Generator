// A small pool of render workers. Tasks carry a `group` so stale preview work can be dropped.
export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

export class Pool {
  constructor(n) {
    this.idle = []; this.queue = []; this.pending = new Map(); this.seq = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._done(w, e.data);
      w.onerror = (e) => { console.error('Worker error', e); };
      this.idle.push(w);
    }
  }

  run(msg, group, priority = false) {
    return new Promise((resolve, reject) => {
      const t = { msg, resolve, reject, group, pri: priority };
      const idx = priority ? this.queue.findIndex((x) => !x.pri) : -1;
      if (idx >= 0) this.queue.splice(idx, 0, t); else this.queue.push(t);
      this._pump();
    });
  }

  cancel(group) {
    this.queue = this.queue.filter((t) => {
      if (t.group !== group) return true;
      t.reject(new CancelledError());
      return false;
    });
    for (const t of this.pending.values()) if (t.group === group) t.cancelled = true;
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(), t = this.queue.shift();
      const id = ++this.seq;
      this.pending.set(id, t);
      w.postMessage({ ...t.msg, id });
    }
  }

  _done(w, d) {
    const t = this.pending.get(d.id);
    this.pending.delete(d.id);
    this.idle.push(w);
    if (t) {
      if (t.cancelled) t.reject(new CancelledError());
      else if (d.ok) t.resolve(d.buf);
      else t.reject(new Error(d.error));
    }
    this._pump();
  }
}

// Render an image of outW × outH output pixels in strips. `onStrip(row, rows, buf)` is
// called strictly in order (it may be async), so encoders can stream.
export async function renderImage(pool, spec, { outW, outH, step = 1, x0 = 0, y0 = 0, group, onStrip, onProgress, stripPixels = 262144, priority = false }) {
  const rows = Math.max(1, Math.min(outH, Math.floor(stripPixels / outW)));
  const jobs = [];
  for (let r = 0; r < outH; r += rows) {
    const h = Math.min(rows, outH - r);
    jobs.push({ r, h, p: pool.run({ ...spec, x0, y0: y0 + r * step, w: outW, h, step }, group, priority) });
  }
  // Avoid unhandled rejections for jobs we never await after a failure.
  jobs.forEach((j) => j.p.catch(() => {}));
  let done = 0;
  for (const j of jobs) {
    const buf = await j.p;
    await onStrip(j.r, j.h, buf);
    done += j.h;
    if (onProgress) onProgress(done / outH);
  }
}
