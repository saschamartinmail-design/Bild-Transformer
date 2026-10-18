/* Bildtransformer – Rechenprozess für genau ein KI-Modell.
   Jedes Modell läuft in einem eigenen, kurzlebigen Prozess. Wird er beendet, gibt das Handy
   den gesamten Arbeitsspeicher der Rechen-Engine sofort wieder frei (WebAssembly-Speicher
   kann sonst nicht schrumpfen und würde sich über alle Modelle hinweg aufsummieren). */
import * as ort from './ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('./ort/', self.location.href).href;
const cores = navigator.hardwareConcurrency || 2;
ort.env.wasm.numThreads = self.crossOriginIsolated ? (cores >= 4 ? Math.min(4, cores - 1) : cores) : 1;

let sess = null;

// Ausgabe aus der Rechen-Engine in einen eigenen, übertragbaren Puffer bringen
function own(data) {
  const b = data.buffer;
  if (b instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === b.byteLength) return data;
  return data.slice();
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'load') {
      let buf = new Uint8Array(m.buffer);
      sess = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: m.opt || 'all' });
      buf = null;
      self.postMessage({ id: m.id, ok: true, inputNames: sess.inputNames, outputNames: sess.outputNames });
    } else if (m.cmd === 'run') {
      const feeds = {};
      for (const k of Object.keys(m.feeds)) { const t = m.feeds[k]; feeds[k] = new ort.Tensor(t.type, t.data, t.dims); }
      const out = await sess.run(feeds);
      const res = {}, tr = [];
      for (const k of sess.outputNames) {
        const d = own(out[k].data);
        res[k] = { type: out[k].type, data: d, dims: out[k].dims };
        tr.push(d.buffer);
      }
      self.postMessage({ id: m.id, ok: true, out: res }, tr);
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
self.postMessage({ ready: true, threads: ort.env.wasm.numThreads });
