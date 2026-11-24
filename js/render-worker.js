import { renderStrip } from './render.js';

self.onmessage = (e) => {
  const m = e.data;
  try {
    const buf = renderStrip(m);
    self.postMessage({ id: m.id, ok: true, buf }, [buf.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.stack) || err) });
  }
};
