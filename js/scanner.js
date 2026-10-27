// ScanDeals – Kamera + Barcode-Erkennung (nativer BarcodeDetector, Fallback ZXing)
// Der Kamera-Stream wird einmal geöffnet und für Barcode- und Objekterkennung geteilt.
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
export const BARCODE_INTERVAL = 150;

let stream = null;
let video = null;
let openId = 0;
let loopOn = false;
let loopTimer = 0;

function track() {
  const s = stream || (video && video.srcObject);
  return s && s.getVideoTracks ? s.getVideoTracks()[0] || null : null;
}

/** Unterstützt die aktive Kamera eine Taschenlampe? */
export function hasTorch() {
  try {
    const t = track();
    const caps = t && t.getCapabilities ? t.getCapabilities() : null;
    return !!(caps && caps.torch);
  } catch { return false; }
}

/** Schaltet die Taschenlampe; liefert true bei Erfolg. */
export async function setTorch(on) {
  const t = track();
  if (!t) return false;
  try {
    await t.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  } catch { return false; }
}

/** Beendet die Barcode-Schleife (Kamera bleibt offen). */
export function stopBarcodeLoop() {
  loopOn = false;
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = 0; }
}

/** Gibt Kamera und Erkennung frei. */
export function stopScanner() {
  openId++;
  stopBarcodeLoop();
  const s = stream || (video && video.srcObject);
  if (s && s.getTracks) s.getTracks().forEach((t) => t.stop());
  stream = null;
}

function friendlyError(e) {
  if (e && (e.name === 'AbortError' || e.name === 'ScanError')) return e;
  let msg = 'Kamera konnte nicht gestartet werden.';
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) msg = 'Kamerazugriff verweigert. Erlaube die Kamera in den Browser-Einstellungen oder gib den Barcode in die Suche ein.';
  else if (e && e.name === 'NotFoundError') msg = 'Keine Kamera gefunden. Gib den Barcode in die Suche ein.';
  const err = new Error(msg);
  err.name = 'ScanError';
  return err;
}

/** Öffnet die Kamera (einmal) im übergebenen <video>. */
export async function openCamera(videoEl) {
  stopScanner();
  const id = openId;
  video = videoEl;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('no media'), { name: 'NotFoundError' });
    }
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (id !== openId) { s.getTracks().forEach((t) => t.stop()); throw Object.assign(new Error('abort'), { name: 'AbortError' }); }
    stream = s;
    videoEl.srcObject = s;
    videoEl.setAttribute('playsinline', '');
    await videoEl.play();
    if (id !== openId) throw Object.assign(new Error('abort'), { name: 'AbortError' });
  } catch (e) {
    if (id === openId) stopScanner();
    throw friendlyError(e);
  }
}

/**
 * Startet die Barcode-Erkennung auf dem bereits laufenden Video (alle ~150 ms).
 * onCode(code) wird einmal aufgerufen; onError(msg) bei nicht ladbarer Bibliothek.
 */
export function startBarcodeLoop(videoEl, onCode, onError) {
  stopBarcodeLoop();
  loopOn = true;
  let detector = null;
  if ('BarcodeDetector' in window) {
    try { detector = new window.BarcodeDetector({ formats: FORMATS }); } catch { detector = null; }
  }
  if (detector) {
    let busy = false;
    const tick = async () => {
      if (!loopOn) return;
      if (!busy && !document.hidden && videoEl.readyState >= 2) {
        busy = true;
        try {
          const found = await detector.detect(videoEl);
          if (!loopOn) return;
          if (found && found.length) { loopOn = false; onCode(String(found[0].rawValue)); return; }
        } catch { /* nächster Versuch */ }
        busy = false;
      }
      loopTimer = setTimeout(tick, BARCODE_INTERVAL);
    };
    tick();
    return;
  }
  // Fallback: ZXing liest einzelne Standbilder vom Video über ein Canvas.
  // So fasst ZXing den geteilten Kamera-Stream nie an (stop() würde sonst das Video leeren).
  (async () => {
    let mod;
    try { mod = await import(ZXING_URL); }
    catch {
      if (loopOn && onError) onError('Scanner-Bibliothek konnte nicht geladen werden (offline?). Gib den Barcode in die Suche ein.');
      return;
    }
    if (!loopOn) return;
    let reader;
    try { reader = new mod.BrowserMultiFormatReader(); }
    catch {
      if (onError) onError('Barcode-Erkennung konnte nicht gestartet werden.');
      return;
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!loopOn) return;
      const w = videoEl.videoWidth, h = videoEl.videoHeight;
      if (!document.hidden && videoEl.readyState >= 2 && w && h) {
        // Mittleren Bereich nehmen und auf max. 960 px verkleinern (schneller auf Handys)
        const sw = Math.round(w * 0.8), sh = Math.round(h * 0.6);
        const scale = Math.min(1, 960 / sw);
        canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
        ctx.drawImage(videoEl, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
        try {
          const result = reader.decodeFromCanvas(canvas);
          if (result && loopOn) { loopOn = false; onCode(result.getText()); return; }
        } catch { /* kein Barcode in diesem Bild */ }
      }
      loopTimer = setTimeout(tick, 200);
    };
    tick();
  })();
}
