// ScanDeals – Splash: Glas-Logo schwebt in der Mitte und morpht (FLIP + Spring) in den Header
import { SPRING, isReduced, sleep } from './motion.js';

export async function runSplash(targetEl) {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const finish = () => {
    targetEl.style.opacity = '1';
    splash.remove();
    document.documentElement.classList.remove('splashing');
  };
  if (isReduced()) { finish(); return; }

  const fly = document.getElementById('splash-fly');
  const tile = fly.querySelector('.splash-tile');
  const word = splash.querySelector('.splash-word');
  const bg = splash.querySelector('.splash-bg');
  const twinkle = splash.querySelector('.twinkle');

  let skip;
  const skipped = new Promise((r) => { skip = r; });
  splash.addEventListener('pointerdown', () => skip(), { once: true });
  await Promise.race([sleep(950), skipped]);

  // FLIP: Ziel messen, Delta + Skalierung berechnen
  const f = fly.getBoundingClientRect();
  const t = targetEl.getBoundingClientRect();
  const dx = t.left + t.width / 2 - (f.left + f.width / 2);
  const dy = t.top + t.height / 2 - (f.top + f.height / 2);
  const s = t.width / f.width;

  const cur = getComputedStyle(tile).transform;
  tile.getAnimations().forEach((a) => a.cancel());
  tile.animate([{ transform: cur === 'none' ? 'none' : cur }, { transform: 'none' }], { duration: 300, easing: 'ease-out', fill: 'forwards' });
  if (twinkle) twinkle.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
  word.animate([{ opacity: 1, transform: 'translate3d(0,0,0)' }, { opacity: 0, transform: 'translate3d(0,-10px,0)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
  bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: 80, easing: 'ease-out', fill: 'forwards' });

  const move = fly.animate(
    [{ transform: 'translate3d(0,0,0) scale(1)' }, { transform: `translate3d(${dx}px,${dy}px,0) scale(${s})` }],
    { duration: SPRING.duration, easing: SPRING.easing, fill: 'forwards' },
  );
  try { await move.finished; } catch { /* ignorieren */ }
  finish();
}
