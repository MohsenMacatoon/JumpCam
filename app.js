/* =====================================================================
   JumpCam: measures standing vertical jump height from a video.
   Everything runs on the phone. The video is never uploaded.

   Sections:
     1. Config
     2. Small helpers
     3. Settings and history storage
     4. Navigation
     5. Height input
     6. Recording guide (SVG drawings)
     7. Pose model loading (MediaPipe)
     8. Frame extraction (video -> landmarks per frame)
     9. Measurement (landmarks -> jump height)  <- the core math
    10. Results screen and replay
    11. History screen
    12. Settings screen
    13. Start-up
   ===================================================================== */

// ===== 1. Config =====================================================

// MediaPipe Tasks Vision, pinned to an exact version so it never changes under you.
// If a future version breaks something, change this number (and the copy in sw.js).
const MP_VERSION = '1.0.1';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
// "full" is more accurate than "lite" (about 9 MB vs 5 MB). For a faster, smaller
// download, swap "full" for "lite" in both places in this URL (and in sw.js).
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const ANALYSIS_MAX_SIDE = 960;  // frames are scaled to this size before pose detection
const MAX_FRAMES = 1200;        // longer videos are sampled, not analyzed frame by frame
const MAX_DURATION = 60;        // seconds

const SETTINGS_KEY = 'jumpcam:settings';

// MediaPipe landmark numbers for one side of the body
const SIDES = {
  left:  { hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31, shoulder: 11 },
  right: { hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32, shoulder: 12 }
};
const NOSE = 0;

// ===== 2. Small helpers ==============================================

const $ = id => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const median = arr => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
const std = arr => { const m = mean(arr); return Math.sqrt(mean(arr.map(v => (v - m) ** 2))); };
const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);
const cmToIn = cm => cm / 2.54;

function once(target, event) {
  return new Promise(resolve => target.addEventListener(event, resolve, { once: true }));
}

/** An analysis problem the user can fix. `code` picks the message. */
class AnalysisError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class Cancelled extends Error {}

// ===== 3. Settings and history storage ===============================

const settings = Object.assign(
  { heightCm: null, unit: 'cm', seenGuide: false, debug: false },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; } })()
);
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
}

// History lives in IndexedDB: { id, date, cm, toeCm, confidence, warnings, flightMs, slowmo }
const HistoryDB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('jumpcam', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('jumps', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('jumps', mode);
      const req = fn(tx.objectStore('jumps'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    all: () => run('readonly', s => s.getAll()),
    add: jump => run('readwrite', s => s.put(jump)),
    remove: id => run('readwrite', s => s.delete(id)),
    clear: () => run('readwrite', s => s.clear())
  };
})();

// ===== 4. Navigation =================================================
// One <section> is shown at a time. Browser history is used so the
// Android back button moves between screens.

const SCREENS = ['welcome', 'guide', 'home', 'analyzing', 'results', 'history', 'settings'];
let current = null;

function render(name) {
  SCREENS.forEach(s => { $('screen-' + s).hidden = s !== name; });
  current = name;
  $('toast').hidden = true;
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name !== 'results') stopReplay();
}

function go(name, { replace = false } = {}) {
  if (replace) history.replaceState({ screen: name }, '');
  else history.pushState({ screen: name }, '');
  render(name);
}

window.addEventListener('popstate', e => {
  const name = (e.state && e.state.screen) || (settings.heightCm ? 'home' : 'welcome');
  if (name === 'analyzing') { cancelAnalysis(); render('home'); return; }
  render(name);
});

document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => history.back()));

// ===== 5. Height input ===============================================
// Builds a cm / ft+in switch and inputs inside a container.

function buildHeightFields(box) {
  box.textContent = '';
  const sw = el('div', 'unit-switch');
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', 'Height unit');
  const inputs = el('div', 'height-inputs');

  const makeField = (label, name, attrs) => {
    const lab = el('label', 'num-field');
    lab.append(el('span', null, label));
    const inp = el('input');
    inp.type = 'number';
    inp.inputMode = 'decimal';
    inp.name = name;
    Object.assign(inp, attrs);
    lab.append(inp);
    return lab;
  };

  function draw(unit) {
    box.dataset.unit = unit;
    sw.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.unit === unit)));
    inputs.textContent = '';
    const cm = settings.heightCm;
    if (unit === 'cm') {
      inputs.append(makeField('Centimeters', 'cm', { min: 100, max: 230, step: '0.5', placeholder: '172', value: cm ? fmt1(cm).replace('.0', '') : '' }));
    } else {
      const totalIn = cm ? cmToIn(cm) : null;
      const ft = totalIn ? Math.floor(totalIn / 12) : '';
      const inch = totalIn ? Math.round(totalIn - ft * 12) : '';
      inputs.append(
        makeField('Feet', 'ft', { min: 3, max: 7, step: '1', placeholder: '5', value: ft }),
        makeField('Inches', 'in', { min: 0, max: 11.5, step: '0.5', placeholder: '8', value: inch })
      );
    }
  }

  [['cm', 'cm'], ['ftin', 'ft + in']].forEach(([unit, label]) => {
    const b = el('button', null, label);
    b.type = 'button';
    b.dataset.unit = unit;
    b.addEventListener('click', () => { settings.unit = unit; draw(unit); });
    sw.append(b);
  });

  box.append(sw, inputs);
  draw(settings.unit === 'ftin' ? 'ftin' : 'cm');
}

/** Reads the height from a container built above. Returns cm, or throws a message. */
function readHeight(box) {
  const get = n => { const i = box.querySelector(`input[name="${n}"]`); return i ? parseFloat(i.value) : NaN; };
  let cm;
  if (box.dataset.unit === 'cm') {
    cm = get('cm');
  } else {
    const ft = get('ft'), inch = get('in') || 0;
    cm = Number.isFinite(ft) ? (ft * 12 + inch) * 2.54 : NaN;
  }
  if (!Number.isFinite(cm)) throw 'Enter your height.';
  if (cm < 100 || cm > 230) throw 'Enter a height between 100 and 230 cm (3 ft 4 in to 7 ft 6 in).';
  return Math.round(cm * 10) / 10;
}

function bindHeightForm(form, box, errorEl, onSaved) {
  form.addEventListener('submit', e => {
    e.preventDefault();
    try {
      settings.heightCm = readHeight(box);
      errorEl.textContent = '';
      saveSettings();
      onSaved();
    } catch (msg) {
      errorEl.textContent = String(msg);
    }
  });
}

// ===== 6. Recording guide ============================================
// Simple drawings in SVG. Colors come from CSS classes so dark mode works.

const CHECK = (x, y) => `<path class="art-good" d="M${x} ${y + 6}l5 5 10-11" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const CROSS = (x, y) => `<path class="art-bad" d="M${x} ${y}l12 12M${x + 12} ${y}l-12 12" stroke-width="3.5" stroke-linecap="round"/>`;

// A stick figure seen from the side. (x, y) = feet on the floor. s = scale.
function sideFigure(x, y, s = 1, opts = {}) {
  const k = v => v * s;
  const hipY = y - k(42), shY = y - k(72), headY = y - k(84);
  const legs = opts.tuck
    ? `M${x} ${hipY}l${k(14)} ${k(10)}l${k(-10)} ${k(12)}l${k(8)} 0`   // knees tucked
    : opts.air
      ? `M${x} ${hipY}l${k(1)} ${k(40)}l${k(3)} ${k(4)}`                // straight legs, toes pointed down
      : `M${x} ${hipY}l${k(1)} ${k(42)}l${k(9)} 0`;                     // standing, toes forward
  return `<g class="art-ink" fill="none" stroke-width="${3 * s}" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="${x}" cy="${headY}" r="${k(9)}"/>
    <path d="M${x} ${headY + k(9)}L${x} ${hipY}"/>
    <path d="M${x} ${shY + k(4)}l${k(5)} ${k(24)}"/>
    <path d="${legs}"/>
  </g>`;
}

function frontFigure(x, y, s = 1) {
  const k = v => v * s;
  const hipY = y - k(42), headY = y - k(84);
  return `<g class="art-ink" fill="none" stroke-width="${3 * s}" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="${x}" cy="${headY}" r="${k(9)}"/>
    <path d="M${x} ${headY + k(9)}L${x} ${hipY}"/>
    <path d="M${x - k(14)} ${y - k(48)}L${x} ${y - k(70)}L${x + k(14)} ${y - k(48)}"/>
    <path d="M${x - k(9)} ${y}L${x} ${hipY}L${x + k(9)} ${y}"/>
  </g>`;
}

const GUIDE = [
  {
    title: 'Set up the camera',
    art: `<svg class="guide-art" viewBox="0 0 320 160" role="img" aria-label="Phone on a chair at hip height, 2.5 to 3 meters from the person, who stands side-on">
      <path class="art-muted" d="M10 120H310" stroke-width="2"/>
      <path class="art-muted" d="M28 96h44M32 96v24M68 96v24" stroke-width="3" stroke-linecap="round"/>
      <rect class="art-accent" x="43" y="66" width="14" height="28" rx="3" fill="none" stroke-width="3"/>
      <path class="art-muted" d="M58 76L232 14M58 84L232 118" stroke-width="1.5" stroke-dasharray="4 5"/>
      ${sideFigure(262, 120, 1)}
      <path class="art-accent" d="M62 138H252M62 133v10M252 133v10" stroke-width="2" stroke-linecap="round"/>
      <text class="art-text" x="157" y="154" text-anchor="middle">2.5 to 3 m</text>
      <text class="art-text" x="50" y="58" text-anchor="middle">hip height</text>
    </svg>`,
    items: [
      'Put the phone on a chair, table, or tripod at about hip height. Don’t hold it.',
      'Place it 2.5 to 3 meters from where you’ll jump.',
      'Hold the phone vertically (portrait).',
      'Good light, a plain background, and only one person in the frame.',
      'Wear fitted clothes so your hips and knees are visible. Avoid very baggy shorts.'
    ]
  },
  {
    title: 'Fit your whole body in the frame',
    art: `<svg class="guide-art" viewBox="0 0 320 170" role="img" aria-label="Portrait phone screen showing the whole body, space above the head, and the floor">
      <rect class="art-ink" x="110" y="6" width="100" height="158" rx="14" fill="none" stroke-width="3"/>
      <path class="art-muted" d="M116 140H204" stroke-width="2"/>
      ${sideFigure(158, 140, 0.95)}
      <path class="art-accent" d="M222 16V52M216 22l6-6 6 6M216 46l6 6 6-6" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <text class="art-text" x="234" y="30">space</text>
      <text class="art-text" x="234" y="44">to jump</text>
      <text class="art-text" x="234" y="144">floor visible</text>
      <path class="art-accent" d="M206 140h24" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    items: [
      'Your whole body must be visible, with space above your head for the jump.',
      'The floor under your feet must be visible.',
      'Stand in the middle of the frame.'
    ]
  },
  {
    title: 'Show your side to the camera',
    art: `<svg class="guide-art" viewBox="0 0 320 140" role="img" aria-label="Side view is correct, front view is wrong">
      <path class="art-muted" d="M20 112H140M180 112H300" stroke-width="2"/>
      ${sideFigure(80, 112, 1)}
      ${frontFigure(240, 112, 1)}
      ${CHECK(104, 10)}
      ${CROSS(266, 12)}
      <text class="art-text" x="80" y="132" text-anchor="middle">Side view</text>
      <text class="art-text" x="240" y="132" text-anchor="middle">Not front or back</text>
    </svg>`,
    items: [
      'Stand with your side facing the camera, not your front or back.',
      'Either side works, but use the same side every time so results compare fairly.'
    ]
  },
  {
    title: 'Jump',
    art: `<svg class="guide-art" viewBox="0 0 320 160" role="img" aria-label="In the air, keep legs straight and toes pointed. Don't tuck your knees.">
      <path class="art-muted" d="M20 136H140M180 136H300" stroke-width="2"/>
      ${sideFigure(80, 110, 1, { air: true })}
      ${sideFigure(240, 110, 1, { tuck: true })}
      <path class="art-accent" d="M80 132v-12M74 126l6-6 6 6" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      ${CHECK(106, 14)}
      ${CROSS(268, 16)}
      <text class="art-text" x="80" y="150" text-anchor="middle">Straight legs</text>
      <text class="art-text" x="240" y="150" text-anchor="middle">No tucked knees</text>
    </svg>`,
    ordered: true,
    items: [
      'Start recording, then stand still for 2 seconds. The app uses this to calibrate.',
      'Jump straight up on the same spot. Swinging your arms is fine.',
      'In the air, keep your legs straight and toes pointed. Don’t tuck your knees.',
      'Land on the same spot, then stand still for 1 second before you stop recording.',
      'Don’t move toward or away from the camera.'
    ],
    tip: 'Tip: slow motion (120 to 240 fps) in your phone’s camera app gives the best accuracy. Normal video also works.'
  }
];

function buildGuide() {
  const box = $('guideContent');
  box.textContent = '';
  GUIDE.forEach((step, i) => {
    const sec = el('article', 'guide-step');
    const h = el('h2');
    h.append(el('span', 'step-num', String(i + 1)), document.createTextNode(step.title));
    sec.append(h);
    sec.insertAdjacentHTML('beforeend', step.art);
    const list = el(step.ordered ? 'ol' : 'ul');
    step.items.forEach(t => list.append(el('li', null, t)));
    sec.append(list);
    if (step.tip) sec.append(el('p', 'guide-tip', step.tip));
    box.append(sec);
  });
}

$('guideDone').addEventListener('click', () => {
  settings.seenGuide = true;
  saveSettings();
  if (history.state && history.state.fromWelcome) go('home', { replace: true });
  else history.back();
});

// ===== 7. Pose model loading =========================================

let landmarkerPromise = null;
let testLandmarker = null; // used only by automated tests

function getLandmarker() {
  if (testLandmarker) return Promise.resolve(testLandmarker);
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const options = delegate => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        outputSegmentationMasks: true,   // used to find the top of the head
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      try {
        return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
      } catch (e) {
        // Some phones can't use the GPU path; the CPU is slower but works everywhere.
        return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
      }
    })();
    landmarkerPromise.then(() => updateModelStatus(true)).catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

async function updateModelStatus(ready) {
  let cached = ready;
  if (!cached && 'caches' in window) {
    try { cached = !!(await caches.match(MODEL_URL)); } catch (e) { /* ignore */ }
  }
  $('modelStatus').textContent = cached
    ? 'AI model saved on this phone. Works offline.'
    : 'The AI model (about 20 MB) downloads once, the first time you analyze a video.';
}

// ===== 8. Frame extraction ===========================================
// Steps through the video one frame at a time, runs pose detection on each,
// and stores the landmarks plus the top of the person (from the mask).

let cancelRequested = false;
let timestampBase = 0; // VIDEO mode needs ever-increasing timestamps, even across videos
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function cancelAnalysis() { cancelRequested = true; }

/** Finds the file's frame rate by playing a moment of video in slow motion and
    reading each frame's exact media time. Falls back to 30 fps. */
async function measureFps(video) {
  if (!hasRVFC) return { fps: 30, measured: false };
  const times = [];
  await new Promise(resolve => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; video.pause(); resolve(); } };
    const onFrame = (now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 14) finish();
      else video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.playbackRate = 0.25; // slow playback so no frames are skipped
    video.play().catch(finish);
    setTimeout(finish, 2500);
  });
  video.playbackRate = 1;
  const diffs = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0.0005) diffs.push(d);
  }
  if (diffs.length < 3) return { fps: 30, measured: false };
  // The smallest gap is one frame (larger gaps mean a frame was skipped).
  const sorted = diffs.sort((a, b) => a - b);
  const frameDur = median(sorted.slice(0, Math.max(3, Math.ceil(sorted.length / 2))));
  let fps = 1 / frameDur;
  const common = [24, 25, 30, 48, 50, 60, 90, 100, 120, 240];
  const near = common.find(c => Math.abs(fps - c) / c < 0.04);
  if (near) fps = near;
  return { fps, measured: true };
}

/** Seeks and resolves with the exact media time of the frame now shown. */
function seekTo(video, t) {
  return new Promise(resolve => {
    let settled = false, frameTime = null, handle = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      if (handle !== null && frameTime === null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      resolve(frameTime !== null ? frameTime : video.currentTime);
    };
    const onSeeked = () => { if (hasRVFC) setTimeout(finish, 120); else finish(); };
    if (hasRVFC) handle = video.requestVideoFrameCallback((now, meta) => { frameTime = meta.mediaTime; finish(); });
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

/** Finds the highest row of the person in the segmentation mask (0..1 from the top). */
function maskTop(mask, landmarks) {
  const w = mask.width, h = mask.height;
  const data = mask.getAsFloat32Array();
  let minX = 1, maxX = 0;
  for (const p of landmarks) {
    if (p.v > 0.3) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
  }
  if (minX > maxX) return null;
  const x0 = Math.max(0, Math.floor((minX - 0.12) * w));
  const x1 = Math.min(w - 1, Math.ceil((maxX + 0.12) * w));
  for (let y = 0; y < h; y++) {
    let hits = 0;
    const row = y * w;
    for (let x = x0; x <= x1; x += 2) {
      if (data[row + x] > 0.5 && ++hits >= 2) return y / h;
    }
  }
  return null;
}

async function extractFrames(file, landmarker, onProgress) {
  const video = $('workVideo');
  const url = URL.createObjectURL(file);
  try {
    video.src = url;
    // loadedmetadata is the event every browser fires reliably (iPhone may hold back
    // 'loadeddata' until playback starts; measureFps starts it).
    await Promise.race([once(video, 'loadedmetadata'), once(video, 'error').then(() => { throw new AnalysisError('badVideo'); })]);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new AnalysisError('badVideo');
    if (duration > MAX_DURATION) throw new AnalysisError('tooLong');

    const { fps, measured } = await measureFps(video);
    let step = 1 / fps;
    let total = Math.floor(duration * fps);
    let sampled = false;
    if (total > MAX_FRAMES) { step = duration / MAX_FRAMES; total = MAX_FRAMES; sampled = true; }

    // Scale frames down for speed. Landmarks come back as 0..1, so size doesn't matter.
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(vw, vh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: false });

    const frames = [];
    let lastTime = -1, lastTs = timestampBase;

    for (let i = 0; i < total; i++) {
      if (cancelRequested) throw new Cancelled();
      // Aim for the middle of each frame so rounding never lands on its neighbor.
      const target = Math.min(duration - 0.0005, (i + 0.5) * step);
      const t = await seekTo(video, target);
      if (t <= lastTime + 1e-6) { onProgress(i + 1, total); continue; } // same frame twice
      lastTime = t;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const ts = Math.max(lastTs + 1, timestampBase + Math.round(t * 1000));
      lastTs = ts;

      const res = landmarker.detectForVideo(canvas, ts);
      const raw = res && res.landmarks && res.landmarks[0];
      let lm = null, top = null;
      if (raw) {
        lm = raw.map(p => ({ x: p.x, y: p.y, v: p.visibility != null ? p.visibility : 1 }));
        const mask = res.segmentationMasks && res.segmentationMasks[0];
        if (mask) {
          try { top = maskTop(mask, lm); } catch (e) { top = null; }
        }
      }
      if (res && res.segmentationMasks) res.segmentationMasks.forEach(m => { try { m.close(); } catch (e) { /* ignore */ } });
      if (res && typeof res.close === 'function') { try { res.close(); } catch (e) { /* ignore */ } }

      frames.push({ t, lm, top });
      onProgress(i + 1, total);
      if (i % 4 === 0) await new Promise(r => setTimeout(r, 0)); // let the progress bar repaint
    }
    timestampBase = lastTs + 1000;
    return { frames, meta: { w: canvas.width, h: canvas.height, fps, fpsMeasured: measured, duration, sampled } };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ===== 9. Measurement ================================================
// Turns per-frame landmarks into a jump height. Pure math, no DOM.
// All positions are in pixels of the analyzed frame; y grows downward.

/** Centered moving average. Window grows with frame rate. */
function smooth(arr, win) {
  const half = Math.floor(win / 2);
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
    }
    return s / n;
  });
}

function angleDeg(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

/**
 * frames: [{ t, lm: [{x,y,v}] (0..1) or null, top: 0..1 or null }]
 * meta:   { w, h, fps, fpsMeasured, sampled }
 * heightCm: the user's height
 */
function measureJump(frames, meta, heightCm) {
  const W = meta.w, H = meta.h;

  // --- Step 1: keep frames where a person was found -------------------
  const valid = frames.filter(f => f.lm);
  if (valid.length < 12 || valid.length < frames.length * 0.6) throw new AnalysisError('noPerson');

  // --- Step 2: pick the side facing the camera ------------------------
  // The side with the higher average visibility for hip, knee, ankle, heel, toe.
  const visOf = side => mean(valid.map(f => {
    const s = SIDES[side];
    return (f.lm[s.hip].v + f.lm[s.knee].v + f.lm[s.ankle].v + f.lm[s.heel].v + f.lm[s.toe].v) / 5;
  }));
  const visL = visOf('left'), visR = visOf('right');
  const sideName = visL >= visR ? 'left' : 'right';
  const S = SIDES[sideName];
  const visibility = Math.max(visL, visR);
  if (visibility < 0.5) throw new AnalysisError('lowVisibility');

  // --- Step 3: build smoothed paths (pixels) --------------------------
  const win = meta.fps >= 90 ? 5 : 3;
  const path = idx => ({
    x: smooth(valid.map(f => f.lm[idx].x * W), win),
    y: smooth(valid.map(f => f.lm[idx].y * H), win)
  });
  const hip = path(S.hip), knee = path(S.knee), ankle = path(S.ankle), heel = path(S.heel), toe = path(S.toe);
  const t = valid.map(f => f.t);
  const n = valid.length;
  const footY = toe.y.map((ty, i) => Math.max(ty, heel.y[i])); // lowest foot point = on the floor when standing

  // --- Step 4: calibration from the stillest standing moment ----------
  // Slide a window over the first 60% of the video and pick the stillest stretch.
  // Take the EARLIEST window that is nearly as still as the stillest one, so the
  // standing moment after landing is never mistaken for the start.
  const calLen = Math.max(5, Math.min(30, Math.round(n * 0.08)));
  const scores = [];
  for (let s = 0; s + calLen <= Math.max(calLen, Math.floor(n * 0.6)); s++) {
    const hy = hip.y.slice(s, s + calLen), fy = footY.slice(s, s + calLen);
    scores.push(std(hy) + std(fy));
  }
  const minScore = Math.min(...scores);
  const startIdx = scores.findIndex(sc => sc <= Math.max(minScore * 1.5, 1.5));
  const best = { start: startIdx, score: scores[startIdx] };
  const calIdx = [];
  for (let i = best.start; i < best.start + calLen; i++) calIdx.push(i);

  const floorY = median(calIdx.map(i => footY[i]));
  const hipStandY = median(calIdx.map(i => hip.y[i]));
  let topY = median(calIdx.map(i => valid[i].top).filter(v => v != null)) * H;
  let topFromMask = Number.isFinite(topY);
  if (!topFromMask) {
    // Fallback: estimate the top of the head from the nose and shoulder.
    const noseY = median(calIdx.map(i => valid[i].lm[NOSE].y * H));
    const shY = median(calIdx.map(i => valid[i].lm[S.shoulder].y * H));
    topY = noseY - 0.62 * (shY - noseY);
  }

  if (topY <= H * 0.01) throw new AnalysisError('headCut');
  if (floorY >= H * 0.985) throw new AnalysisError('feetCut');
  const bodyPx = floorY - topY;
  if (bodyPx < H * 0.2) throw new AnalysisError('tooSmall');

  const cmPerPx = heightCm / bodyPx;                 // the ruler
  const stillCm = std(calIdx.map(i => hip.y[i])) * cmPerPx;
  if (stillCm > 2) throw new AnalysisError('notStill');

  // --- Step 5: takeoff and landing from the toe -----------------------
  const liftPx = Math.max(2, 3 / cmPerPx);           // toe must be 3 cm above the floor
  const airborne = toe.y.map(y => y < floorY - liftPx);
  const HOLD = 3;                                    // frames it must stay up (or down)
  const allFrom = (i, val) => { for (let j = i; j < i + HOLD; j++) if (j >= n || airborne[j] !== val) return false; return true; };

  let takeoff = -1;
  for (let i = best.start + calLen; i < n; i++) { if (allFrom(i, true)) { takeoff = i; break; } }
  if (takeoff < 1) throw new AnalysisError('noJump');

  let landing = -1;
  for (let i = takeoff + HOLD; i < n; i++) { if (allFrom(i, false)) { landing = i; break; } }
  if (landing < 0) throw new AnalysisError('noLanding');

  // --- Step 6: peak = highest hip point while in the air --------------
  let peak = takeoff;
  for (let i = takeoff; i < landing; i++) if (hip.y[i] < hip.y[peak]) peak = i;

  // --- Step 7: main result = hip rise from takeoff to peak ------------
  // The first frame "in the air" is caught a little after the real takeoff (at
  // 30 fps the feet can rise up to 10 cm between frames). With straight legs the
  // hip and toe rise together, so add back how far the toe had already lifted.
  const takeoffLiftPx = Math.max(0, floorY - toe.y[takeoff]);
  const hipCm = (hip.y[takeoff] - hip.y[peak] + takeoffLiftPx) * cmPerPx;
  // --- Step 8: secondary result = toe height above the floor at peak --
  const toeCm = (floorY - toe.y[peak]) * cmPerPx;

  if (hipCm < 3) throw new AnalysisError('noJump');
  if (hipCm > 130) throw new AnalysisError('implausible');

  // --- Step 9: flight time and slow-motion detection ------------------
  // Flight starts between the last ground frame and the first air frame (and the
  // same for landing), so use the midpoints.
  const flightVideo = ((t[landing] + t[landing - 1]) / 2) - ((t[takeoff] + t[takeoff - 1]) / 2);
  const flightExpected = Math.sqrt(8 * (hipCm / 100) / 9.81);   // physics: t = sqrt(8h/g)
  const rawFactor = flightVideo / flightExpected;
  let slowmo = 1;
  if (rawFactor >= 1.6) {
    const snaps = [2, 4, 8];
    slowmo = snaps.find(s => Math.abs(rawFactor - s) / s < 0.25) || Math.round(rawFactor);
  }
  const flightReal = flightVideo / slowmo;
  const flightFrames = landing - takeoff;

  // --- Form checks -----------------------------------------------------
  const warnings = [];
  let lowConfidence = 0;

  const kneeAngle = angleDeg(
    { x: hip.x[peak], y: hip.y[peak] }, { x: knee.x[peak], y: knee.y[peak] }, { x: ankle.x[peak], y: ankle.y[peak] }
  );
  if (kneeAngle < 160) warnings.push('Your legs bent in the air, so the result may be too high. Try again with straight legs.');

  let drift = 0;
  for (let i = takeoff; i <= landing; i++) drift = Math.max(drift, Math.abs(hip.x[i] - hip.x[takeoff]));
  const driftCm = drift * cmPerPx;
  if (driftCm > 12) warnings.push('You moved during the jump. Try to jump straight up on the same spot.');

  const diff = Math.abs(hipCm - toeCm);
  if (diff > Math.max(5, hipCm * 0.2)) {
    warnings.push('Hip and toe measurements don’t agree well, so confidence is lower. Keep your toes pointed and the camera steady.');
    lowConfidence++;
  }
  if (!topFromMask) {
    warnings.push('The top of your head wasn’t clear, so height calibration is approximate. Try a plainer background.');
    lowConfidence++;
  }
  if (flightFrames < 6) {
    warnings.push('Only a few frames were in the air. Slow-motion video will give a more accurate result.');
    lowConfidence++;
  }
  if (meta.sampled) {
    warnings.push('This video was long, so not every frame was analyzed. Trim it to just the jump for best accuracy.');
    lowConfidence++;
  }
  if (visibility < 0.7) {
    warnings.push('Your legs were hard to see in parts of the video. Better light or fitted clothes will help.');
  }

  const score = warnings.length + lowConfidence;
  const confidence = score === 0 ? 'High' : score <= 2 ? 'Medium' : 'Low';

  // --- Data for the replay and debug graph -----------------------------
  const frameIndex = valid.map(f => frames.indexOf(f));
  return {
    cm: hipCm,
    toeCm,
    confidence,
    warnings,
    side: sideName,
    kneeAngle,
    driftCm,
    flightVideo,
    flightReal,
    slowmo,
    rawFactor,
    fps: meta.fps,
    fpsMeasured: meta.fpsMeasured,
    captureFps: meta.fps * slowmo,
    times: { takeoff: t[takeoff], peak: t[peak], landing: t[landing], calStart: t[best.start], calEnd: t[best.start + calLen - 1] },
    sideIdx: S,
    hipPath: valid.map((f, i) => ({ t: f.t, x: hip.x[i] / W, y: hip.y[i] / H })),
    graph: valid.map((f, i) => ({ t: f.t, hip: (hipStandY - hip.y[i]) * cmPerPx, toe: (floorY - toe.y[i]) * cmPerPx })),
    debug: { n, framesTotal: frames.length, calStart: best.start, calLen, takeoff, peak, landing, floorY, topY, bodyPx, cmPerPx, stillCm, liftPx, visL, visR, topFromMask, frameIndex: frameIndex.length }
  };
}

const ERRORS = {
  badVideo: ['This video can’t be opened', 'Your browser couldn’t read this file. Try recording a new video with your camera, or a different video.'],
  tooLong: ['This video is too long', 'Videos must be under 60 seconds. Trim it to just the jump: 2 seconds standing, the jump, and 1 second after landing.'],
  noPerson: ['No person found', 'The AI couldn’t find a person in most of the video. Make sure your whole body is in the frame with good light.'],
  lowVisibility: ['Your legs weren’t clear enough', 'Hips, knees, and feet must be clearly visible. Use better light, wear fitted clothes, and stand side-on to the camera.'],
  headCut: ['Your head is cut off', 'Your whole body must be in the frame while you stand at the start, with space above your head.'],
  feetCut: ['Your feet are cut off', 'The floor under your feet must be visible. Tilt the phone down a little or move it farther back.'],
  tooSmall: ['You’re too small in the frame', 'Move the phone closer (about 2.5 to 3 meters away) so your body fills more of the frame.'],
  notStill: ['No still standing at the start', 'Stand completely still for 2 seconds after you start recording. The app uses this moment to calibrate.'],
  noJump: ['No jump found', 'We couldn’t see your feet leave the floor. Make sure your feet and the floor are visible the whole time.'],
  noLanding: ['Landing not found', 'Keep recording until you’ve landed and stood still for 1 second.'],
  implausible: ['That result doesn’t look right', 'The measurement came out unrealistically high. Check that you entered your height correctly and that only one person is in the frame.'],
  model: ['The AI model couldn’t load', 'Connect to the internet for the first analysis so the model can download (about 20 MB). After that, it works offline.']
};

// ===== 10. Results screen and replay =================================

let lastResult = null;
let replayUrl = null;
let replayFrames = [];
let rafId = null;

async function startAnalysis(file) {
  if (!file) return;
  if (!settings.heightCm) { go('welcome'); return; }
  cancelRequested = false;
  go('analyzing');
  setProgress(0, 'Loading the AI model…');

  let landmarker;
  try {
    landmarker = await getLandmarker();
  } catch (e) {
    console.error(e);
    showError('model');
    return;
  }
  if (cancelRequested) return;

  try {
    setProgress(0, 'Reading the video…');
    const { frames, meta } = await extractFrames(file, landmarker, (done, total) => {
      setProgress(done / total, `Frame ${done} of ${total}`);
    });
    setProgress(1, 'Measuring…');
    const result = measureJump(frames, meta, settings.heightCm);
    showResult(result, frames, file);
  } catch (e) {
    if (e instanceof Cancelled) return;
    console.error(e);
    showError(e instanceof AnalysisError ? e.code : 'badVideo', e instanceof AnalysisError ? null : e);
  }
}

function setProgress(fraction, detail) {
  const pct = Math.round(fraction * 100);
  $('progressFill').style.width = pct + '%';
  $('progressBar').setAttribute('aria-valuenow', String(pct));
  $('progressPct').textContent = pct + '%';
  if (detail) $('progressDetail').textContent = detail;
}

$('cancelBtn').addEventListener('click', () => {
  cancelAnalysis();
  go('home', { replace: true });
});

function showError(code, err) {
  const [title, text] = ERRORS[code] || ERRORS.badVideo;
  $('errorTitle').textContent = title;
  $('errorText').textContent = text + (err && settings.debug ? `\n\n(${err.message || err})` : '');
  $('resultError').hidden = false;
  $('resultOk').hidden = true;
  go('results', { replace: true });
}

function showResult(r, frames, file) {
  lastResult = r;
  replayFrames = frames;
  $('resultError').hidden = true;
  $('resultOk').hidden = false;

  $('resCm').textContent = fmt1(r.cm);
  $('resIn').textContent = fmt1(cmToIn(r.cm)) + ' inches';
  const badge = $('resBadge');
  badge.textContent = r.confidence + ' confidence';
  badge.className = 'badge badge-' + r.confidence.toLowerCase();
  drawMeter(r.cm);

  const wl = $('resWarnings');
  wl.textContent = '';
  r.warnings.forEach(w => wl.append(el('li', null, w)));

  const details = [
    ['Toe height at peak', fmt1(r.toeCm) + ' cm'],
    ['Flight time', Math.round(r.flightReal * 1000) + ' ms'],
    ['Video frame rate', r.fpsMeasured ? Math.round(r.fps) + ' fps' : 'about 30 fps (estimated)'],
    ['Speed', r.slowmo > 1
      ? `Slow motion detected (about ${r.slowmo}x)`
      : 'Normal speed'],
    ['Knee angle at peak', Math.round(r.kneeAngle) + '°'],
    ['Side used', r.side === 'left' ? 'Left side' : 'Right side']
  ];
  if (r.slowmo > 1) details.splice(2, 0, ['Flight time in video', Math.round(r.flightVideo * 1000) + ' ms']);
  const dl = $('resDetails');
  dl.textContent = '';
  details.forEach(([k, v]) => {
    const d = el('div');
    d.append(el('dt', null, k), el('dd', null, v));
    dl.append(d);
  });

  $('debugCard').hidden = !settings.debug;
  if (settings.debug) drawDebug(r);

  const saveBtn = $('saveBtn');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save to history';

  // Replay
  if (replayUrl) URL.revokeObjectURL(replayUrl);
  replayUrl = URL.createObjectURL(file);
  const v = $('replayVideo');
  v.src = replayUrl;
  v.addEventListener('loadeddata', () => { seekReplay(r.times.peak); }, { once: true });

  go('results', { replace: true });
}

function drawMeter(cm) {
  const svg = $('meter');
  const max = Math.max(80, Math.ceil(cm / 20) * 20);
  const y = v => 190 - (v / max) * 180;
  let ticks = '';
  for (let v = 0; v <= max; v += 10) {
    ticks += `<path d="M6 ${y(v)}H${v % 20 === 0 ? 18 : 13}" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/>`;
  }
  svg.innerHTML = `
    <rect x="24" y="10" width="26" height="180" rx="8" fill="var(--line)"/>
    <rect x="24" y="${y(Math.min(cm, max))}" width="26" height="${190 - y(Math.min(cm, max))}" rx="8" fill="var(--primary)"/>
    ${ticks}
    <path d="M20 ${y(Math.min(cm, max))}H54" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>`;
}

// --- Replay with skeleton overlay ---
const BONES = [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32]];

function nearestFrame(time) {
  let lo = 0, hi = replayFrames.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (replayFrames[mid].t < time) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(replayFrames[lo - 1].t - time) < Math.abs(replayFrames[lo].t - time)) lo--;
  return lo;
}

function drawOverlay() {
  const v = $('replayVideo'), c = $('overlay'), r = lastResult;
  if (!r || !v.videoWidth) return;
  const stage = $('playerStage');
  const dpr = window.devicePixelRatio || 1;
  const cw = stage.clientWidth, ch = stage.clientHeight;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  // Where the video actually sits inside the stage (object-fit: contain)
  const s = Math.min(cw / v.videoWidth, ch / v.videoHeight);
  const dw = v.videoWidth * s, dh = v.videoHeight * s;
  const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  const X = x => ox + x * dw, Y = y => oy + y * dh;
  const css = getComputedStyle(document.documentElement);
  const hipColor = css.getPropertyValue('--hip').trim() || '#C2410C';

  // Hip path traced through the whole jump
  const pts = r.hipPath.filter(p => p.t >= r.times.takeoff - 0.6 * (r.times.landing - r.times.takeoff) && p.t <= r.times.landing + 0.3 * (r.times.landing - r.times.takeoff));
  if (pts.length > 1) {
    ctx.strokeStyle = hipColor;
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    ctx.stroke();
    ctx.setLineDash([]);
    const pk = r.hipPath.reduce((a, b) => (Math.abs(b.t - r.times.peak) < Math.abs(a.t - r.times.peak) ? b : a));
    ctx.fillStyle = hipColor;
    ctx.beginPath(); ctx.arc(X(pk.x), Y(pk.y), 6, 0, Math.PI * 2); ctx.fill();
  }

  // Skeleton for the current frame
  const i = nearestFrame(v.currentTime);
  const f = i >= 0 ? replayFrames[i] : null;
  if (f && f.lm) {
    const near = new Set(Object.values(r.sideIdx));
    BONES.forEach(([a, b]) => {
      const pa = f.lm[a], pb = f.lm[b];
      if (pa.v < 0.3 || pb.v < 0.3) return;
      const strong = near.has(a) && near.has(b);
      ctx.strokeStyle = strong ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.45)';
      ctx.lineWidth = strong ? 4 : 2.5;
      ctx.beginPath(); ctx.moveTo(X(pa.x), Y(pa.y)); ctx.lineTo(X(pb.x), Y(pb.y)); ctx.stroke();
    });
    [r.sideIdx.hip, r.sideIdx.knee, r.sideIdx.ankle, r.sideIdx.toe].forEach(idx => {
      const p = f.lm[idx];
      ctx.fillStyle = idx === r.sideIdx.hip ? hipColor : '#fff';
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), idx === r.sideIdx.hip ? 7 : 5, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function loop() {
  drawOverlay();
  if (!$('replayVideo').paused) rafId = requestAnimationFrame(loop);
  else rafId = null;
}

function stopReplay() {
  const v = $('replayVideo');
  if (v && !v.paused) v.pause();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function seekReplay(time) {
  const v = $('replayVideo');
  v.pause();
  v.currentTime = Math.max(0, time + 0.0005);
}

$('replayVideo').addEventListener('seeked', drawOverlay);
$('replayVideo').addEventListener('loadeddata', drawOverlay);
$('replayVideo').addEventListener('play', () => { $('playIcon').setAttribute('href', '#i-pause'); $('playToggle').setAttribute('aria-label', 'Pause'); if (!rafId) loop(); });
$('replayVideo').addEventListener('pause', () => { $('playIcon').setAttribute('href', '#i-play'); $('playToggle').setAttribute('aria-label', 'Play'); drawOverlay(); });
window.addEventListener('resize', drawOverlay);

$('playToggle').addEventListener('click', () => {
  const v = $('replayVideo');
  if (v.paused) { if (v.ended) v.currentTime = 0; v.play().catch(() => {}); } else v.pause();
});
$('toPeak').addEventListener('click', () => lastResult && seekReplay(lastResult.times.peak));
function stepFrame(dir) {
  const v = $('replayVideo');
  v.pause();
  let i = nearestFrame(v.currentTime) + dir;
  i = Math.max(0, Math.min(replayFrames.length - 1, i));
  if (replayFrames[i]) seekReplay(replayFrames[i].t);
}
$('stepBack').addEventListener('click', () => stepFrame(-1));
$('stepFwd').addEventListener('click', () => stepFrame(1));

// --- Debug graph ---
function drawDebug(r) {
  const W = 320, H = 180, pad = 26;
  const ts = r.graph.map(g => g.t);
  const t0 = ts[0], t1 = ts[ts.length - 1] || t0 + 1;
  const vals = r.graph.flatMap(g => [g.hip, g.toe]);
  const vmin = Math.min(-5, ...vals), vmax = Math.max(10, ...vals);
  const X = t => pad + (t - t0) / (t1 - t0) * (W - pad - 8);
  const Y = v => H - 18 - (v - vmin) / (vmax - vmin) * (H - 30);
  const line = key => r.graph.map((g, i) => (i ? 'L' : 'M') + X(g.t).toFixed(1) + ' ' + Y(g[key]).toFixed(1)).join('');
  const mark = (t, label) => `<path d="M${X(t)} 8V${H - 18}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="${X(t) + 3}" y="16" fill="var(--muted)" font-size="9">${label}</text>`;
  $('debugGraph').innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Hip and toe height over time">
    <path d="M${pad} ${Y(0)}H${W - 8}" stroke="var(--line)"/>
    <rect x="${X(r.times.calStart)}" y="8" width="${Math.max(1, X(r.times.calEnd) - X(r.times.calStart))}" height="${H - 26}" fill="var(--good)" opacity=".12"/>
    ${mark(r.times.takeoff, 'takeoff')}${mark(r.times.peak, 'peak')}${mark(r.times.landing, 'landing')}
    <path d="${line('hip')}" fill="none" stroke="var(--hip)" stroke-width="2"/>
    <path d="${line('toe')}" fill="none" stroke="var(--toe)" stroke-width="2"/>
    <text x="2" y="${Y(vmax) + 4}" fill="var(--muted)" font-size="9">${Math.round(vmax)}</text>
    <text x="2" y="${Y(0) + 3}" fill="var(--muted)" font-size="9">0</text>
    <text x="${pad}" y="${H - 4}" fill="var(--muted)" font-size="9">${fmt1(t0)}s</text>
    <text x="${W - 8}" y="${H - 4}" fill="var(--muted)" font-size="9" text-anchor="end">${fmt1(t1)}s</text>
  </svg>`;
  const d = r.debug;
  $('debugText').textContent =
    `frames analyzed ${d.n}/${d.framesTotal}, side ${r.side} (vis L ${fmt1(d.visL * 100)}% R ${fmt1(d.visR * 100)}%)\n` +
    `calibration frames ${d.calStart}-${d.calStart + d.calLen - 1}, stillness ${fmt1(d.stillCm)} cm, head top from ${d.topFromMask ? 'mask' : 'estimate'}\n` +
    `body ${fmt1(d.bodyPx)} px, scale ${d.cmPerPx.toFixed(3)} cm/px, lift threshold ${fmt1(d.liftPx)} px\n` +
    `takeoff #${d.takeoff} ${r.times.takeoff.toFixed(3)}s, peak #${d.peak} ${r.times.peak.toFixed(3)}s, landing #${d.landing} ${r.times.landing.toFixed(3)}s\n` +
    `hip ${fmt1(r.cm)} cm, toe ${fmt1(r.toeCm)} cm, knee ${Math.round(r.kneeAngle)}°, drift ${fmt1(r.driftCm)} cm\n` +
    `flight video ${Math.round(r.flightVideo * 1000)} ms, factor ${r.rawFactor.toFixed(2)} -> ${r.slowmo}x`;
}

// --- Result buttons ---
$('saveBtn').addEventListener('click', async () => {
  const r = lastResult;
  if (!r) return;
  try {
    await HistoryDB.add({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: Date.now(),
      cm: Math.round(r.cm * 10) / 10,
      toeCm: Math.round(r.toeCm * 10) / 10,
      confidence: r.confidence,
      warnings: r.warnings,
      flightMs: Math.round(r.flightReal * 1000),
      slowmo: r.slowmo
    });
    $('saveBtn').disabled = true;
    $('saveBtn').textContent = 'Saved';
    toast('Saved to history');
  } catch (e) {
    toast('Couldn’t save. Storage may be full or blocked.');
  }
});

$('retryBtn').addEventListener('click', () => go('home', { replace: true }));
$('errorRetry').addEventListener('click', () => go('home', { replace: true }));
$('resultsBack').addEventListener('click', () => go('home', { replace: true }));
$('errorGuide').addEventListener('click', () => go('guide'));

$('shareBtn').addEventListener('click', async () => {
  const r = lastResult;
  if (!r) return;
  const text = `I jumped ${fmt1(r.cm)} cm (${fmt1(cmToIn(r.cm))} in) on a standing vertical jump, measured with JumpCam. Confidence: ${r.confidence}.`;
  try {
    if (navigator.share) await navigator.share({ title: 'My vertical jump', text });
    else { await navigator.clipboard.writeText(text); toast('Result copied'); }
  } catch (e) { /* user closed the share sheet */ }
});

// ===== 11. History screen ============================================

async function renderHistory() {
  let jumps = [];
  try { jumps = await HistoryDB.all(); } catch (e) { toast('History is unavailable in this browser.'); }
  jumps.sort((a, b) => a.date - b.date);

  $('historyEmpty').hidden = jumps.length > 0;
  $('clearHistory').hidden = jumps.length === 0;
  $('historyChartCard').hidden = jumps.length < 2;
  if (jumps.length >= 2) drawHistoryChart(jumps);

  const list = $('historyList');
  list.textContent = '';
  jumps.slice().reverse().forEach(j => {
    const li = el('li', 'history-item');
    const big = el('span', 'history-cm', fmt1(j.cm));
    big.append(el('small', null, ' cm'));
    li.append(big);
    const meta = el('span', 'history-meta');
    const nWarn = j.warnings ? j.warnings.length : 0;
    meta.append(
      el('strong', null, new Date(j.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })),
      document.createTextNode(`${fmt1(cmToIn(j.cm))} in, ${j.confidence.toLowerCase()} confidence${nWarn ? ', ' + nWarn + ' warning' + (nWarn > 1 ? 's' : '') : ''}`)
    );
    const del = el('button', 'icon-btn');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete jump from ' + new Date(j.date).toLocaleDateString());
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this jump?')) return;
      await HistoryDB.remove(j.id);
      renderHistory();
    });
    li.append(meta, del);
    list.append(li);
  });
}

function drawHistoryChart(jumps) {
  const W = 320, H = 170, padL = 34, padR = 12, padT = 14, padB = 26;
  const vals = jumps.map(j => j.cm);
  const lo = Math.floor((Math.min(...vals) - 3) / 5) * 5, hi = Math.ceil((Math.max(...vals) + 3) / 5) * 5;
  const X = i => padL + (jumps.length === 1 ? 0.5 : i / (jumps.length - 1)) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const d = jumps.map((j, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(j.cm).toFixed(1)).join('');
  const dateStr = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let grid = '';
  for (let v = lo; v <= hi; v += Math.max(5, Math.round((hi - lo) / 4 / 5) * 5)) {
    grid += `<path d="M${padL} ${Y(v)}H${W - padR}" stroke="var(--line)"/><text x="${padL - 6}" y="${Y(v) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${v}</text>`;
  }
  $('historyChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Jump height over time, from ${fmt1(vals[0])} to ${fmt1(vals[vals.length - 1])} cm">
    ${grid}
    <path d="${d}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    ${jumps.map((j, i) => `<circle cx="${X(i)}" cy="${Y(j.cm)}" r="4" fill="var(--primary)"/>`).join('')}
    <text x="${padL}" y="${H - 6}" fill="var(--muted)" font-size="10">${dateStr(jumps[0].date)}</text>
    <text x="${W - padR}" y="${H - 6}" fill="var(--muted)" font-size="10" text-anchor="end">${dateStr(jumps[jumps.length - 1].date)}</text>
    <text x="4" y="${padT - 2}" fill="var(--muted)" font-size="10">cm</text>
  </svg>`;
}

$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Delete all saved jumps? This can’t be undone.')) return;
  await HistoryDB.clear();
  renderHistory();
});

// ===== 12. Settings screen ===========================================

function renderSettings() {
  buildHeightFields($('settingsHeightFields'));
  $('settingsHeightError').textContent = '';
  $('debugToggle').checked = !!settings.debug;
}
$('debugToggle').addEventListener('change', e => { settings.debug = e.target.checked; saveSettings(); });
bindHeightForm($('settingsHeightForm'), $('settingsHeightFields'), $('settingsHeightError'), () => toast('Height saved: ' + fmt1(settings.heightCm) + ' cm'));

// ===== Home ===========================================================

async function renderHome() {
  updateModelStatus(false);
  try {
    const jumps = await HistoryDB.all();
    if (jumps.length) {
      const best = jumps.reduce((a, b) => (b.cm > a.cm ? b : a));
      $('homeBestValue').textContent = fmt1(best.cm) + ' cm';
      $('homeBestSub').textContent = `${fmt1(cmToIn(best.cm))} in, ${new Date(best.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
      $('homeBest').hidden = false;
    } else {
      $('homeBest').hidden = true;
    }
  } catch (e) { $('homeBest').hidden = true; }
}

$('recordBtn').addEventListener('click', () => $('recordInput').click());
$('galleryBtn').addEventListener('click', () => $('galleryInput').click());
['recordInput', 'galleryInput'].forEach(id => $(id).addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  startAnalysis(file);
}));
$('openGuide').addEventListener('click', () => go('guide'));
$('openHistory').addEventListener('click', () => go('history'));
$('openSettings').addEventListener('click', () => go('settings'));

// ===== 13. Start-up ===================================================

buildGuide();
buildHeightFields($('heightFields'));
bindHeightForm($('heightForm'), $('heightFields'), $('heightError'), () => {
  if (!settings.seenGuide) {
    history.replaceState({ screen: 'home' }, '');
    history.pushState({ screen: 'guide', fromWelcome: true }, '');
    render('guide');
  } else {
    go('home', { replace: true });
  }
});

go(settings.heightCm ? 'home' : 'welcome', { replace: true });

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Hooks for automated tests only (no effect on normal use)
window.JumpCam = { measureJump, setTestLandmarker: l => { testLandmarker = l; }, startAnalysis };
