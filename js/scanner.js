// ScanDeals – Barcode-Scanner (nativer BarcodeDetector, Fallback ZXing)
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

let stream = null;
let video = null;
let rafId = 0;
let zxingControls = null;
let active = false;
let rejectActive = null;

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

/** Gibt Kamera und Erkennung frei. */
export function stopScanner() {
  active = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (zxingControls) { try { zxingControls.stop(); } catch {} zxingControls = null; }
  const s = stream || (video && video.srcObject);
  if (s && s.getTracks) s.getTracks().forEach((t) => t.stop());
  stream = null;
  const rej = rejectActive;
  rejectActive = null;
  if (rej) rej(Object.assign(new Error('Scan abgebrochen'), { name: 'AbortError' }));
}

function friendlyError(e) {
  if (e && (e.name === 'AbortError' || e.name === 'ScanError')) return e;
  let msg = 'Kamera konnte nicht gestartet werden.';
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) msg = 'Kamerazugriff verweigert. Erlaube die Kamera in den Browser-Einstellungen oder gib den Barcode in die Suche ein.';
  else if (e && e.name === 'NotFoundError') msg = 'Keine Kamera gefunden. Gib den Barcode in die Suche ein.';
  else if (e && e.code === 'ZXING') msg = 'Scanner-Bibliothek konnte nicht geladen werden (offline?). Gib den Barcode in die Suche ein.';
  const err = new Error(msg);
  err.name = 'ScanError';
  return err;
}

/**
 * Startet die Kamera im übergebenen <video> und liefert den erkannten Code.
 * Der Stream bleibt nach dem Treffer offen (Standbild); der Aufrufer ruft stopScanner().
 * options.onReady wird aufgerufen, sobald das Bild läuft.
 */
export async function startScanner(videoEl, { onReady } = {}) {
  stopScanner();
  video = videoEl;
  active = true;
  return new Promise(async (resolve, reject) => {
    rejectActive = reject;
    const done = (code) => {
      if (!active) return;
      active = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      rejectActive = null;
      resolve(String(code));
    };
    const fail = (e) => {
      if (!active) return;
      rejectActive = null;
      stopScanner();
      reject(friendlyError(e));
    };
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('no media'), { name: 'NotFoundError' });
      }
      const constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
      if ('BarcodeDetector' in window) {
        let detector;
        try { detector = new window.BarcodeDetector({ formats: FORMATS }); }
        catch { detector = null; }
        if (detector) {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (!active) { stopScanner(); return; }
          videoEl.srcObject = stream;
          videoEl.setAttribute('playsinline', '');
          await videoEl.play();
          if (onReady) onReady();
          let busy = false;
          const tick = async () => {
            if (!active) return;
            if (!busy && videoEl.readyState >= 2) {
              busy = true;
              try {
                const found = await detector.detect(videoEl);
                if (found && found.length) return done(found[0].rawValue);
              } catch {}
              busy = false;
            }
            rafId = requestAnimationFrame(tick);
          };
          tick();
          return;
        }
      }
      // Fallback: ZXing
      let mod;
      try { mod = await import(ZXING_URL); }
      catch (e) { throw Object.assign(new Error('zxing'), { code: 'ZXING' }); }
      if (!active) return;
      const reader = new mod.BrowserMultiFormatReader();
      videoEl.setAttribute('playsinline', '');
      zxingControls = await reader.decodeFromConstraints(constraints, videoEl, (result) => {
        if (result) done(result.getText());
      });
      if (!active) { try { zxingControls.stop(); } catch {} return; }
      if (onReady) onReady();
    } catch (e) {
      fail(e);
    }
  });
}
