/* Bildtransformer – KI-Worker. Läuft im Hintergrund-Thread, damit die Oberfläche flüssig bleibt.
   Alle Berechnungen passieren hier im Browser; Bilder verlassen das Gerät nie. */
// Die Rechen-Engine (onnxruntime-web 1.30.0) liegt im App-Ordner, damit sie offline und mit mehreren Threads läuft.
import * as ort from './ort/ort.wasm.min.mjs';
import './core.js';

const BT = self.BT;
ort.env.wasm.wasmPaths = new URL('./ort/', self.location.href).href;
const cores = navigator.hardwareConcurrency || 2;
ort.env.wasm.numThreads = self.crossOriginIsolated ? (cores >= 4 ? Math.min(4, cores - 1) : cores) : 1;

// Modelle werden nur einmal geladen und danach im Browser-Speicher (Cache Storage) aufbewahrt.
const MODELS = {
  det: {
    name: 'Texterkennung', mb: 5,
    urls: [
      new URL('./models/ch_PP-OCRv4_det_infer.onnx', self.location.href).href,
      'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_det_infer.onnx',
      'https://unpkg.com/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_det_infer.onnx',
    ],
  },
  migan: {
    name: 'Rekonstruktion', mb: 28,
    urls: [
      'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
      'https://cdn.jsdelivr.net/npm/migan-onnx@1.0.0/models/migan_pipeline_v2.onnx',
      'https://unpkg.com/migan-onnx@1.0.0/models/migan_pipeline_v2.onnx',
    ],
  },
  lama: {
    name: 'Rekonstruktion (Höchste Qualität)', mb: 208,
    urls: ['https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx'],
  },
};
const MODEL_CACHE = 'bt-models-v1';
const sessions = {};
let currentJob = 0;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (text, frac) => post({ type: 'progress', job: currentJob, text, frac: frac == null ? null : frac });

async function cachedModel(key) {
  const cache = await caches.open(MODEL_CACHE);
  for (const url of MODELS[key].urls) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  return null;
}

async function fetchModel(key) {
  const m = MODELS[key];
  const hit = await cachedModel(key);
  if (hit) return hit;
  let lastErr = null;
  for (const url of m.urls) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || m.mb * 1e6;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          status(`Einmaliger Download: ${m.name} (${Math.round(got / 1e6)} von ${Math.round(total / 1e6)} MB)`, Math.min(1, got / total));
        }
      }
      if (got < 1e6) throw new Error('unvollständige Datei');
      const buf = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.length; }
      const cache = await caches.open(MODEL_CACHE);
      await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
      return buf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${m.name} konnte nicht geladen werden (${lastErr ? lastErr.message : 'unbekannt'}). Beim ersten Start ist eine Internetverbindung nötig.`);
}

async function getSession(key) {
  if (!sessions[key]) {
    const buf = await fetchModel(key);
    status(`${MODELS[key].name} wird vorbereitet …`, null);
    sessions[key] = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  return sessions[key];
}

// ---------------------------------------------------------------- KI-Schritte
async function detectMask(img, opt) {
  const det = await getSession('det');
  status('Schrift wird gesucht …', null);
  const inp = BT.detInput(img, 1280);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', inp.data, [1, 3, inp.height, inp.width]) });
  const prob = out[det.outputNames[0]].data;
  return BT.textMaskFromProb(prob, inp.width, inp.height, img.width, img.height, opt);
}

function modelRunner(key, sess) {
  if (key === 'lama') {
    return async (crop, cmask) => {
      const f = BT.lamaFeeds(crop, cmask, 512);
      const out = await sess.run({
        [sess.inputNames[0]]: new ort.Tensor('float32', f.image, [1, 3, 512, 512]),
        [sess.inputNames[1]]: new ort.Tensor('float32', f.mask, [1, 1, 512, 512]),
      });
      const small = BT.fromCHW(out[sess.outputNames[0]].data, 512, 512, 1);
      return BT.resizeRGBA(small, crop.width, crop.height);
    };
  }
  return async (crop, cmask) => {
    const f = BT.miganFeeds(crop, cmask);
    const out = await sess.run({
      [sess.inputNames[0]]: new ort.Tensor('uint8', f.image, [1, 3, crop.height, crop.width]),
      [sess.inputNames[1]]: new ort.Tensor('uint8', f.mask, [1, 1, crop.height, crop.width]),
    });
    return BT.fromCHW(out[sess.outputNames[0]].data, crop.width, crop.height);
  };
}

async function inpaint(img, mask, quality, opt) {
  const key = quality === 'high' ? 'lama' : 'migan';
  const sess = await getSession(key);
  const o = Object.assign({ win: key === 'lama' ? 768 : 1024 }, opt || {});
  o.onProgress = (i, n) => status(n > 1 ? `Bild wird rekonstruiert (${i} von ${n})` : 'Bild wird rekonstruiert …', n > 1 ? i / n : null);
  status('Bild wird rekonstruiert …', null);
  return BT.inpaintTiles(img, mask, modelRunner(key, sess), o);
}

// Nach dem Füllen: übrig gebliebene Schriftreste in der Nähe der Maske suchen und nachfüllen
async function cleanupPass(res, mask, quality) {
  const W = res.width, H = res.height;
  const near = BT.dilate(mask, W, H, Math.round(0.02 * Math.max(W, H)));
  const resid = BT.maskIntersect(await detectMask(res, { thresh: 0.25, boxThresh: 0.4 }), near);
  if (BT.maskArea(resid) === 0) return { image: res, mask };
  status('Reste werden entfernt …', null);
  const out = await inpaint(res, resid, quality, { shift: 0.5 });
  return { image: out, mask: BT.maskUnion(mask, resid) };
}

// ---------------------------------------------------------------- Aufträge
const toImg = (o) => ({ data: new Uint8ClampedArray(o.buffer), width: o.width, height: o.height });
const reply = (id, img, extra) => {
  const msg = Object.assign({ type: 'done', id }, extra || {});
  const tr = [];
  if (img) { msg.image = { buffer: img.data.buffer, width: img.width, height: img.height }; tr.push(img.data.buffer); }
  if (msg.mask) tr.push(msg.mask.buffer);
  post(msg, tr);
};

const handlers = {
  async warmup(m) {
    for (const k of m.models || ['det', 'migan']) await getSession(k);
    return [null, {}];
  },
  async hasModel(m) {
    return [null, { cached: !!(await cachedModel(m.model)) }];
  },
  async removeText(m) {
    const img = toImg(m.image);
    const mask = await detectMask(img, {});
    if (BT.maskArea(mask) === 0) return [null, { found: false }];
    const res = await inpaint(img, mask, m.quality);
    const fin = await cleanupPass(res, mask, m.quality);
    return [fin.image, { found: true, mask: fin.mask }];
  },
  async improve(m) {
    const base = toImg(m.base), cur = toImg(m.current);
    const prev = new Uint8Array(m.mask.buffer);
    const W = base.width, H = base.height;
    let mask = prev;
    if (m.detect) {
      const near = BT.dilate(prev, W, H, Math.round(0.02 * Math.max(W, H)));
      mask = BT.maskUnion(prev, BT.maskIntersect(await detectMask(cur, { thresh: 0.22, boxThresh: 0.35 }), near));
    }
    mask = BT.dilate(mask, W, H, Math.max(2, Math.round(0.006 * Math.max(W, H))));
    const res = await inpaint(base, mask, m.quality, { shift: 0.5 });
    const fin = m.detect ? await cleanupPass(res, mask, m.quality) : { image: res, mask };
    return [fin.image, { mask: fin.mask }];
  },
  async inpaintMask(m) {
    const img = toImg(m.image);
    const mask = new Uint8Array(m.mask.buffer);
    const res = await inpaint(img, mask, m.quality, {});
    return [res, { mask }];
  },
  async filter(m) {
    status('Wird angewendet …', null);
    return [BT.applyFilter(toImg(m.image), m.action), {}];
  },
};

self.onmessage = async (e) => {
  const m = e.data;
  currentJob = m.id;
  try {
    const h = handlers[m.cmd];
    if (!h) throw new Error('Unbekannter Auftrag: ' + m.cmd);
    const [img, extra] = await h(m);
    reply(m.id, img, extra);
  } catch (err) {
    post({ type: 'error', id: m.id, message: (err && err.message) || String(err) });
  }
};
post({ type: 'ready', threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated });
