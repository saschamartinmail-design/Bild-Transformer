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

/* Modell-Speicher
   Große Modelle werden in Teilen zu 4 MB geladen und jeder fertige Teil sofort gespeichert.
   Bricht die Verbindung ab, geht es beim nächsten Versuch an der Abbruchstelle weiter
   (HTTP-Range) – bereits geladene Teile werden nie ein zweites Mal übertragen. */
const PART = 4 * 1024 * 1024;
const downloads = {};          // key -> { promise, ctrl }
// Eigene Schlüssel per Query-Parameter (der Cache-Speicher ignoriert #-Anhänge beim Vergleichen)
const metaKey = (url) => url + '?bt=meta';
const partKey = (url, i) => url + '?bt=part-' + i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readMeta(cache, url) {
  const r = await cache.match(metaKey(url));
  if (!r) return null;
  try { return await r.json(); } catch (e) { return null; }
}
const writeMeta = (cache, url, meta) => cache.put(metaKey(url), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));

async function clearParts(cache, url) {
  for (const req of await cache.keys()) {
    if (req.url.startsWith(url + '?bt=')) await cache.delete(req);
  }
}

// Stand eines Modells: fertig gespeichert, teilweise geladen oder gar nicht
async function modelState(key) {
  const cache = await caches.open(MODEL_CACHE);
  let best = { done: false, got: 0, total: MODELS[key].mb * 1e6 };
  for (const url of MODELS[key].urls) {
    if (await cache.match(url)) return { done: true, got: best.total, total: best.total, url };
    const meta = await readMeta(cache, url);
    if (meta) {
      const got = meta.bytes || 0;
      if (meta.done) return { done: true, got, total: meta.total || got, url, parts: true };
      if (got > best.got) best = { done: false, got, total: meta.total || best.total, url };
    }
  }
  return best;
}

async function loadCached(key) {
  const st = await modelState(key);
  if (!st.done) return null;
  const cache = await caches.open(MODEL_CACHE);
  if (!st.parts) return new Uint8Array(await (await cache.match(st.url)).arrayBuffer());
  const meta = await readMeta(cache, st.url);
  const buf = new Uint8Array(meta.bytes);
  let o = 0;
  for (let i = 0; i < meta.parts; i++) {
    const r = await cache.match(partKey(st.url, i));
    if (!r) { await clearParts(cache, st.url); return null; }   // beschädigt -> neu laden
    const b = new Uint8Array(await r.arrayBuffer());
    buf.set(b, o); o += b.length;
  }
  if (o !== meta.bytes) { await clearParts(cache, st.url); return null; }
  return buf;
}

// Lädt eine URL fortsetzbar in Teilen. onProgress(got, total)
async function downloadResumable(url, onProgress, signal) {
  const cache = await caches.open(MODEL_CACHE);
  const fresh = () => ({ total: 0, parts: 0, bytes: 0, done: false });
  let meta = (await readMeta(cache, url)) || fresh();
  if (meta.done) return;
  let fails = 0, restarts = 0;
  const restart = async () => {                        // angefangene Teile verwerfen, von vorn laden
    await clearParts(cache, url);
    meta = fresh();
    if (++restarts > 3) throw new Error('Server unterstützt kein Fortsetzen');
  };
  for (;;) {
    // Komprimiert gelieferte Dateien lassen sich nicht per Range fortsetzen; ebenso ein Stand,
    // der größer ist als die angekündigte Größe (Überbleibsel älterer Versionen) -> neu beginnen
    if (meta.bytes && (meta.enc || (meta.total && meta.bytes > meta.total))) await restart();
    const start = meta.bytes;
    let progressed = false;
    try {
      const res = await fetch(url, { mode: 'cors', signal, headers: start ? { Range: `bytes=${start}-` } : {} });
      const enc = (res.headers.get('content-encoding') || '').toLowerCase();
      const encoded = !!enc && enc !== 'identity';
      if (start && (res.status === 200 || res.status === 416 || encoded)) {   // Fortsetzen nicht möglich -> sauber neu beginnen
        try { res.body.cancel(); } catch (e) { /* egal */ }
        await restart();
        continue;
      }
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
      // Bei komprimierter Lieferung ist content-length die gepackte Größe, nicht die der Datei
      const len = encoded ? 0 : Number(res.headers.get('content-length')) || 0;
      if (encoded) meta.enc = true;
      if (!meta.total && len) meta.total = start + len;
      const reader = res.body.getReader();
      let cur = new Uint8Array(PART), fill = 0, last = 0;
      const flush = async (final) => {
        if (!fill && !final) return;
        if (fill) {
          await cache.put(partKey(url, meta.parts), new Response(cur.slice(0, fill), { headers: { 'content-type': 'application/octet-stream' } }));
          meta.parts++; meta.bytes += fill; fill = 0;
        }
        if (final) meta.done = true;
        await writeMeta(cache, url, meta);
      };
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (err) {
          // Verbindung weg: bis hierhin empfangene Daten trotzdem sichern -> kein Byte doppelt laden
          if (fill) { await flush(false); progressed = true; }
          throw err;
        }
        const { done, value } = chunk;
        if (done) break;
        let off = 0;
        while (off < value.length) {
          const n = Math.min(PART - fill, value.length - off);
          cur.set(value.subarray(off, off + n), fill);
          fill += n; off += n;
          if (fill === PART) { await flush(false); progressed = true; }
        }
        // Mehr Daten als angekündigt: Der Browser entpackt eine komprimierte Lieferung
        // (bei fremden Servern ist das an den Kopfzeilen nicht erkennbar) -> Größe unbekannt
        if (meta.total && meta.bytes + fill > meta.total) { meta.total = 0; meta.enc = true; }
        const now = Date.now();
        if (now - last > 300) { last = now; onProgress(meta.bytes + fill, meta.total); }
      }
      if (meta.total && meta.bytes + fill < meta.total) {
        await flush(false);
        throw new Error('Verbindung abgebrochen');
      }
      await flush(true);
      onProgress(meta.bytes, meta.total || meta.bytes);
      return;
    } catch (e) {
      if (signal && signal.aborted) throw new Error('abgebrochen');
      if (e && e.name === 'QuotaExceededError') throw new Error('zu wenig freier Speicher auf dem Gerät');
      if (progressed) fails = 0;
      if (++fails > 6) throw e;                           // Teile bleiben gespeichert -> später weiter
      onProgress(meta.bytes, meta.total, true);
      await sleep(Math.min(30000, 2000 * 2 ** (fails - 1)));
    }
  }
}

// Modell sicherstellen (einmaliger, fortsetzbarer Download)
async function ensureModel(key, report) {
  if (downloads[key]) return downloads[key].promise;
  const m = MODELS[key];
  const ctrl = new AbortController();
  const promise = (async () => {
    let lastErr = null;
    const st = await modelState(key);
    if (st.done) return;
    const order = st.url ? [st.url, ...m.urls.filter((u) => u !== st.url)] : m.urls;   // angefangenen Download zuerst fortsetzen
    for (const url of order) {
      try {
        await downloadResumable(url, (got, total, retry) => report(got, Math.max(got, total || m.mb * 1e6), retry), ctrl.signal);
        return;
      } catch (e) {
        lastErr = e;
        if (ctrl.signal.aborted) throw e;
      }
    }
    throw new Error(`${m.name} konnte nicht vollständig geladen werden (${lastErr ? lastErr.message : 'unbekannt'}). Bereits geladene Teile bleiben gespeichert, beim nächsten Versuch geht es dort weiter.`);
  })();
  downloads[key] = { promise, ctrl };
  try { await promise; } finally { delete downloads[key]; }
}

async function clearModel(key) {
  const cache = await caches.open(MODEL_CACHE);
  for (const url of MODELS[key].urls) { await cache.delete(url); await clearParts(cache, url); }
}

async function getSession(key, retried) {
  if (!sessions[key]) {
    let buf = await loadCached(key);
    if (!buf) {
      const m = MODELS[key];
      await ensureModel(key, (got, total, retry) => status(retry
        ? `Verbindung unterbrochen – ${m.name} wird gleich fortgesetzt (${Math.round(got / 1e6)} von ${Math.round(total / 1e6)} MB)`
        : `Einmaliger Download: ${m.name} (${Math.round(got / 1e6)} von ${Math.round(total / 1e6)} MB)`, Math.min(1, got / total)));
      buf = await loadCached(key);
      if (!buf) throw new Error(`${MODELS[key].name} konnte nicht gelesen werden.`);
    }
    status(`${MODELS[key].name} wird vorbereitet …`, null);
    try {
      sessions[key] = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    } catch (e) {
      // Datei unlesbar (z. B. durch einen fehlerhaften früheren Download): einmal neu laden.
      // Speichermangel wird hier bewusst nicht behandelt – dafür gibt es den Rückfall auf Standard.
      const msg = String((e && e.message) || e);
      if (retried || !/protobuf|pars|failed to load|invalid|corrupt/i.test(msg)) throw e;
      buf = null;
      await clearModel(key);
      return getSession(key, true);
    }
  }
  return sessions[key];
}

// ---------------------------------------------------------------- Zwischenstände
/* Während eines fortsetzbaren Auftrags wird jedes Ergebnis eines Modellaufrufs (Schriftsuche,
   jede Kachel der Rekonstruktion) sofort auf dem Gerät gespeichert – adressiert über eine
   Prüfsumme der Eingabe. Wird der Auftrag nach einem Abbruch wiederholt, kommen gleiche
   Schritte direkt aus dem Speicher. Die Oberfläche löscht alles, sobald der Auftrag fertig ist. */
let cacheOn = false;
async function cached(kind, parts, compute) {
  if (!cacheOn) return compute();
  const db = await BT.resumeDb();
  if (!db) return compute();
  const key = kind + ':' + BT.hashData(parts);
  try {
    const hit = await BT.idbTx(db, 'calls', 'readonly', (s) => s.calls.get(key));
    if (hit) return hit;
  } catch (e) { /* dann eben neu rechnen */ }
  const out = await compute();
  // put() kopiert die Daten sofort; auf das Schreiben selbst muss nicht gewartet werden
  if (cacheOn) BT.idbTx(db, 'calls', 'readwrite', (s) => s.calls.put(out, key)).catch(() => {});
  return out;
}

// ---------------------------------------------------------------- KI-Schritte
async function detectMask(img, opt) {
  const det = await getSession('det');
  status('Schrift wird gesucht …', null);
  const inp = BT.detInput(img, 1280);
  const prob = await cached(`det${inp.width}x${inp.height}`, [inp.data], async () => {
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', inp.data, [1, 3, inp.height, inp.width]) });
    return new Float32Array(out[det.outputNames[0]].data);
  });
  return BT.textMaskFromProb(prob, inp.width, inp.height, img.width, img.height, opt);
}

function modelRunner(key, sess) {
  if (key === 'lama') {
    return (crop, cmask) => cached(`lama${crop.width}x${crop.height}`, [crop.data, cmask], async () => {
      const f = BT.lamaFeeds(crop, cmask, 512);
      const out = await sess.run({
        [sess.inputNames[0]]: new ort.Tensor('float32', f.image, [1, 3, 512, 512]),
        [sess.inputNames[1]]: new ort.Tensor('float32', f.mask, [1, 1, 512, 512]),
      });
      const small = BT.fromCHW(out[sess.outputNames[0]].data, 512, 512, 1);
      return BT.resizeRGBA(small, crop.width, crop.height);
    });
  }
  return (crop, cmask) => cached(`migan${crop.width}x${crop.height}`, [crop.data, cmask], async () => {
    const f = BT.miganFeeds(crop, cmask);
    const out = await sess.run({
      [sess.inputNames[0]]: new ort.Tensor('uint8', f.image, [1, 3, crop.height, crop.width]),
      [sess.inputNames[1]]: new ort.Tensor('uint8', f.mask, [1, 1, crop.height, crop.width]),
    });
    return BT.fromCHW(out[sess.outputNames[0]].data, crop.width, crop.height);
  });
}

let lamaBroken = false;
async function inpaint(img, mask, quality, opt) {
  let key = quality === 'high' && !lamaBroken ? 'lama' : 'migan';
  let sess;
  if (key === 'lama') {
    try { sess = await getSession('lama'); } catch (e) {
      lamaBroken = true;                                   // z. B. zu wenig Arbeitsspeicher -> Standard
      post({ type: 'notice', text: 'Höchste Qualität ließ sich auf diesem Gerät nicht starten – es wird Standard verwendet.' });
      key = 'migan';
    }
  }
  if (!sess) sess = await getSession(key);
  const o = Object.assign({ win: key === 'lama' ? 768 : 1024 }, opt || {});
  o.onProgress = (i, n) => status(n > 1 ? `Bild wird rekonstruiert (${i} von ${n})` : 'Bild wird rekonstruiert …', n > 1 ? i / n : null);
  status('Bild wird rekonstruiert …', null);
  // Gemalte Flächen (Objekt weg): als Ganzes füllen, damit große Objekte stimmig ersetzt werden
  if (o.large) return BT.inpaintLarge(img, mask, modelRunner(key, sess), { onProgress: o.onProgress });
  return BT.inpaintTiles(img, mask, modelRunner(key, sess), o);
}

// Suche auf dem Foto und zusätzlich auf einer kontrastverstärkten Variante (findet blasse Schrift)
async function detectBoth(img, opt) {
  const a = await detectMask(img, opt);
  status('Blasse Schrift wird gesucht …', null);
  return BT.maskUnion(a, await detectMask(BT.highpassVariant(img), opt));
}

// Schrift entfernen; halbtransparente Bereiche werden zurückgerechnet statt neu erfunden
async function smartRemove(img, mask, quality) {
  return BT.removeTextSmart(img, mask, (im, mk) => inpaint(im, mk, quality), { onStage: (t) => status(t, null) });
}

// Nach dem Entfernen: Schriftreste suchen, die überwiegend in der Textmaske liegen, und nachfüllen
async function cleanupPass(res, mask, quality) {
  const W = res.width, H = res.height;
  const zone = BT.dilate(mask, W, H, Math.max(2, Math.round(0.004 * Math.max(W, H))));
  const resid = BT.filterResidual(await detectMask(res, { thresh: 0.25, boxThresh: 0.4 }), zone, W, H, 0.6);
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
  async modelStatus(m) {
    const st = await modelState(m.model);
    return [null, { done: st.done, got: st.got, total: st.total, active: !!downloads[m.model] }];
  },
  // Hintergrund-Download (läuft parallel zu Bearbeitungen weiter)
  async download(m) {
    const key = m.model, mb = (v) => Math.round(v / 1e6);
    ensureModel(key, (got, total, retry) => post({ type: 'dl', model: key, got, total, retry: !!retry, text: (retry ? 'Unterbrochen, wird fortgesetzt … ' : '') + `${mb(got)} von ${mb(total)} MB` }))
      .then(async () => { const st = await modelState(key); post({ type: 'dl', model: key, done: true, got: st.got, total: st.total }); })
      .catch(async (e) => { const st = await modelState(key); post({ type: 'dl', model: key, error: e.message, got: st.got, total: st.total, cancelled: e.message === 'abgebrochen' }); });
    return [null, {}];
  },
  async cancelDownload(m) {
    if (downloads[m.model]) downloads[m.model].ctrl.abort();
    return [null, {}];
  },
  async removeText(m) {
    const img = toImg(m.image);
    const mask = await detectBoth(img, {});
    if (BT.maskArea(mask) === 0) return [null, { found: false }];
    const sm = await smartRemove(img, mask, m.quality);
    const fin = await cleanupPass(sm.image, sm.mask, m.quality);
    return [fin.image, { found: true, mask: fin.mask, reversed: sm.reversed }];
  },
  async improve(m) {
    const base = toImg(m.base), cur = toImg(m.current);
    const prev = new Uint8Array(m.mask.buffer);
    const W = base.width, H = base.height;
    let mask = prev;
    if (m.detect) {
      const near = BT.dilate(prev, W, H, Math.round(0.02 * Math.max(W, H)));
      mask = BT.maskUnion(prev, BT.filterResidual(await detectBoth(cur, { thresh: 0.22, boxThresh: 0.35 }), near, W, H, 0.6));
    }
    mask = BT.dilate(mask, W, H, Math.max(2, Math.round(0.006 * Math.max(W, H))));
    if (m.detect) {
      const sm = await smartRemove(base, mask, m.quality);
      const fin = await cleanupPass(sm.image, BT.maskUnion(sm.mask, BT.maskIntersect(mask, prev)), m.quality);
      return [fin.image, { mask: fin.mask, reversed: sm.reversed }];
    }
    const res = await inpaint(base, mask, m.quality, { shift: 0.5 });
    return [res, { mask }];
  },
  async inpaintMask(m) {
    const img = toImg(m.image);
    let mask = new Uint8Array(m.mask.buffer);
    // Pinselstriche: eingekreiste Flächen mitfüllen, schmalen Rand ergänzen
    if (m.brush) { status('Markierung wird vorbereitet …', null); mask = BT.prepareBrushMask(mask, img.width, img.height); }
    if (m.smart) {
      const sm = await smartRemove(img, mask, m.quality);
      const fin = await cleanupPass(sm.image, sm.mask, m.quality);
      return [fin.image, { mask: fin.mask, reversed: sm.reversed }];
    }
    const res = await inpaint(img, mask, m.quality, { large: !!m.brush });
    return [res, { mask }];
  },
  async filter(m) {
    status('Wird angewendet …', null);
    return [BT.applyFilter(toImg(m.image), m.action), {}];
  },
};

self.onmessage = async (e) => {
  const m = e.data;
  const background = ['modelStatus', 'download', 'cancelDownload'].includes(m.cmd);
  if (!background) { currentJob = m.id; cacheOn = !!m.resume; }
  try {
    const h = handlers[m.cmd];
    if (!h) throw new Error('Unbekannter Auftrag: ' + m.cmd);
    let fellBack = false;
    if (m.quality === 'high' && !sessions.lama && !(await modelState('lama')).done) { m.quality = 'standard'; fellBack = true; }
    const [img, extra] = await h(m);
    if (fellBack) extra.fellBack = true;
    reply(m.id, img, extra);
  } catch (err) {
    post({ type: 'error', id: m.id, message: (err && err.message) || String(err) });
  } finally {
    if (!background && currentJob === m.id) cacheOn = false;
  }
};
post({ type: 'ready', threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated });
