// ScanDeals – Objekterkennung im Handy (TensorFlow.js COCO-SSD, lazy geladen)
const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';
export const MIN_SCORE = 0.55;

export const LABELS_DE = {
  person: 'Person', bicycle: 'Fahrrad', car: 'Auto', motorcycle: 'Motorrad', airplane: 'Flugzeug', bus: 'Bus', train: 'Zug',
  truck: 'Lastwagen', boat: 'Boot', 'traffic light': 'Ampel', 'fire hydrant': 'Hydrant', 'stop sign': 'Stoppschild',
  'parking meter': 'Parkuhr', bench: 'Bank', bird: 'Vogel', cat: 'Katze', dog: 'Hund', horse: 'Pferd', sheep: 'Schaf',
  cow: 'Kuh', elephant: 'Elefant', bear: 'Bär', zebra: 'Zebra', giraffe: 'Giraffe', backpack: 'Rucksack',
  umbrella: 'Regenschirm', handbag: 'Handtasche', tie: 'Krawatte', suitcase: 'Koffer', frisbee: 'Frisbee', skis: 'Ski',
  snowboard: 'Snowboard', 'sports ball': 'Ball', kite: 'Drachen', 'baseball bat': 'Baseballschläger',
  'baseball glove': 'Baseballhandschuh', skateboard: 'Skateboard', surfboard: 'Surfbrett', 'tennis racket': 'Tennisschläger',
  bottle: 'Flasche', 'wine glass': 'Weinglas', cup: 'Tasse', fork: 'Gabel', knife: 'Messer', spoon: 'Löffel', bowl: 'Schüssel',
  banana: 'Banane', apple: 'Apfel', sandwich: 'Sandwich', orange: 'Orange', broccoli: 'Brokkoli', carrot: 'Karotte',
  'hot dog': 'Hotdog', pizza: 'Pizza', donut: 'Donut', cake: 'Kuchen', chair: 'Stuhl', couch: 'Sofa',
  'potted plant': 'Zimmerpflanze', bed: 'Bett', 'dining table': 'Esstisch', toilet: 'Toilette', tv: 'Fernseher',
  laptop: 'Laptop', mouse: 'Computermaus', remote: 'Fernbedienung', keyboard: 'Tastatur', 'cell phone': 'Smartphone',
  microwave: 'Mikrowelle', oven: 'Backofen', toaster: 'Toaster', sink: 'Spüle', refrigerator: 'Kühlschrank', book: 'Buch',
  clock: 'Uhr', vase: 'Vase', scissors: 'Schere', 'teddy bear': 'Teddybär', 'hair drier': 'Haartrockner',
  toothbrush: 'Zahnbürste',
};
export const labelDe = (c) => LABELS_DE[c] || String(c || 'Objekt');

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('Skript nicht ladbar: ' + src)); };
    document.head.appendChild(s);
  });
}

let modelPromise = null;

/** Lädt TF.js + COCO-SSD erst bei Bedarf (nutzt ein bereits vorhandenes window.cocoSsd). */
export function loadDetector() {
  if (!modelPromise) {
    modelPromise = (async () => {
      if (!window.cocoSsd) {
        if (!window.tf) await loadScript(TF_URL);
        await loadScript(COCO_URL);
      }
      if (!window.cocoSsd) throw new Error('COCO-SSD fehlt');
      return window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    })().catch((e) => { modelPromise = null; throw e; });
  }
  return modelPromise;
}
export const isDetectorLoaded = () => !!modelPromise;

/** Erkennt Objekte im Videobild → [{bbox:[x,y,w,h] (Videopixel), class, score}] (Score ≥ 0.55). */
export async function detect(videoEl) {
  const model = await loadDetector();
  const out = await model.detect(videoEl, 6);
  return (out || [])
    .filter((d) => d && Array.isArray(d.bbox) && d.score >= MIN_SCORE)
    .map((d) => ({ bbox: d.bbox.map(Number), class: String(d.class), score: Number(d.score) }));
}

/** Bestes Nicht-Personen-Objekt (Score, Fläche als Tie-Breaker). */
export function pickBest(dets, ignore = () => false) {
  let best = null, bestV = -1;
  for (const d of dets) {
    if (d.class === 'person' || ignore(d.class)) continue;
    const v = d.score * (0.6 + 0.4 * Math.min(1, (d.bbox[2] * d.bbox[3]) / (320 * 240)));
    if (v > bestV) { best = d; bestV = v; }
  }
  return best;
}
export const onlyPersons = (dets) => dets.length > 0 && dets.every((d) => d.class === 'person');

export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}

/** „Stabil“ = dieselbe Klasse in 3 aufeinanderfolgenden Durchläufen mit IoU > 0.5. */
export class Stabilizer {
  constructor(n = 3) { this.n = n; this.hist = []; }
  reset() { this.hist = []; }
  push(det) {
    if (!det) { this.hist = []; return false; }
    const last = this.hist[this.hist.length - 1];
    if (last && (last.class !== det.class || iou(last.bbox, det.bbox) <= 0.5)) this.hist = [];
    this.hist.push(det);
    if (this.hist.length > this.n) this.hist.shift();
    return this.hist.length >= this.n;
  }
}
