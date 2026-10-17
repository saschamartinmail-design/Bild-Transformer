/* Bildtransformer – Bildverarbeitung (läuft im Browser und zum Testen in Node).
   Bilder sind Objekte {data: Uint8ClampedArray (RGBA), width, height}.
   Masken sind Uint8Array der Länge width*height mit 1 = zu füllen. */
(function (root) {
  'use strict';
  const BT = {};

  // ---------------------------------------------------------------- Helfer
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  BT.makeImage = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  BT.cloneImage = (img) => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

  BT.resizeRGBA = function (src, nw, nh) {
    const { width: w, height: h, data: s } = src;
    const out = BT.makeImage(nw, nh);
    const d = out.data;
    const sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
      const y0 = Math.min(h - 1, fy | 0), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < nw; x++) {
        let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
        const x0 = Math.min(w - 1, fx | 0), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
        const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
        const o = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) {
          const top = s[i00 + c] + (s[i01 + c] - s[i00 + c]) * wx;
          const bot = s[i10 + c] + (s[i11 + c] - s[i10 + c]) * wx;
          d[o + c] = top + (bot - top) * wy;
        }
      }
    }
    return out;
  };

  // Ein-Kanal-Array (Float32/Uint8) bilinear skalieren -> Float32Array
  BT.resizeGray = function (src, w, h, nw, nh) {
    const out = new Float32Array(nw * nh);
    const sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
      const y0 = Math.min(h - 1, fy | 0), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < nw; x++) {
        let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
        const x0 = Math.min(w - 1, fx | 0), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
        const top = src[y0 * w + x0] + (src[y0 * w + x1] - src[y0 * w + x0]) * wx;
        const bot = src[y1 * w + x0] + (src[y1 * w + x1] - src[y1 * w + x0]) * wx;
        out[y * nw + x] = top + (bot - top) * wy;
      }
    }
    return out;
  };

  BT.cropImage = function (img, x0, y0, cw, ch) {
    const out = BT.makeImage(cw, ch);
    for (let y = 0; y < ch; y++) {
      const s = ((y0 + y) * img.width + x0) * 4;
      out.data.set(img.data.subarray(s, s + cw * 4), y * cw * 4);
    }
    return out;
  };

  BT.maskArea = (m) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };
  BT.maskUnion = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] | b[i]; return o; };
  BT.maskIntersect = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] & b[i]; return o; };

  // ------------------------------------------------- Distanz-Transformation
  // Chamfer 3-4: liefert Distanz*3 zum nächsten gesetzten Pixel und dessen Label.
  function chamfer(seedLabel, w, h) {
    const INF = 1e9;
    const dist = new Float32Array(w * h);
    const lab = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (seedLabel[i] > 0) { dist[i] = 0; lab[i] = seedLabel[i]; } else { dist[i] = INF; lab[i] = 0; }
    }
    const relax = (i, j, c) => { const v = dist[j] + c; if (v < dist[i]) { dist[i] = v; lab[i] = lab[j]; } };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x > 0) relax(i, i - 1, 3);
        if (y > 0) {
          relax(i, i - w, 3);
          if (x > 0) relax(i, i - w - 1, 4);
          if (x < w - 1) relax(i, i - w + 1, 4);
        }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (x < w - 1) relax(i, i + 1, 3);
        if (y < h - 1) {
          relax(i, i + w, 3);
          if (x < w - 1) relax(i, i + w + 1, 4);
          if (x > 0) relax(i, i + w - 1, 4);
        }
      }
    }
    return { dist, lab };
  }

  // Maske um r Pixel erweitern (O(N), unabhängig von r)
  BT.dilate = function (mask, w, h, r) {
    if (r <= 0) return new Uint8Array(mask);
    const { dist } = chamfer(mask, w, h);
    const out = new Uint8Array(w * h);
    const lim = r * 3;
    for (let i = 0; i < w * h; i++) out[i] = dist[i] <= lim ? 1 : 0;
    return out;
  };

  // ---------------------------------------------------------- Texterkennung
  // Eingabe für PP-OCR-Detektion: RGB, ImageNet-Normierung, Seiten Vielfaches von 32
  BT.detInput = function (img, maxSide) {
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const nw = Math.max(32, Math.round((img.width * s) / 32) * 32);
    const nh = Math.max(32, Math.round((img.height * s) / 32) * 32);
    const r = BT.resizeRGBA(img, nw, nh);
    const n = nw * nh;
    const t = new Float32Array(3 * n);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) t[c * n + i] = (r.data[i * 4 + c] / 255 - mean[c]) / std[c];
    }
    return { data: t, width: nw, height: nh };
  };

  /* Aus der Wahrscheinlichkeitskarte eine Füllmaske in Originalgröße machen.
     Jede Textregion wird wie bei DB ("unclip") um area*ratio/perimeter erweitert,
     danach kommt ein kleiner Sicherheitsrand für Kantenglättung und Schatten dazu. */
  BT.textMaskFromProb = function (prob, pw, ph, W, H, opt) {
    opt = Object.assign({ thresh: 0.3, boxThresh: 0.45, unclip: 2.3, minArea: 4, pad: 0.006 }, opt || {});
    const n = pw * ph;
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = prob[i] > opt.thresh ? 1 : 0;
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    let nl = 0;
    const keeps = [0], grows = [0];
    for (let i = 0; i < n; i++) {
      if (!bin[i] || labels[i]) continue;
      nl++;
      let sp = 0, area = 0, perim = 0, psum = 0;
      stack[sp++] = i; labels[i] = nl;
      while (sp) {
        const j = stack[--sp];
        area++; psum += prob[j];
        const x = j % pw, y = (j / pw) | 0;
        let edge = false;
        const nb = [x > 0 ? j - 1 : -1, x < pw - 1 ? j + 1 : -1, y > 0 ? j - pw : -1, y < ph - 1 ? j + pw : -1];
        for (let k = 0; k < 4; k++) {
          const q = nb[k];
          if (q < 0 || !bin[q]) { edge = true; continue; }
          if (!labels[q]) { labels[q] = nl; stack[sp++] = q; }
        }
        if (edge) perim++;
      }
      const ok = area >= opt.minArea && psum / area >= opt.boxThresh;
      keeps.push(ok ? 1 : 0);
      grows.push(ok ? (area * opt.unclip) / Math.max(1, perim) + 1 : 0);
    }
    const seed = new Int32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) { const l = labels[i]; if (l && keeps[l]) { seed[i] = l; any = true; } }
    const out = new Uint8Array(W * H);
    if (!any) return out;
    const { dist, lab } = chamfer(seed, pw, ph);
    const small = new Float32Array(n);
    for (let i = 0; i < n; i++) small[i] = lab[i] && dist[i] <= grows[lab[i]] * 3 ? 1 : 0;
    const up = BT.resizeGray(small, pw, ph, W, H);
    for (let i = 0; i < W * H; i++) out[i] = up[i] >= 0.5 ? 1 : 0;
    const r = Math.max(2, Math.round(opt.pad * Math.max(W, H)));
    return BT.dilate(out, W, H, r);
  };

  // --------------------------------------------------------- Inpainting
  /* Füllt die Maske kachelweise, damit auch große Fotos in voller Auflösung
     rekonstruiert werden. runModel(cropImg, cropMask) -> Promise<RGBA-Bild gleicher Größe>.
     Bereits gefüllte Pixel dienen den folgenden Kacheln als Kontext. */
  BT.inpaintTiles = async function (img, mask, runModel, opt) {
    opt = Object.assign({ win: 1024, ctx: 160, shift: 0, onProgress: null }, opt || {});
    const W = img.width, H = img.height;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const out = BT.cloneImage(img);
    if (x1 < 0) return out;
    const todo = new Uint8Array(mask);
    const inner = Math.max(64, opt.win - 2 * opt.ctx);
    // optional versetztes Raster (für "Verbessern": andere Kachelgrenzen als im ersten Durchgang)
    if (opt.shift) { const s = Math.round(inner * opt.shift); x0 = Math.max(0, x0 - s); y0 = Math.max(0, y0 - s); }
    const cols = Math.ceil((x1 - x0 + 1) / inner), rows = Math.ceil((y1 - y0 + 1) / inner);
    const tiles = [];
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      const ix0 = x0 + tx * inner, iy0 = y0 + ty * inner;
      const ix1 = Math.min(x1, ix0 + inner - 1), iy1 = Math.min(y1, iy0 + inner - 1);
      let has = false;
      for (let y = iy0; y <= iy1 && !has; y++) for (let x = ix0; x <= ix1; x++) if (mask[y * W + x]) { has = true; break; }
      if (has) tiles.push([ix0, iy0, ix1, iy1]);
    }
    for (let t = 0; t < tiles.length; t++) {
      const [ix0, iy0, ix1, iy1] = tiles[t];
      const cx0 = Math.max(0, ix0 - opt.ctx), cy0 = Math.max(0, iy0 - opt.ctx);
      const cx1 = Math.min(W - 1, ix1 + opt.ctx), cy1 = Math.min(H - 1, iy1 + opt.ctx);
      const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
      const cImg = BT.cropImage(out, cx0, cy0, cw, ch);
      const cMask = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) cMask[y * cw + x] = todo[(cy0 + y) * W + cx0 + x];
      const res = await runModel(BT.prefill(cImg, cMask), cMask);
      for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) {
        const gi = y * W + x;
        if (!todo[gi]) continue;
        const li = ((y - cy0) * cw + (x - cx0)) * 4, go = gi * 4;
        out.data[go] = res.data[li]; out.data[go + 1] = res.data[li + 1]; out.data[go + 2] = res.data[li + 2];
        todo[gi] = 0;
      }
      if (opt.onProgress) opt.onProgress(t + 1, tiles.length);
    }
    return out;
  };

  /* Maskierte Pixel vorab mit weich gemittelten Umgebungsfarben füllen ("Push-Pull").
     Das Modell verkleinert intern und sieht dabei Randpixel des Lochs – ohne Vorfüllung
     würden Reste der Schriftfarbe in die Rekonstruktion durchsickern. */
  BT.prefill = function (img, mask) {
    const w0 = img.width, h0 = img.height;
    const levels = [];
    let w = w0, h = h0;
    let P = new Float32Array(w * h * 3), A = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) { A[i] = 1; P[i * 3] = img.data[i * 4]; P[i * 3 + 1] = img.data[i * 4 + 1]; P[i * 3 + 2] = img.data[i * 4 + 2]; }
    }
    levels.push({ w, h, P, A });
    while (w > 1 || h > 1) {
      const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
      const nP = new Float32Array(nw * nh * 3), nA = new Float32Array(nw * nh);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = y * w + x, d = (y >> 1) * nw + (x >> 1);
        nA[d] += A[s]; nP[d * 3] += P[s * 3]; nP[d * 3 + 1] += P[s * 3 + 1]; nP[d * 3 + 2] += P[s * 3 + 2];
      }
      for (let i = 0; i < nw * nh; i++) if (nA[i] > 1) { const k = 1 / nA[i]; nA[i] = 1; nP[i * 3] *= k; nP[i * 3 + 1] *= k; nP[i * 3 + 2] *= k; }
      w = nw; h = nh; P = nP; A = nA;
      levels.push({ w, h, P, A });
    }
    for (let l = levels.length - 2; l >= 0; l--) {
      const c = levels[l], u = levels[l + 1];
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        const i = y * c.w + x, a = c.A[i];
        if (a >= 1) continue;
        const j = (y >> 1) * u.w + (x >> 1), f = 1 - a;
        c.P[i * 3] += f * u.P[j * 3]; c.P[i * 3 + 1] += f * u.P[j * 3 + 1]; c.P[i * 3 + 2] += f * u.P[j * 3 + 2];
        c.A[i] = a + f * u.A[j];
      }
    }
    const out = BT.cloneImage(img), L = levels[0];
    for (let i = 0; i < w0 * h0; i++) {
      if (!mask[i] || L.A[i] <= 0) continue;
      const k = 1 / L.A[i];
      out.data[i * 4] = L.P[i * 3] * k; out.data[i * 4 + 1] = L.P[i * 3 + 1] * k; out.data[i * 4 + 2] = L.P[i * 3 + 2] * k;
    }
    return out;
  };

  // Eingabe/Ausgabe MI-GAN (uint8, Maske: 0 = Loch, 255 = bekannt, beliebige Größe)
  BT.miganFeeds = function (img, mask) {
    const n = img.width * img.height;
    const im = new Uint8Array(3 * n), mk = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      im[i] = img.data[i * 4]; im[n + i] = img.data[i * 4 + 1]; im[2 * n + i] = img.data[i * 4 + 2];
      mk[i] = mask[i] ? 0 : 255;
    }
    return { image: im, mask: mk };
  };
  BT.fromCHW = function (chw, w, h, scale) {
    const out = BT.makeImage(w, h), n = w * h, k = scale || 1;
    for (let i = 0; i < n; i++) {
      out.data[i * 4] = chw[i] * k; out.data[i * 4 + 1] = chw[n + i] * k; out.data[i * 4 + 2] = chw[2 * n + i] * k; out.data[i * 4 + 3] = 255;
    }
    return out;
  };
  // Eingabe LaMa (float 0..1, 512×512, Maske 1 = Loch); Ausgabe float 0..255
  BT.lamaFeeds = function (img, mask, size) {
    const r = BT.resizeRGBA(img, size, size);
    const m = BT.resizeGray(mask, img.width, img.height, size, size);
    const n = size * size, im = new Float32Array(3 * n), mk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      im[i] = r.data[i * 4] / 255; im[n + i] = r.data[i * 4 + 1] / 255; im[2 * n + i] = r.data[i * 4 + 2] / 255;
      mk[i] = m[i] > 0.01 ? 1 : 0;
    }
    return { image: im, mask: mk };
  };

  // ------------------------------------------------------------- Filter
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hh = 0;
    if (d > 1e-6) {
      if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4;
      hh *= 60; if (hh < 0) hh += 360;
    }
    return [hh, mx === 0 ? 0 : d / mx, mx];
  }
  BT.rgb2hsv = rgb2hsv;
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // Werte jeweils -100..100
  BT.adjust = function (img, p) {
    const o = BT.cloneImage(img), d = o.data;
    const br = (p.brightness || 0) * 1.1, ct = 1 + (p.contrast || 0) / 100;
    const sat = 1 + (p.saturation || 0) / 100, wm = (p.warmth || 0) * 0.35;
    const cast = p.cast || [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] + cast[0], g = d[i + 1] + cast[1], b = d[i + 2] + cast[2];
      r += wm; b -= wm; g += wm * 0.15;
      r = (r - 128) * ct + 128 + br; g = (g - 128) * ct + 128 + br; b = (b - 128) * ct + 128 + br;
      if (sat !== 1) { const l = luma(r, g, b); r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
      d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
    }
    return o;
  };

  function boxBlur3(img) {
    const { width: w, height: h, data: s } = img;
    const tmp = new Float32Array(w * h * 3), out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const a = s[(y * w + Math.max(0, x - 1)) * 4 + c], b = s[(y * w + x) * 4 + c], e = s[(y * w + Math.min(w - 1, x + 1)) * 4 + c];
      tmp[(y * w + x) * 3 + c] = (a + b + e) / 3;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const a = tmp[(Math.max(0, y - 1) * w + x) * 3 + c], b = tmp[(y * w + x) * 3 + c], e = tmp[(Math.min(h - 1, y + 1) * w + x) * 3 + c];
      out[(y * w + x) * 3 + c] = (a + b + e) / 3;
    }
    return out;
  }
  // amount > 0 schärfer, < 0 weicher
  BT.sharpen = function (img, amount) {
    const bl = boxBlur3(img), o = BT.cloneImage(img), d = o.data, n = img.width * img.height;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      const v = d[i * 4 + c];
      d[i * 4 + c] = clamp255(v + (v - bl[i * 3 + c]) * amount);
    }
    return o;
  };

  BT.grayscale = function (img, strong) {
    const o = BT.cloneImage(img), d = o.data;
    for (let i = 0; i < d.length; i += 4) {
      let l = luma(d[i], d[i + 1], d[i + 2]);
      if (strong) l = clamp255((l - 128) * 1.3 + 128);
      d[i] = d[i + 1] = d[i + 2] = l;
    }
    return o;
  };

  BT.retro = function (img, strength) {
    const k = strength == null ? 1 : strength;
    const o = BT.cloneImage(img), d = o.data, w = img.width, h = img.height;
    const cx = w / 2, cy = h / 2, rmax = Math.sqrt(cx * cx + cy * cy);
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      let sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      sr = r + (sr - r) * 0.65 * k; sg = g + (sg - g) * 0.65 * k; sb = b + (sb - b) * 0.65 * k;
      // ausgeblichene Schwärzen, gedämpfte Lichter
      sr = 28 * k + sr * (1 - 0.18 * k); sg = 22 * k + sg * (1 - 0.18 * k); sb = 18 * k + sb * (1 - 0.2 * k);
      const dd = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / rmax;
      const vig = 1 - 0.38 * k * Math.pow(dd, 2.2);
      const grain = (rnd() - 0.5) * 18 * k;
      d[i] = clamp255(sr * vig + grain); d[i + 1] = clamp255(sg * vig + grain); d[i + 2] = clamp255(sb * vig + grain);
    }
    return o;
  };

  // Automatische Tonwertkorrektur + leichter Weißabgleich + etwas mehr Farbe
  BT.autoEnhance = function (img) {
    const d = img.data, n = img.width * img.height;
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    const step = Math.max(1, Math.floor(n / 400000));
    let cnt = 0, mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < n; i += step) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      hist[0][r]++; hist[1][g]++; hist[2][b]++; cnt++; mr += r; mg += g; mb += b;
    }
    const pct = (hst, p) => { let a = 0; const lim = cnt * p; for (let v = 0; v < 256; v++) { a += hst[v]; if (a >= lim) return v; } return 255; };
    const lo = [0, 1, 2].map((c) => pct(hist[c], 0.005)), hi = [0, 1, 2].map((c) => pct(hist[c], 0.995));
    const L = Math.min(...lo), Hh = Math.max(...hi);
    const gray = (mr + mg + mb) / (3 * cnt);
    const wb = [mr / cnt, mg / cnt, mb / cnt].map((m) => (m > 1 ? (gray / m - 1) * 0.5 + 1 : 1));
    const o = BT.cloneImage(img), od = o.data;
    const span = Math.max(1, Hh - L);
    for (let i = 0; i < od.length; i += 4) {
      let r = ((od[i] * wb[0] - L) / span) * 255, g = ((od[i + 1] * wb[1] - L) / span) * 255, b = ((od[i + 2] * wb[2] - L) / span) * 255;
      r = od[i] + (r - od[i]) * 0.7; g = od[i + 1] + (g - od[i + 1]) * 0.7; b = od[i + 2] + (b - od[i + 2]) * 0.7;
      const l = luma(r, g, b);
      r = l + (r - l) * 1.12; g = l + (g - l) * 1.12; b = l + (b - l) * 1.12;
      od[i] = clamp255(r); od[i + 1] = clamp255(g); od[i + 2] = clamp255(b);
    }
    return o;
  };

  const hueDist = (a, b) => { const x = Math.abs(a - b) % 360; return x > 180 ? 360 - x : x; };
  // mode 'remove': diese Farbe entsättigen; 'keep': alles andere entsättigen (Color Pop)
  BT.hueFilter = function (img, hue, mode, range) {
    range = range || 28;
    const o = BT.cloneImage(img), d = o.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const [hh, s] = rgb2hsv(r, g, b);
      let w = s < 0.12 ? 0 : Math.max(0, Math.min(1, (range * 1.4 - hueDist(hh, hue)) / (range * 0.6))) * Math.min(1, (s - 0.12) / 0.15);
      if (mode === 'keep') w = 1 - w;
      if (w <= 0) continue;
      const l = luma(r, g, b);
      d[i] = r + (l - r) * w; d[i + 1] = g + (l - g) * w; d[i + 2] = b + (l - b) * w;
    }
    return o;
  };

  // ------------------------------------------------------- Kommandos
  const COLORS = [
    [/\brot(e|en|er|es|t[oö]ne?|stich)?\b/, 0, 'Rot'], [/\borange\w*/, 30, 'Orange'], [/\bgelb\w*/, 55, 'Gelb'],
    [/\bgr[uü]n\w*/, 120, 'Grün'], [/\b(t[uü]rkis|cyan)\w*/, 180, 'Türkis'], [/\bblau\w*/, 220, 'Blau'],
    [/\b(lila|violett)\w*/, 275, 'Lila'], [/\b(pink|magenta|rosa)\w*/, 320, 'Pink'],
  ];
  function amountOf(c) {
    const m = c.match(/(\d{1,3})\s*(%|prozent)?/);
    if (m) return Math.min(100, parseInt(m[1], 10));
    if (/\b(etwas|leicht|bisschen|minimal|klein)\w*|\bwenig\b|\bein wenig\b/.test(c)) return 8;
    if (/\b(deutlich|viel|stark|sehr|richtig|kr[aä]ftig|extrem|massiv)\w*/.test(c)) return 30;
    return 16;
  }
  /* Übersetzt freie deutsche Kommandos in Bearbeitungsschritte.
     Rückgabe: {actions:[...], unknown:[Satzteile]} */
  BT.parseCommand = function (text) {
    const actions = [], unknown = [];
    const clauses = text.toLowerCase().replace(/schwarz[\s-]*wei(ß|ss)/g, 'schwarzweiss')
      .split(/\s*(?:,|;|\.|!|\bund\b|\bdann\b|\bauch\b|\bau(ß|ss)erdem\b|\bzus[aä]tzlich\b)\s*/).filter((s) => s && s.trim().length > 1);
    for (const raw of clauses) {
      const c = raw.trim();
      const n = actions.length;
      const amt = amountOf(c);
      const neg = /\bweniger\b|\bnicht so\b|\breduzier|\bverringer|\bsenk/.test(c);
      if (/zur[uü]cksetzen|\boriginal\b|von vorn|neu anfangen|alles weg/.test(c)) actions.push({ type: 'reset' });
      else if (/r[uü]ckg[aä]ngig|undo|zur[uü]ck\b|letzten schritt/.test(c)) actions.push({ type: 'undo' });
      else if (/(schrift|text|beschriftung|datum|zeitstempel|buchstaben|gekritzel|kritzel)/.test(c)) actions.push({ type: 'removeText' });
      else if (/schwarzweiss|graustufen|\bs\/w\b|monochrom|farblos/.test(c)) actions.push({ type: 'grayscale', strong: /kontrast|dramatisch|hart/.test(c) });
      else if (/retro|vintage|\balt\w*|old|nostalg|sepia|analog|film/.test(c)) actions.push({ type: 'retro', strength: amt <= 8 ? 0.6 : amt >= 30 ? 1.3 : 1 });
      else {
        let hit = false;
        const col = COLORS.find(([re]) => re.test(c));
        if (col && /stich/.test(c)) {
          const h = col[1] * Math.PI / 180, k = 10 + amt * 0.6;
          actions.push({ type: 'adjust', p: { cast: [-Math.cos(h) * k, -Math.cos(h - 2.094) * k, -Math.cos(h + 2.094) * k] }, label: col[2] + 'stich entfernt' });
          hit = true;
        } else if (col && /\bnur\b|behalt|betone|hervorheb|color ?pop/.test(c)) {
          actions.push({ type: 'hue', hue: col[1], mode: 'keep', name: col[2] }); hit = true;
        } else if (col && /entfern|raus|weg|l[oö]sch|tilg|entf[aä]rb|neutral|grau/.test(c)) {
          actions.push({ type: 'hue', hue: col[1], mode: 'remove', name: col[2] }); hit = true;
        }
        if (!hit) {
          if (/hell|aufhell|licht|lichter/.test(c) && !/dunkl/.test(c)) actions.push({ type: 'adjust', p: { brightness: neg ? -amt : amt } });
          if (/dunkl|abdunkl/.test(c)) actions.push({ type: 'adjust', p: { brightness: neg ? amt : -amt } });
          if (/kontrast/.test(c)) actions.push({ type: 'adjust', p: { contrast: neg || /weniger|flach|weich/.test(c) ? -amt : amt } });
          if (/w[aä]rm/.test(c)) actions.push({ type: 'adjust', p: { warmth: neg ? -amt : amt } });
          if (/k[aä]lt|k[uü]hl/.test(c)) actions.push({ type: 'adjust', p: { warmth: neg ? amt : -amt } });
          if (/s[aä]ttig|bunt|farbig|farbkr[aä]ft|lebendig|knallig|leuchtend|satter|kr[aä]ftiger/.test(c)) actions.push({ type: 'adjust', p: { saturation: neg ? -amt * 1.5 : amt * 1.5 } });
          if (/blass|entsättig|matt|gedeckt/.test(c)) actions.push({ type: 'adjust', p: { saturation: -amt * 1.5 } });
          if (/sch[aä]rf|scharf|details|knackig/.test(c) && !/unsch/.test(c)) actions.push({ type: 'sharpen', amount: neg ? -amt / 40 : amt / 20 });
          if (/unsch[aä]rf|weich|glatt/.test(c) && !/kontrast/.test(c)) actions.push({ type: 'sharpen', amount: -Math.min(0.9, amt / 30) });
          if (/dramatisch|ausdrucksstark|mehr pep|eindrucksvoll/.test(c)) actions.push({ type: 'adjust', p: { contrast: amt, saturation: amt }, label: 'dramatischer (Kontrast und Farbe verstärkt)' });
          if (/\bauto|optimier|verbesser|sch[oö]ner|besser/.test(c) && actions.length === n) actions.push({ type: 'auto' });
        }
      }
      if (actions.length === n) unknown.push(c);
    }
    return { actions, unknown };
  };

  BT.describeAction = function (a) {
    const sign = (v) => (v > 0 ? '+' : '') + Math.round(v);
    switch (a.type) {
      case 'undo': return 'letzten Schritt rückgängig gemacht';
      case 'reset': return 'auf das Original zurückgesetzt';
      case 'removeText': return 'Schrift entfernt';
      case 'grayscale': return a.strong ? 'kontrastreiches Schwarzweiß' : 'Schwarzweiß';
      case 'retro': return 'Retro-Look';
      case 'auto': return 'automatisch verbessert';
      case 'hue': return a.mode === 'keep' ? 'nur ' + a.name + ' behalten' : a.name + 'töne entfernt';
      case 'sharpen': return a.amount > 0 ? 'geschärft' : 'weicher gemacht';
      case 'adjust': {
        if (a.label) return a.label;
        const p = a.p, parts = [];
        if (p.brightness) parts.push('Helligkeit ' + sign(p.brightness));
        if (p.contrast) parts.push('Kontrast ' + sign(p.contrast));
        if (p.warmth) parts.push('Wärme ' + sign(p.warmth));
        if (p.saturation) parts.push('Sättigung ' + sign(p.saturation));
        return parts.join(', ');
      }
    }
    return '';
  };

  // Filter-Aktion auf ein Bild anwenden (alles außer undo/reset/removeText)
  BT.applyFilter = function (img, a) {
    switch (a.type) {
      case 'adjust': return BT.adjust(img, a.p);
      case 'sharpen': return BT.sharpen(img, a.amount);
      case 'grayscale': return BT.grayscale(img, a.strong);
      case 'retro': return BT.retro(img, a.strength);
      case 'auto': return BT.autoEnhance(img);
      case 'hue': return BT.hueFilter(img, a.hue, a.mode);
    }
    return img;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BT;
  root.BT = BT;
})(typeof self !== 'undefined' ? self : globalThis);
