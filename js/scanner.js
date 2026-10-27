// PreisFuchs – Barcode-Scanner (nativer BarcodeDetector, Fallback ZXing)
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

let stream = null;
let rafId = 0;
let zxingControls = null;
let active = false;
let rejectActive = null;

export function stopScanner() {
  active = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (zxingControls) { try { zxingControls.stop(); } catch {} zxingControls = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const rej = rejectActive;
  rejectActive = null;
  if (rej) rej(Object.assign(new Error('Scan abgebrochen'), { name: 'AbortError' }));
}

function friendlyError(e) {
  if (e && e.name === 'AbortError') return e;
  let msg = 'Kamera konnte nicht gestartet werden.';
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) msg = 'Kamerazugriff verweigert. Bitte erlaube die Kamera in den Browser-Einstellungen oder gib den Barcode manuell ein.';
  else if (e && e.name === 'NotFoundError') msg = 'Keine Kamera gefunden.';
  else if (e && e.code === 'ZXING') msg = 'Scanner-Bibliothek konnte nicht geladen werden (offline?). Bitte Barcode manuell eingeben.';
  const err = new Error(msg);
  err.name = 'ScanError';
  return err;
}

/** Startet die Kamera und liefert den erkannten Code. Lehnt bei Abbruch/Fehler ab. */
export async function startScanner(videoEl) {
  stopScanner();
  active = true;
  return new Promise(async (resolve, reject) => {
    rejectActive = reject;
    const done = (code) => {
      if (!active) return;
      try { navigator.vibrate && navigator.vibrate(100); } catch {}
      rejectActive = null;
      stopScanner();
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
      if (!active && zxingControls) { try { zxingControls.stop(); } catch {} }
    } catch (e) {
      fail(e);
    }
  });
}
