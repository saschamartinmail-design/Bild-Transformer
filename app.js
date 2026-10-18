/* Bildtransformer – Oberfläche. Rechenintensive Schritte laufen in worker.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const BT = window.BT;
  const MAX_SIDE = 4096;     // größere Fotos werden auf diese Kantenlänge verkleinert
  const HISTORY_MAX = 12;

  const el = {
    addBtn: $('addBtn'), resetBtn: $('resetBtn'), resetDlg: $('resetDlg'), resetYes: $('resetYes'), resetNo: $('resetNo'), empty: $('empty'), file: $('file'), meta: $('meta'),
    viewer: $('viewer'), cvOrig: $('cvOrig'), cvResult: $('cvResult'), cvMask: $('cvMask'),
    divider: $('divider'), tagL: $('tagL'), tagR: $('tagR'), undoBtn: $('undoBtn'),
    savePills: $('savePills'), saveBtn: $('saveBtn'), shareBtn: $('shareBtn'),
    busy: $('busy'), busyText: $('busyText'), busyBar: $('busyBar'), hint: $('hint'),
    tools: $('tools'), actions: $('actions'), improveBtn: $('improveBtn'), retouchBtn: $('retouchBtn'),
    brushBar: $('brushBar'), brushSize: $('brushSize'), brushCancel: $('brushCancel'), brushApply: $('brushApply'),
    chat: $('chat'), cmdForm: $('cmdForm'), cmd: $('cmd'),
    moreDlg: $('moreDlg'), moreClose: $('moreClose'), qualityToggle: $('qualityToggle'), engineInfo: $('engineInfo'),
    qualityDlg: $('qualityDlg'), qStd: $('qStd'), qHigh: $('qHigh'),
    hqInfo: $('hqInfo'), hqBar: $('hqBar'), hqBarWrap: $('hqBarWrap'), hqLoad: $('hqLoad'), storageInfo: $('storageInfo'),
    dataDlg: $('dataDlg'), dataText: $('dataText'), dataWifi: $('dataWifi'), dataNow: $('dataNow'),
    resumeDlg: $('resumeDlg'), resumeText: $('resumeText'), resumeYes: $('resumeYes'), resumeNo: $('resumeNo'),
    notifyToggle: $('notifyToggle'), notifyInfo: $('notifyInfo'),
  };
  const ctxO = el.cvOrig.getContext('2d', { willReadFrequently: true });
  const ctxR = el.cvResult.getContext('2d', { willReadFrequently: true });
  const ctxM = el.cvMask.getContext('2d', { willReadFrequently: true });

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privat-Modus */ } },
  };

  const state = {
    loaded: false, w: 0, h: 0, name: '', type: 'image/jpeg',
    pos: 0.5, history: [], text: null, busy: false,
    mode: 'compare', brushKind: null, pickMode: 'remove',
    quality: store.get('bt-quality'),
    hq: { done: false, got: 0, total: 208e6, active: false, error: null, waitWifi: false, text: '' },
    fbNoted: false, leftDuringRun: false,
  };

  // ------------------------------------------------------------ Worker
  const worker = new Worker('worker.js', { type: 'module' });
  let jobId = 0;
  const pending = new Map();
  let workerOk = true;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { if (pending.has(m.job)) setBusy(m.text, m.frac); return; }
    if (m.type === 'dl') { onDownload(m); return; }
    if (m.type === 'notice') { addMsg('ai', m.text); return; }
    if (m.fellBack) noteFallback();
    if (m.type === 'ready') {
      el.engineInfo.textContent = `Rechenkern bereit · ${m.threads} Thread${m.threads > 1 ? 's' : ''}${m.isolated ? '' : ' (Einzelthread-Modus)'}`;
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
  };
  worker.onerror = (e) => {
    workerOk = false;
    e.preventDefault();
    for (const p of pending.values()) p.reject(new Error('Das KI-Modul konnte nicht starten. Beim allerersten Start wird eine Internetverbindung gebraucht.'));
    pending.clear();
  };
  function call(cmd, payload, transfer) {
    if (!workerOk) return Promise.reject(new Error('Das KI-Modul ist nicht verfügbar. Bitte die App mit Internetverbindung neu laden.'));
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id, cmd, resume: resume.active }, payload), transfer || []);
    });
  }

  // ------------------------------------------------------------ Hilfen
  const getCur = () => ctxR.getImageData(0, 0, state.w, state.h);
  const copyImageData = (d) => new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);
  const pack = (d) => ({ buffer: d.data.buffer, width: d.width, height: d.height });
  const canvasToBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));
  function applyResult(m) {
    if (!m.image) return;
    ctxR.putImageData(new ImageData(new Uint8ClampedArray(m.image.buffer), m.image.width, m.image.height), 0, 0);
  }
  function quality() { return state.quality === 'high' ? 'high' : 'standard'; }

  function addMsg(who, text, isErr) {
    const d = document.createElement('div');
    d.className = 'msg ' + who + (isErr ? ' err' : '');
    d.textContent = text;
    el.chat.appendChild(d);
    while (el.chat.children.length > 30) el.chat.removeChild(el.chat.firstChild);
    el.chat.scrollTop = el.chat.scrollHeight;
  }
  function setHint(text) { el.hint.textContent = text || ''; }
  function defaultHint() {
    setHint(state.loaded ? 'Regler ziehen · aufs Bild tippen zum Speichern' : 'Tippe auf das Plus, um ein Foto auszuwählen.');
  }
  function setBusy(text, frac) {
    el.busy.hidden = false;
    el.busyText.textContent = text || 'Einen Moment …';
    el.busyBar.parentElement.hidden = frac == null;
    if (frac != null) el.busyBar.style.width = Math.round(frac * 100) + '%';
  }
  function disableUI(b) {
    el.tools.querySelectorAll('button').forEach((x) => { x.disabled = b || !state.loaded; });
    [el.improveBtn, el.retouchBtn].forEach((x) => { x.disabled = b || !state.loaded; });
    el.addBtn.disabled = b; el.resetBtn.disabled = b;
    el.cmdForm.querySelector('button').disabled = b;
    el.undoBtn.disabled = b || state.history.length === 0;
    el.brushApply.disabled = b; el.brushCancel.disabled = b;
  }
  // ------------------------------------------------------------ Bildschirm anlassen
  // Solange gerechnet wird, schaltet sich das Display nicht von selbst ab.
  // Die Ausschalttaste wirkt weiterhin normal; danach gibt der Browser die Sperre frei.
  // Kommt man zurück und es wird noch gerechnet, wird sie neu angefordert.
  const screenLock = {
    sentinel: null,
    async on() {
      if (!('wakeLock' in navigator) || this.sentinel || document.visibilityState !== 'visible') return;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (!state.busy) { s.release().catch(() => {}); return; }   // Berechnung war schon fertig
        this.sentinel = s;
        s.addEventListener('release', () => { if (this.sentinel === s) this.sentinel = null; });
      } catch (e) { /* z. B. Energiesparmodus: dann eben ohne */ }
    },
    off() {
      const s = this.sentinel;
      this.sentinel = null;
      if (s) s.release().catch(() => {});
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (state.busy) state.leftDuringRun = true; return; }
    if (state.busy) screenLock.on();
    notify.clear();
    if (state.leftDuringRun && notify.supported && !notify.on() && Notification.permission !== 'denied' && !store.get('bt-notify-tip')) {
      store.set('bt-notify-tip', '1');
      addMsg('ai', 'Tipp: Unter „Mehr“ → „Hinweis, wenn fertig“ meldet sich die App, sobald ein Bild fertig ist. So musst du nicht nachsehen.');
    }
  });

  // ------------------------------------------------------------ Fortsetzen nach Abbruch
  /* Vor jeder Rekonstruktion wird der Auftrag auf dem Gerät gesichert (Foto, Markierung, Art),
     der Rechenkern speichert jedes fertige Bildteil. Beendet Android die App im Hintergrund,
     bleibt beides erhalten; beim nächsten Öffnen geht es dort weiter. Ist der Auftrag fertig
     (oder mit Fehler beendet), wird alles gelöscht. */
  const plain = (d) => ({ data: d.data, width: d.width, height: d.height });
  const resume = {
    active: false, resuming: false,
    // muss abgewartet werden, BEVOR die Bilddaten an den Rechenkern übergeben werden
    async begin(kind, cur, extra) {
      this.active = true;
      if (this.resuming) return;              // Auftrag liegt bereits gesichert vor
      const db = await BT.resumeDb();
      if (!db) return;
      try {
        const t = state.text;
        const rec = Object.assign({
          v: 1, at: Date.now(), kind, name: state.name, type: state.type, w: state.w, h: state.h,
          original: plain(ctxO.getImageData(0, 0, state.w, state.h)), current: plain(cur),
          text: t ? { base: plain(t.base), mask: t.mask, detect: t.detect } : null,
        }, extra || {});
        // put() kopiert sofort; das Schreiben läuft parallel zur Berechnung
        BT.idbTx(db, ['job', 'calls'], 'readwrite', (st) => { st.calls.clear(); st.job.put(rec, 'cur'); })
          .catch(() => { /* z. B. Speicher voll: dann eben ohne Fortsetzen */ });
      } catch (e) { /* ohne Fortsetzen weiter */ }
    },
    async end() {
      if (!this.active) return;
      this.active = false;
      const db = await BT.resumeDb();
      if (db) BT.idbTx(db, ['job', 'calls'], 'readwrite', (st) => { st.job.clear(); st.calls.clear(); }).catch(() => {});
    },
    async load() {
      const db = await BT.resumeDb();
      if (!db) return null;
      try { return await BT.idbTx(db, 'job', 'readonly', (st) => st.job.get('cur')); } catch (e) { return null; }
    },
    discard() { this.active = true; return this.end(); },
  };

  // ------------------------------------------------------------ Hinweis „Fertig“
  const notify = {
    supported: 'Notification' in window && 'serviceWorker' in navigator,
    on() { return this.supported && store.get('bt-notify') === 'on' && Notification.permission === 'granted'; },
    async show(ok) {
      if (document.visibilityState !== 'hidden' || !this.on()) return;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.showNotification('Bildtransformer', {
          body: ok ? 'Dein Bild ist fertig.' : 'Die Bearbeitung hat nicht geklappt. Tippe hier für Details.',
          tag: 'bt-done', renotify: true, icon: 'icons/icon-192.png',
        });
      } catch (e) { /* egal */ }
    },
    async clear() {
      if (!this.supported) return;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) (await reg.getNotifications({ tag: 'bt-done' })).forEach((n) => n.close());
      } catch (e) { /* egal */ }
    },
  };
  function updateNotifyLabel() {
    el.notifyToggle.textContent = 'Hinweis, wenn fertig: ' + (notify.on() ? 'An' : 'Aus');
  }
  function notifyInfo(text) { el.notifyInfo.textContent = text || ''; el.notifyInfo.hidden = !text; }
  async function toggleNotify() {
    notifyInfo('');
    if (!notify.supported) { notifyInfo('Dieser Browser kann keine Benachrichtigungen anzeigen.'); return; }
    if (notify.on()) { store.set('bt-notify', 'off'); updateNotifyLabel(); return; }
    let p = Notification.permission;
    if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) { p = Notification.permission; } }
    if (p === 'granted') {
      store.set('bt-notify', 'on');
      notifyInfo('Läuft die App im Hintergrund weiter, meldet sie sich, sobald das Bild fertig ist. Hat Android sie beendet, geht es beim nächsten Öffnen weiter.');
    } else {
      notifyInfo('Benachrichtigungen sind für die App blockiert. Freigeben: lange auf das App-Symbol tippen → App-Info → Benachrichtigungen (oder in Chrome unter Website-Einstellungen).');
    }
    updateNotifyLabel();
  }

  async function run(label, fn) {
    if (state.busy) return undefined;
    state.busy = true;
    state.leftDuringRun = document.visibilityState === 'hidden';
    hideSave();
    setBusy(label, null);
    disableUI(true);
    screenLock.on();
    let ok = false;
    try {
      const r = await fn();
      ok = true;
      return r === undefined ? true : r;
    } catch (e) {
      addMsg('ai', 'Das hat nicht geklappt: ' + e.message, true);
      return undefined;
    } finally {
      const long = resume.active;             // nur Rekonstruktionen melden, keine Sekundenfilter
      resume.end();
      state.busy = false;
      screenLock.off();
      el.busy.hidden = true;
      disableUI(false);
      if (long) notify.show(ok);
    }
  }

  // ------------------------------------------------------------ Verlauf
  function pushHistory() {
    state.history.push({ blob: canvasToBlob(el.cvResult, 'image/png'), text: state.text });
    if (state.history.length > HISTORY_MAX) state.history.shift();
    el.undoBtn.disabled = false;
  }
  async function undo() {
    const entry = state.history.pop();
    if (!entry) { addMsg('ai', 'Es gibt nichts mehr rückgängig zu machen.'); return false; }
    const blob = await entry.blob;
    const bmp = await createImageBitmap(blob);
    ctxR.clearRect(0, 0, state.w, state.h);
    ctxR.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    state.text = entry.text;
    el.undoBtn.disabled = state.history.length === 0;
    return true;
  }
  function resetToOriginal() {
    pushHistory();
    ctxR.drawImage(el.cvOrig, 0, 0);
    state.text = null;
    return true;
  }

  // ------------------------------------------------------------ Foto laden
  async function loadFile(file) {
    if (!file || state.busy) return;
    if (file.type && !file.type.startsWith('image/')) { addMsg('ai', 'Das ist leider keine Bilddatei.', true); return; }
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) {
      addMsg('ai', 'Dieses Bildformat kann der Browser nicht öffnen. Am besten als JPG oder PNG speichern und erneut versuchen.', true);
      return;
    }
    const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    for (const c of [el.cvOrig, el.cvResult]) { c.width = w; c.height = h; }
    ctxO.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    ctxR.drawImage(el.cvOrig, 0, 0);
    Object.assign(state, { loaded: true, w, h, name: file.name || 'Foto', type: file.type || 'image/jpeg', history: [], text: null });
    showPhoto(s < 1 ? ' (verkleinert)' : '');
    setHint('Foto geladen – tippe auf „Schrift weg“ oder ein anderes Werkzeug.');
  }
  function showPhoto(note) {
    el.meta.textContent = `${state.name} · ${state.w} × ${state.h}${note || ''}`;
    el.empty.hidden = true;
    el.viewer.hidden = false;
    el.resetBtn.hidden = false;
    exitModes();
    layout();
    setPos(0.5);
    disableUI(false);
  }

  // ------------------------------------------------------------ Reset (leere Fläche)
  function resetPhoto() {
    exitModes();
    hideSave();
    for (const c of [el.cvOrig, el.cvResult, el.cvMask]) { c.width = 1; c.height = 1; }
    Object.assign(state, { loaded: false, w: 0, h: 0, name: '', type: 'image/jpeg', history: [], text: null, pos: 0.5 });
    el.viewer.hidden = true;
    el.viewer.style.width = ''; el.viewer.style.height = '';
    el.empty.hidden = false;
    el.resetBtn.hidden = true;
    el.meta.textContent = 'Alles bleibt auf deinem Gerät';
    el.chat.textContent = '';
    el.tools.scrollLeft = 0;
    el.cmd.value = ''; autoGrow();
    disableUI(false);
    defaultHint();
  }
  function askReset() {
    if (state.busy || !state.loaded) return;
    if (!state.history.length) { resetPhoto(); return; }
    el.resetDlg.showModal();
  }

  // ------------------------------------------------------------ KI-Funktionen
  async function removeText(auto) {
    let found = false, reversed = 0;
    const ok = await run('Schrift wird gesucht …', async () => {
      const cur = getCur();
      const base = copyImageData(cur);
      pushHistory();
      await resume.begin('removeText', cur, { auto: !!auto });
      const m = await call('removeText', { image: pack(cur), quality: quality() }, [cur.data.buffer]);
      if (!m.found) {
        state.history.pop();
        el.undoBtn.disabled = state.history.length === 0;
        state.text = { base, mask: new Uint8Array(state.w * state.h), detect: true };
        return;
      }
      applyResult(m);
      state.text = { base, mask: new Uint8Array(m.mask.buffer), detect: true };
      found = true; reversed = m.reversed || 0;
    });
    if (!ok) return null;
    if (found) {
      const rev = reversed ? ' Halbtransparente Schrift wurde dabei zurückgerechnet, das Foto darunter bleibt erhalten.' : '';
      addMsg('ai', (auto ? 'Schrift erkannt und entfernt.' : 'Schrift entfernt.') + rev + ' Reste? „Nachmalen“ – grob drübermalen genügt.');
    }
    else addMsg('ai', 'Ich habe keine Schrift gefunden. Mit „Nachmalen“ kannst du Stellen selbst markieren.');
    return { found };
  }

  // ------------------------------------------------------------ Modell „Höchste Qualität“
  const mb = (v) => Math.round((v || 0) / 1e6);
  function isCellular() { const c = navigator.connection; return !!(c && (c.type === 'cellular' || c.saveData)); }
  async function refreshHQ() {
    try {
      const st = await call('modelStatus', { model: 'lama' });
      Object.assign(state.hq, { done: st.done, got: st.got, total: st.total || state.hq.total, active: st.active });
    } catch (e) { /* Worker nicht bereit */ }
    renderHQ();
  }
  function renderHQ() {
    const h = state.hq;
    let t;
    if (h.done) t = `Höchste Qualität: auf dem Gerät gespeichert (${mb(h.total)} MB) – wird nicht erneut geladen.`;
    else if (h.active) t = 'Höchste Qualität wird geladen: ' + (h.text || `${mb(h.got)} von ${mb(h.total)} MB`);
    else if (h.got > 0) t = `Höchste Qualität: ${mb(h.got)} von ${mb(h.total)} MB geladen – geht an dieser Stelle weiter.`;
    else t = `Höchste Qualität: noch nicht geladen (ca. ${mb(h.total)} MB).`;
    if (h.waitWifi && !h.done && !h.active) t += ' Startet automatisch im WLAN.';
    if (h.error && !h.active && !h.done) t += ' Letzter Versuch: ' + h.error + '.';
    el.hqInfo.textContent = t;
    el.hqBarWrap.hidden = h.done || !(h.active || h.got > 0);
    el.hqBar.style.width = (h.total ? Math.min(100, (100 * h.got) / h.total) : 0) + '%';
    el.hqLoad.hidden = h.done || h.active || state.quality !== 'high';
    el.hqLoad.textContent = h.got > 0 ? 'Download fortsetzen' : 'Jetzt laden';
  }
  async function updateStorageInfo() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const e = await navigator.storage.estimate();
      const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      el.storageInfo.textContent = `App-Speicher: ${mb(e.usage)} MB belegt · ` + (p
        ? 'dauerhaft gesichert'
        : 'nicht dauerhaft gesichert – Android darf ihn bei Speichermangel leeren. Abhilfe: App über das Chrome-Menü installieren.');
    } catch (e) { /* egal */ }
  }
  async function startHQ(confirmed) {
    const h = state.hq;
    if (h.done || h.active) return;
    if (!confirmed && isCellular()) { askData(); return; }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        const need = (h.total || 208e6) - (h.got || 0) + 30e6;
        if (e.quota && e.quota - (e.usage || 0) < need) {
          h.error = `zu wenig freier Speicher (benötigt ${mb(need)} MB, frei ${mb(e.quota - (e.usage || 0))} MB)`;
          renderHQ();
          addMsg('ai', 'Für höchste Qualität ist auf dem Handy nicht genug Speicher frei. Bitte etwas Platz schaffen – bis dahin wird mit Standard gearbeitet.', true);
          return;
        }
      } catch (e) { /* egal */ }
    }
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* egal */ } }
    Object.assign(h, { active: true, error: null, waitWifi: false });
    renderHQ();
    call('download', { model: 'lama' }).catch(() => {});
  }
  function askData() {
    const h = state.hq;
    el.dataText.textContent = `Das Modell für höchste Qualität ist ca. ${mb(h.total)} MB groß${h.got ? `, ${mb(h.got)} MB davon sind schon geladen` : ''}. Du bist gerade im Mobilfunknetz.`;
    if (!el.dataDlg.open) el.dataDlg.showModal();
  }
  function onDownload(m) {
    const h = state.hq;
    h.got = m.got; h.total = m.total || h.total; h.text = m.text || '';
    if (m.done) {
      h.done = true; h.active = false;
      addMsg('ai', 'Höchste Qualität ist jetzt dauerhaft auf dem Gerät gespeichert und wird nicht erneut geladen.');
      updateStorageInfo();
    } else if (m.error) {
      h.active = false;
      h.error = m.cancelled ? null : m.error;
      if (!m.cancelled) addMsg('ai', `Download unterbrochen bei ${mb(m.got)} von ${mb(m.total)} MB. Die geladenen Teile bleiben gespeichert – beim nächsten Versuch geht es dort weiter.`, true);
    } else h.active = true;
    renderHQ();
  }
  function noteFallback() {
    if (state.fbNoted) return;
    state.fbNoted = true;
    const h = state.hq;
    if (!h.active && !h.waitWifi && !isCellular()) startHQ(true);
    addMsg('ai', h.active || !isCellular()
      ? 'Höchste Qualität wird noch geladen – bis dahin wird mit Standard bearbeitet.'
      : 'Höchste Qualität ist noch nicht vollständig geladen – diesmal mit Standard bearbeitet. Unter „Mehr“ kannst du den Download starten.');
  }
  el.dataNow.addEventListener('click', () => { el.dataDlg.close(); startHQ(true); });
  el.dataWifi.addEventListener('click', () => {
    el.dataDlg.close();
    state.hq.waitWifi = true; renderHQ();
    addMsg('ai', 'Alles klar – der Download startet automatisch, sobald du im WLAN bist. Bis dahin wird mit Standard gearbeitet.');
  });
  el.hqLoad.addEventListener('click', () => startHQ(false));
  if (navigator.connection && navigator.connection.addEventListener) {
    navigator.connection.addEventListener('change', () => {
      const h = state.hq;
      if (state.quality === 'high' && !h.done && !h.active && !isCellular() && (h.waitWifi || h.got > 0)) startHQ(true);
    });
  }

  function askQuality() {
    return new Promise((resolve) => {
      const done = (q) => {
        el.qualityDlg.close();
        state.quality = q; store.set('bt-quality', q); updateQualityLabel();
        if (q === 'high') startHQ(false);
        resolve(q);
      };
      el.qStd.onclick = () => done('standard');
      el.qHigh.onclick = () => done('high');
      el.qualityDlg.oncancel = (e) => { e.preventDefault(); done('standard'); };
      el.qualityDlg.showModal();
    });
  }

  async function improve() {
    let usedHigh = false;
    if (!state.loaded) return;
    if (!state.text || BT.maskArea(state.text.mask) === 0) {
      const r = await applyAction({ type: 'auto' });
      if (r) addMsg('ai', 'Automatisch verbessert (Helligkeit, Kontrast, Farbe).');
      return;
    }
    if (!state.quality) await askQuality();
    const t = state.text;
    const ok = await run('Wird verbessert …', async () => {
      const cur = getCur();
      const base = copyImageData(t.base);
      const mask = new Uint8Array(t.mask);
      pushHistory();
      await resume.begin('improve', cur);
      const m = await call('improve', { base: pack(base), current: pack(cur), mask: { buffer: mask.buffer }, quality: quality(), detect: t.detect },
        [base.data.buffer, cur.data.buffer, mask.buffer]);
      applyResult(m);
      state.text = { base: t.base, mask: new Uint8Array(m.mask.buffer), detect: t.detect };
      usedHigh = quality() === 'high' && !m.fellBack;
    });
    if (ok) addMsg('ai', (usedHigh ? 'Mit höchster Qualität neu bearbeitet' : 'Neu bearbeitet, mit gründlicherer Suche und etwas größerem Bereich') + '.');
  }

  // Filter auf das Ergebnis anwenden (und auf die Basis für spätere Verbesserungen)
  async function applyAction(a) {
    return run('Wird angewendet …', async () => {
      const cur = getCur();
      pushHistory();
      const m = await call('filter', { image: pack(cur), action: a }, [cur.data.buffer]);
      applyResult(m);
      if (state.text) {
        const b = copyImageData(state.text.base);
        const mb = await call('filter', { image: pack(b), action: a }, [b.data.buffer]);
        state.text = Object.assign({}, state.text, { base: new ImageData(new Uint8ClampedArray(mb.image.buffer), mb.image.width, mb.image.height) });
      }
    });
  }

  // ------------------------------------------------------------ Vergleich & Tippen
  function layout() {
    if (!state.loaded) return;
    const maxW = el.viewer.parentElement.clientWidth;
    const maxH = Math.max(240, window.innerHeight * 0.52);
    const s = Math.min(maxW / state.w, maxH / state.h);
    el.viewer.style.width = Math.round(state.w * s) + 'px';
    el.viewer.style.height = Math.round(state.h * s) + 'px';
  }
  function setPos(p) {
    state.pos = Math.max(0, Math.min(1, p));
    el.cvOrig.style.clipPath = `inset(0 ${(1 - state.pos) * 100}% 0 0)`;
    el.divider.style.left = state.pos * 100 + '%';
  }
  let saveTimer = 0;
  function hideSave() { el.savePills.hidden = true; clearTimeout(saveTimer); }
  function toggleSave() {
    if (!el.savePills.hidden) { hideSave(); return; }
    el.savePills.hidden = false;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(hideSave, 6000);
  }
  function toImageXY(e) {
    const r = el.viewer.getBoundingClientRect();
    return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height, r };
  }

  let drag = null, drawing = null;
  el.viewer.addEventListener('pointerdown', (e) => {
    if (!state.loaded || state.busy || e.target.closest('button')) return;
    el.viewer.setPointerCapture(e.pointerId);
    if (state.mode === 'brush') { startStroke(e); return; }
    drag = { x: e.clientX, y: e.clientY, moved: false };
  });
  el.viewer.addEventListener('pointermove', (e) => {
    if (drawing) { continueStroke(e); return; }
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
    if (drag.moved && state.mode === 'compare') setPos(toImageXY(e).fx);
  });
  const endPointer = (e) => {
    if (drawing) { drawing = null; return; }
    if (drag && !drag.moved && e.type === 'pointerup') handleTap(e);
    drag = null;
  };
  el.viewer.addEventListener('pointerup', endPointer);
  el.viewer.addEventListener('pointercancel', endPointer);

  function handleTap(e) {
    if (state.mode === 'pick') { pickColor(e); return; }
    if (state.mode === 'compare') toggleSave();
  }

  // ------------------------------------------------------------ Farbton
  const HUES = [[0, 'Rot'], [30, 'Orange'], [55, 'Gelb'], [120, 'Grün'], [180, 'Türkis'], [220, 'Blau'], [275, 'Lila'], [320, 'Pink'], [360, 'Rot']];
  function hueName(h) {
    let best = HUES[0];
    for (const x of HUES) if (Math.abs(x[0] - h) < Math.abs(best[0] - h)) best = x;
    return best[1];
  }
  function enterPick(mode) {
    exitModes();
    state.mode = 'pick'; state.pickMode = mode;
    el.tools.querySelector('[data-tool="hue"]').setAttribute('aria-pressed', 'true');
    setHint(mode === 'keep' ? 'Tippe im Bild auf die Farbe, die erhalten bleiben soll.' : 'Tippe im Bild auf die Farbe, die entfernt werden soll.');
  }
  async function pickColor(e) {
    const { fx, fy } = toImageXY(e);
    const x = Math.round(fx * state.w), y = Math.round(fy * state.h);
    const x0 = Math.max(0, x - 3), y0 = Math.max(0, y - 3);
    const d = ctxR.getImageData(x0, y0, Math.min(7, state.w - x0), Math.min(7, state.h - y0)).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    const [h, s] = BT.rgb2hsv(r / n, g / n, b / n);
    if (s < 0.15) { setHint('Diese Stelle ist fast farblos – tippe auf eine kräftigere Farbe.'); return; }
    const mode = state.pickMode, name = hueName(h);
    exitModes();
    const ok = await applyAction({ type: 'hue', hue: h, mode, name });
    if (ok) addMsg('ai', mode === 'keep' ? `Nur ${name} behalten, alles andere grau.` : `${name}töne entfernt.`);
  }

  // ------------------------------------------------------------ Pinsel (Nachmalen / Objekt weg)
  function enterBrush(kind) {
    exitModes();
    state.mode = 'brush'; state.brushKind = kind;
    el.cvMask.width = state.w; el.cvMask.height = state.h;
    ctxM.clearRect(0, 0, state.w, state.h);
    if (kind === 'retouch' && state.text && BT.maskArea(state.text.mask)) {
      const img = ctxM.createImageData(state.w, state.h);
      const m = state.text.mask;
      for (let i = 0; i < m.length; i++) if (m[i]) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 60; img.data[i * 4 + 2] = 60; img.data[i * 4 + 3] = 140; }
      ctxM.putImageData(img, 0, 0);
    }
    el.cvMask.hidden = false;
    el.cvOrig.hidden = true; el.divider.hidden = true; el.tagL.hidden = true; el.tagR.hidden = true;
    el.actions.hidden = true; el.tools.hidden = true; el.brushBar.hidden = false;
    setHint(kind === 'retouch' ? 'Male über Reste, die noch verschwinden sollen. Rot = wird neu aufgefüllt.' : 'Male über das Objekt oder kreise es ein – die markierte Fläche wird mit Hintergrund aufgefüllt.');
  }
  function exitModes() {
    state.mode = 'compare'; state.brushKind = null;
    el.cvMask.hidden = true;
    el.cvOrig.hidden = false; el.divider.hidden = false; el.tagL.hidden = false; el.tagR.hidden = false;
    el.actions.hidden = false; el.tools.hidden = false; el.brushBar.hidden = true;
    el.tools.querySelector('[data-tool="hue"]').setAttribute('aria-pressed', 'false');
    defaultHint();
  }
  function strokeWidth() {
    const r = el.viewer.getBoundingClientRect();
    return Number(el.brushSize.value) * (state.w / r.width);
  }
  function startStroke(e) {
    const { fx, fy } = toImageXY(e);
    drawing = { x: fx * state.w, y: fy * state.h };
    ctxM.fillStyle = 'rgba(255,60,60,0.85)';
    ctxM.beginPath(); ctxM.arc(drawing.x, drawing.y, strokeWidth() / 2, 0, Math.PI * 2); ctxM.fill();
  }
  function continueStroke(e) {
    const { fx, fy } = toImageXY(e);
    const x = fx * state.w, y = fy * state.h;
    ctxM.strokeStyle = 'rgba(255,60,60,0.85)';
    ctxM.lineWidth = strokeWidth(); ctxM.lineCap = 'round'; ctxM.lineJoin = 'round';
    ctxM.beginPath(); ctxM.moveTo(drawing.x, drawing.y); ctxM.lineTo(x, y); ctxM.stroke();
    drawing.x = x; drawing.y = y;
  }
  async function applyBrush() {
    const md = ctxM.getImageData(0, 0, state.w, state.h).data;
    const raw = new Uint8Array(state.w * state.h);
    for (let i = 0; i < raw.length; i++) raw[i] = md[i * 4 + 3] > 0 ? 1 : 0;
    if (BT.maskArea(raw) === 0) { exitModes(); return; }
    const kind = state.brushKind;
    exitModes();
    await doBrush(kind, raw);   // Maske wird im Hintergrund aufbereitet (eingekreiste Flächen füllen, Rand ergänzen)
  }
  async function doBrush(kind, mask) {
    const t = state.text;
    const retouch = kind === 'retouch' && t && BT.maskArea(t.mask) > 0;
    const ok = await run('Bild wird rekonstruiert …', async () => {
      pushHistory();
      await resume.begin('brush', getCur(), { brushKind: kind, brushMask: new Uint8Array(mask) });
      if (retouch) {
        const base = copyImageData(t.base);
        const union = BT.maskUnion(t.mask, mask);
        const m = await call('inpaintMask', { image: pack(base), mask: { buffer: union.buffer }, quality: quality(), smart: t.detect, brush: true }, [base.data.buffer, union.buffer]);
        applyResult(m);
        state.text = { base: t.base, mask: new Uint8Array(m.mask.buffer), detect: t.detect };
      } else {
        const cur = getCur();
        const base = copyImageData(cur);
        const m = await call('inpaintMask', { image: pack(cur), mask: { buffer: mask.buffer }, quality: quality(), brush: true }, [cur.data.buffer, mask.buffer]);
        applyResult(m);
        state.text = { base, mask: new Uint8Array(m.mask.buffer), detect: false };
      }
    });
    if (ok) {
      // Ganzes Ergebnis zeigen – sonst verdeckt die „Original“-Hälfte die Änderung, wenn sie links liegt
      setPos(0);
      addMsg('ai', (retouch ? 'Markierte Stellen neu aufgefüllt.' : 'Objekt entfernt.') + ' Zum Vergleichen den Regler von links ins Bild ziehen.');
    }
  }

  // ------------------------------------------------------------ Speichern
  async function save(share) {
    const type = state.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(el.cvResult, type, 0.95);
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const fname = `bildtransformer_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${type === 'image/png' ? 'png' : 'jpg'}`;
    if (share) {
      const f = new File([blob], fname, { type });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], title: 'Bildtransformer' }); } catch (e) { /* abgebrochen */ }
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    hideSave();
    setHint('Gespeichert im Ordner „Downloads“.');
  }

  // ------------------------------------------------------------ Kommandos
  async function handleCommand(text) {
    addMsg('me', text);
    if (!state.loaded) { addMsg('ai', 'Wähle zuerst über das Plus ein Foto aus.'); return; }
    const { actions, unknown } = BT.parseCommand(text);
    if (!actions.length) {
      addMsg('ai', 'Das habe ich nicht verstanden. Probier zum Beispiel: „etwas heller und wärmer“, „Rot entfernen“, „nur Blau behalten“, „Retro-Look“, „schärfer“, „Schrift entfernen“ oder „rückgängig“.');
      return;
    }
    const done = [];
    for (const a of actions) {
      let ok;
      if (a.type === 'undo') ok = await undo();
      else if (a.type === 'reset') ok = resetToOriginal();
      else if (a.type === 'removeText') { const r = await removeText(false); ok = !!r; if (ok) continue; }
      else ok = await applyAction(a);
      if (!ok) break;
      done.push(BT.describeAction(a));
    }
    let reply = done.join(', ');
    if (reply) reply = reply.charAt(0).toUpperCase() + reply.slice(1) + '.';
    if (unknown.length) reply += (reply ? '\n' : '') + 'Nicht verstanden: „' + unknown.join('“, „') + '“';
    if (reply) addMsg('ai', reply);
  }

  // ------------------------------------------------------------ Ereignisse
  const pickFile = () => { if (!state.busy) el.file.click(); };
  el.addBtn.addEventListener('click', pickFile);
  el.resetBtn.addEventListener('click', askReset);
  el.resetYes.addEventListener('click', () => { el.resetDlg.close(); resetPhoto(); });
  el.resetNo.addEventListener('click', () => el.resetDlg.close());
  el.empty.addEventListener('click', pickFile);
  el.file.addEventListener('change', () => { const f = el.file.files[0]; el.file.value = ''; loadFile(f); });
  el.undoBtn.addEventListener('click', async () => { if (!state.busy && await undo()) addMsg('ai', 'Rückgängig gemacht.'); });
  el.saveBtn.addEventListener('click', () => save(false));
  el.shareBtn.addEventListener('click', () => save(true));
  el.shareBtn.hidden = !(navigator.canShare && navigator.share);
  el.improveBtn.addEventListener('click', improve);
  el.retouchBtn.addEventListener('click', () => enterBrush(state.text && BT.maskArea(state.text.mask) ? 'retouch' : 'object'));
  el.brushCancel.addEventListener('click', exitModes);
  el.brushApply.addEventListener('click', applyBrush);

  const CHIP_ACTIONS = {
    auto: { type: 'auto' }, brighter: { type: 'adjust', p: { brightness: 14 } }, sharper: { type: 'sharpen', amount: 0.8 },
    retro: { type: 'retro', strength: 1 }, bw: { type: 'grayscale', strong: false },
  };
  el.tools.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-tool]');
    if (!b || state.busy || !state.loaded) return;
    const tool = b.dataset.tool;
    if (tool === 'text') { exitModes(); await removeText(false); return; }
    if (tool === 'hue') { if (state.mode === 'pick') exitModes(); else enterPick('remove'); return; }
    if (tool === 'object') { enterBrush('object'); return; }
    if (tool === 'more') { notifyInfo(''); updateNotifyLabel(); el.moreDlg.showModal(); refreshHQ(); updateStorageInfo(); return; }
    exitModes();
    const a = CHIP_ACTIONS[tool];
    if (a && await applyAction(a)) addMsg('ai', BT.describeAction(a).replace(/^./, (c) => c.toUpperCase()) + '.');
  });

  const MORE_ACTIONS = {
    darker: { type: 'adjust', p: { brightness: -14 } }, contrastUp: { type: 'adjust', p: { contrast: 16 } },
    contrastDown: { type: 'adjust', p: { contrast: -16 } }, warmer: { type: 'adjust', p: { warmth: 16 } },
    cooler: { type: 'adjust', p: { warmth: -16 } }, vivid: { type: 'adjust', p: { saturation: 24 } },
    pale: { type: 'adjust', p: { saturation: -24 } }, soft: { type: 'sharpen', amount: -0.6 },
    bwStrong: { type: 'grayscale', strong: true },
  };
  function updateQualityLabel() {
    el.qualityToggle.textContent = 'Qualität: ' + (state.quality === 'high' ? 'Höchste' : 'Standard');
  }
  el.moreDlg.addEventListener('click', async (e) => {
    if (e.target === el.moreDlg) { el.moreDlg.close(); return; }
    const b = e.target.closest('button[data-more]');
    if (!b) return;
    const k = b.dataset.more;
    if (k === 'notify') { await toggleNotify(); return; }
    if (k === 'quality') {
      state.quality = state.quality === 'high' ? 'standard' : 'high';
      store.set('bt-quality', state.quality); updateQualityLabel();
      if (state.quality === 'high') startHQ(false);
      else { state.hq.waitWifi = false; if (state.hq.active) call('cancelDownload', { model: 'lama' }).catch(() => {}); }
      renderHQ();
      return;
    }
    el.moreDlg.close();
    if (!state.loaded || state.busy) return;
    if (k === 'colorPop') { enterPick('keep'); return; }
    if (k === 'reset') { resetToOriginal(); addMsg('ai', 'Zurück zum Original.'); return; }
    const a = MORE_ACTIONS[k];
    if (a && await applyAction(a)) addMsg('ai', BT.describeAction(a).replace(/^./, (c) => c.toUpperCase()) + '.');
  });
  el.moreClose.addEventListener('click', () => el.moreDlg.close());

  function autoGrow() { el.cmd.style.height = 'auto'; el.cmd.style.height = Math.min(110, el.cmd.scrollHeight) + 'px'; }
  el.cmd.addEventListener('input', autoGrow);
  el.cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.cmdForm.requestSubmit(); }
  });
  el.cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = el.cmd.value.trim();
    if (!t || state.busy) return;
    el.cmd.value = ''; autoGrow();
    handleCommand(t);
  });
  window.addEventListener('resize', layout);

  // Fotos per „Teilen“ aus der Galerie empfangen (Android)
  async function checkShared(discard) {
    if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
    try {
      const c = await caches.open('bt-share');
      const key = new URL('shared-image', location.href).href;
      const res = await c.match(key);
      history.replaceState(null, '', location.pathname);
      if (!res) return;
      if (discard) {
        await c.delete(key);
        addMsg('ai', 'Das geteilte Foto habe ich nicht geöffnet, damit die fortgesetzte Bearbeitung erhalten bleibt. Teile es danach einfach noch einmal.');
        return;
      }
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'geteiltes-bild.jpg');
      await c.delete(key);
      await loadFile(new File([blob], name, { type: blob.type || 'image/jpeg' }));
    } catch (e) { /* ignorieren */ }
  }

  // Offline-Fähigkeit und schnellere Berechnung (mehrere Threads) über den Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(async () => {
      if (!window.crossOriginIsolated && !navigator.serviceWorker.controller) {
        await navigator.serviceWorker.ready;
        let reloaded = null;
        try { reloaded = sessionStorage.getItem('bt-coi'); sessionStorage.setItem('bt-coi', '1'); } catch (e) { reloaded = '1'; }
        if (!reloaded && !state.loaded) location.reload();
      }
    }).catch(() => { /* ohne Service Worker läuft die App trotzdem */ });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Unterbrochene Bearbeitung wiederherstellen und fortsetzen
  function askResume(rec) {
    return new Promise((resolve) => {
      const what = { removeText: 'Schrift weg', improve: 'Verbessern', brush: rec.brushKind === 'retouch' ? 'Nachmalen' : 'Objekt weg' }[rec.kind] || 'Bearbeitung';
      el.resumeText.textContent = `„${what}“ für ${rec.name} wurde nicht fertig – vermutlich hat Android die App im Hintergrund beendet. Bereits berechnete Teile sind gespeichert.`;
      const done = (v) => { el.resumeDlg.close(); resolve(v); };
      el.resumeYes.onclick = () => done(true);
      el.resumeNo.onclick = () => done(false);
      el.resumeDlg.oncancel = (e) => { e.preventDefault(); done(null); };   // Zurück-Taste: später nochmal fragen
      el.resumeDlg.showModal();
    });
  }
  function restoreJob(rec) {
    const { w, h } = rec;
    for (const c of [el.cvOrig, el.cvResult]) { c.width = w; c.height = h; }
    ctxO.putImageData(new ImageData(rec.original.data, w, h), 0, 0);
    ctxR.putImageData(new ImageData(rec.current.data, w, h), 0, 0);
    Object.assign(state, {
      loaded: true, w, h, name: rec.name, type: rec.type, history: [],
      text: rec.text ? { base: new ImageData(rec.text.base.data, w, h), mask: rec.text.mask, detect: rec.text.detect } : null,
    });
    showPhoto('');
  }
  async function checkResume() {
    const rec = await resume.load();
    if (!rec || rec.v !== 1 || !rec.original || !rec.current) return false;
    const yes = await askResume(rec);
    if (yes === null) return false;
    if (!yes) { await resume.discard(); return false; }
    try { restoreJob(rec); } catch (e) {
      await resume.discard();
      addMsg('ai', 'Die unterbrochene Bearbeitung ließ sich leider nicht wiederherstellen.', true);
      return false;
    }
    addMsg('ai', 'Es geht an der Abbruchstelle weiter – schon berechnete Teile werden übersprungen.');
    resume.resuming = true;
    try {
      if (rec.kind === 'removeText') await removeText(rec.auto);
      else if (rec.kind === 'improve') await improve();
      else if (rec.kind === 'brush') await doBrush(rec.brushKind, rec.brushMask);
      else await resume.discard();
    } finally { resume.resuming = false; }
    return true;
  }

  updateQualityLabel();
  updateNotifyLabel();
  disableUI(false);
  defaultHint();
  checkResume().catch(() => false).then((resumed) => checkShared(resumed));
  // angefangenen Download im WLAN automatisch fortsetzen
  refreshHQ().then(() => {
    const h = state.hq;
    if (state.quality === 'high' && !h.done && !h.active && h.got > 0 && !isCellular()) startHQ(true);
  });
})();
