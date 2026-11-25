const repo = 'burntcookiedough/eve-windows-dictation';

// The channel comes from the tag; a stable release gets no label.
function channelFor({ tag_name: tag, prerelease }) {
  if (/-alpha\b/i.test(tag)) return 'alpha pre-release';
  if (/-beta\b/i.test(tag)) return 'beta pre-release';
  return prerelease || tag.includes('-') ? 'pre-release' : '';
}

// The release list also holds GPU runtime packs, so only accept app tags (v1.2.3...).
fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`)
  .then((response) => (response.ok ? response.json() : []))
  .then((releases) => {
    const release = releases.find((r) => !r.draft && /^v\d/.test(r.tag_name));
    if (!release) return;
    const channel = channelFor(release);
    document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = release.tag_name; });
    document.querySelectorAll('[data-channel]').forEach((el) => { el.textContent = channel && ` · ${channel}`; });
    // Anything that does not point into this repository leaves the static releases link in place.
    if (String(release.html_url).startsWith(`https://github.com/${repo}/`)) {
      document.querySelectorAll('[data-download]').forEach((el) => { el.href = release.html_url; });
    }
    const appData = document.getElementById('ld-app');
    appData.textContent = JSON.stringify({ ...JSON.parse(appData.textContent), softwareVersion: release.tag_name });
  })
  .catch(() => {});

const root = document.documentElement;
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = reducedQuery.matches;
const narrow = matchMedia('(max-width: 860px)');
let isStatic = reduced || narrow.matches;
root.classList.toggle('motion', !isStatic);

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const range = (v, a, b) => clamp((v - a) / (b - a));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------- the pill: the app's overlay states, driven by a pretend voice ---------- */

// From overlay/pill-view.ts and main/index.ts.
const VOICE_HOLD_MS = 800;
const INTRO_HOLD_MS = 1600;
const SUCCESS_DWELL_MS = 900;

// The markup and CSS port overlay/components/Pill.svelte; this only sets its props.
function makePill(box) {
  const pill = $('.eve-pill', box);
  const text = $('.text', pill);
  const put = (key, value) => { if (pill.dataset[key] !== value) pill.dataset[key] = value; };
  return {
    show({ phase, open = true, label = '', visible = true }) {
      pill.classList.toggle('is-hidden', !visible);
      put('phase', phase);
      put('open', String(open));
      // Like the app, keep the last label while closing so it clips away instead of blinking out.
      if (label && text.textContent !== label) text.textContent = label;
    },
    // Each lobe reads the voice a moment apart (1, 5 and 10 frames of 40 ms history).
    listen(now, speaking) {
      const lobe = (ago) => (speaking ? Math.sqrt(voice(now - ago)) : 0).toFixed(3);
      pill.style.setProperty('--left', lobe(0));
      pill.style.setProperty('--right', lobe(160));
      pill.style.setProperty('--middle', lobe(360));
    },
  };
}

// Smooth voice-like level in 0..1, with syllable-sized dips.
const voice = (t) => clamp(0.55 + 0.3 * Math.sin(t * 0.0047) + 0.2 * Math.sin(t * 0.013 + 1.7)) * (0.45 + 0.55 * Math.abs(Math.sin(t * 0.0105)));
const timer = (ms) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`;

/* ---------- hero: the cactus mirrors the app's Home view during one dictation ---------- */

const cactus = $('.hero-cactus .cactus');
const heroPill = makePill($('[data-hero-pill]'));
const heroState = $('[data-hero-state]');
const heroDot = $('[data-hero-dot]');
const heroRings = $('[data-hero-rings]');

function setCactus(state, level = 0) {
  for (const name of ['idle', 'listening', 'transcribing', 'done']) cactus.classList.toggle(`cactus--${name}`, name === state);
  cactus.style.setProperty('--lvl', level.toFixed(3));
}

function setHeroStatus(text, state) {
  if (heroState.textContent !== text) heroState.textContent = text;
  const dot = state === 'listening' || state === 'transcribing' ? `is-${state}` : '';
  if (heroDot.className !== dot) heroDot.className = dot;
  heroRings.classList.toggle('is-active', state === 'listening');
}

if (!reduced) {
  cactus.classList.add('cactus--draw');
  setTimeout(() => cactus.classList.remove('cactus--draw'), 2500);
}

const heroLoop = (() => {
  // Two spoken stretches with a pause long enough to show the quiet dot.
  const speech = [[0, 2600], [4700, 6400]];
  const marks = { idle: 900, starting: 1800, live: 8200, working: 9700 };
  marks.done = marks.working + SUCCESS_DWELL_MS;
  const end = marks.done + 1600;
  let start = performance.now() + 1600;
  return (now) => {
    if (now - start > end) start = now;
    const t = now - start;
    if (t < marks.idle || t >= marks.done) {
      heroPill.show({ phase: t < marks.idle ? 'live' : 'done', open: t >= marks.done, visible: false });
      setCactus('idle');
      setHeroStatus('ready', 'idle');
    } else if (t < marks.starting) {
      heroPill.show({ phase: 'starting', label: 'Starting' });
      setCactus('idle');
      setHeroStatus('starting', 'transcribing');
    } else if (t < marks.live) {
      const at = t - marks.starting;
      const speaking = speech.some(([from, to]) => at >= from && at < to);
      const open = at < INTRO_HOLD_MS || speech.some(([from, to]) => at >= from && at < to + VOICE_HOLD_MS);
      heroPill.show({ phase: 'live', open, label: timer(at) });
      heroPill.listen(now, speaking);
      setCactus('listening', speaking ? voice(now) : 0);
      setHeroStatus(`listening · 0:${timer(at).slice(2)}`, 'listening');
    } else if (t < marks.working) {
      heroPill.show({ phase: 'working', label: 'Transcribing' });
      setCactus('transcribing');
      setHeroStatus('transcribing', 'transcribing');
    } else {
      heroPill.show({ phase: 'done', label: '11 words' });
      setCactus('done');
      setHeroStatus('done', 'idle');
    }
  };
})();

// Reduced motion: one still, listening frame instead of the loop.
function holdHero() {
  heroPill.show({ phase: 'live', label: '0:07' });
  heroPill.listen(0, false);
  setCactus('idle');
  setHeroStatus('listening · 0:07', 'listening');
}
if (reduced) holdHero();

/* ---------- story: ready → listening → quiet → transcribing → pasted once ---------- */

const storyPill = makePill($('[data-story-pill]'));
const storyEditor = $('[data-story-editor]');
const storyTyped = $('[data-story-typed]');
const storyNote = $('[data-story-note]');
const storySteps = $$('.story-steps li');
const storyBig = $('[data-story-big]');
const storyLine = storyTyped.textContent;
const storyCount = `${storyLine.split(' ').length} words`;

function renderStory(p, now) {
  const step = p < 0.12 ? 0 : p < 0.44 ? 1 : p < 0.6 ? 2 : p < 0.76 ? 3 : 4;
  storySteps.forEach((li, i) => li.classList.toggle('is-on', i === step));
  if (storyBig.textContent !== `0${step + 1}`) storyBig.textContent = `0${step + 1}`;
  storyBig.style.transform = isStatic ? '' : `translate3d(0, ${(0.5 - p) * 30}vh, 0)`;
  const label = timer(range(p, 0.12, 0.6) * 7000);
  if (step === 0) storyPill.show({ phase: 'live', open: false, visible: false });
  else if (step === 1) storyPill.show({ phase: 'live', label });
  else if (step === 2) storyPill.show({ phase: 'live', open: false, label });
  else if (step === 3) storyPill.show({ phase: 'working', label: 'Transcribing' });
  // The pill leaves after its done state; reduced motion keeps the still frame.
  else storyPill.show({ phase: 'done', label: storyCount, visible: reduced || p < 0.93 });
  storyPill.listen(now, step === 1 && !reduced);
  // Nothing reaches the editor until the end: the whole text arrives in one paste.
  const text = step === 4 ? storyLine : '';
  if (storyTyped.textContent !== text) storyTyped.textContent = text;
  storyEditor.classList.toggle('is-pasted', step === 4);
  const note = step === 4 ? 'pasted once' : 'waiting for you to stop';
  if (storyNote.textContent !== note) storyNote.textContent = note;
}

/* ---------- fan: windows rise out of a stack ---------- */

const wins = $$('.win');
const fanBack = $('.fan-back');
const poses = {
  a: { x: -1.5, y: 30, ry: 13, rz: -3, s: 0.95, z: -90 },
  b: { x: -0.5, y: -6, ry: 4, rz: -1, s: 1, z: 20 },
  c: { x: 0.5, y: -6, ry: -4, rz: 1, s: 1, z: 20 },
  d: { x: 1.5, y: 30, ry: -13, rz: 3, s: 0.95, z: -90 },
};

function renderFan(p) {
  const e = easeInOut(range(p, 0.02, 0.62));
  const spread = Math.min(innerWidth * 0.235, wins[0].offsetWidth + 40);
  wins.forEach((win, i) => {
    const pose = poses[win.dataset.win];
    const x = lerp(0, pose.x * spread, e);
    const y = lerp(innerHeight * 0.22 + i * 12, pose.y, e);
    const rx = lerp(55, 0, e);
    const rz = lerp((i - 1.5) * 4, pose.rz, e);
    win.style.transform = `translate3d(${x}px, ${y}px, ${lerp(-200, pose.z, e)}px) rotateX(${rx}deg) rotateY(${pose.ry * e}deg) rotateZ(${rz}deg) scale(${lerp(0.82, pose.s, e)})`;
    win.style.setProperty('--cap', String(range(p, 0.62, 0.82)));
  });
  fanBack.style.transform = `translate3d(${10 - p * 80}vw, -50%, 0)`;
}

/* ---------- adds up: the activity grid fills in ---------- */

const heat = $('[data-heat]');
const cells = [];
{
  let s = 20261031;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const frag = document.createDocumentFragment();
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 53; col++) {
      const i = document.createElement('i');
      const r = rand();
      i.style.setProperty('--o', r < 0.38 ? '0.07' : r < 0.58 ? '0.24' : r < 0.76 ? '0.45' : r < 0.9 ? '0.7' : '0.95');
      cells.push({ el: i, at: (col / 53) * 0.86 + rand() * 0.12, on: false });
      frag.appendChild(i);
    }
  }
  heat.appendChild(frag);
}
const counters = $$('[data-count]');

function renderAdds(q) {
  for (const cell of cells) {
    const on = cell.at < q;
    if (on !== cell.on) { cell.on = on; cell.el.classList.toggle('on', on); }
  }
  const k = easeOut(q);
  counters.forEach((el) => {
    const text = Math.round(Number(el.dataset.count) * k).toLocaleString('en-US') + (el.dataset.suffix || '');
    if (el.textContent !== text) el.textContent = text;
  });
}

/* ---------- features: vertical scroll drives a horizontal rail ---------- */

const track = $('.track');
const rail = $('[data-rail]');
let railShift = 0;

/* ---------- privacy: scrubbed words ---------- */

const scrub = $('[data-scrub]');
const scrubWords = [];
{
  const words = scrub.textContent.trim().split(/\s+/);
  scrub.textContent = '';
  words.forEach((word, i) => {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = word;
    scrub.append(span, i < words.length - 1 ? ' ' : '');
    scrubWords.push(span);
  });
}

function renderScrub() {
  const rect = scrub.getBoundingClientRect();
  const q = reduced ? 1 : range(innerHeight * 0.8 - rect.top, 0, rect.height + innerHeight * 0.25);
  const n = Math.round(q * scrubWords.length);
  scrubWords.forEach((w, i) => w.classList.toggle('on', i < n));
}

/* ---------- tone: in dark mode, privacy turns the page to the app's light theme ---------- */

const themeMeta = $('meta[name="theme-color"]');
const syncThemeColor = () => { themeMeta.content = getComputedStyle(root).getPropertyValue('--bg').trim(); };
const lightQuery = matchMedia('(prefers-color-scheme: light)');
if (lightQuery.addEventListener) lightQuery.addEventListener('change', syncThemeColor);
syncThemeColor();
const lit = new Set();
if ('IntersectionObserver' in window) {
  const toneObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) lit.add(entry.target); else lit.delete(entry.target);
    }
    if (lit.size) root.dataset.tone = 'light'; else delete root.dataset.tone;
    syncThemeColor();
  }, { rootMargin: '-49% 0px -50% 0px' });
  $$('[data-tone="light"]').forEach((el) => toneObserver.observe(el));
}

/* ---------- reveal ---------- */

const reveals = $$('.reveal');
if ('IntersectionObserver' in window && !reduced) {
  root.classList.add('js');
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  reveals.forEach((el) => observer.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('is-visible'));
}

/* ---------- layout + the one frame loop ---------- */

const hero = $('.hero');
const story = $('.story');
const fan = $('.fan');
const adds = $('.adds');
const heroParts = {
  left: $('.ht-left'),
  right: $('.ht-right'),
  cactus: $('.hero-cactus'),
  ghost: $('.ghost'),
  pill: $('.hero-pill'),
  foot: $('.hero-foot'),
  cue: $('.scroll-cue'),
};
const depthEls = $$('[data-depth]');
const pins = new Map();

function measure() {
  isStatic = reduced || narrow.matches;
  root.classList.toggle('motion', !isStatic);
  if (isStatic) {
    track.style.height = '';
    rail.style.transform = '';
    wins.forEach((win) => { win.style.transform = ''; win.style.removeProperty('--cap'); });
    fanBack.style.transform = '';
    [...Object.values(heroParts), ...depthEls].forEach((el) => { el.style.transform = ''; el.style.opacity = ''; el.style.translate = ''; });
  } else {
    railShift = Math.max(0, rail.scrollWidth - innerWidth);
    track.style.height = `${railShift + innerHeight * 1.4}px`;
  }
  for (const el of [hero, story, fan, adds, track]) {
    const rect = el.getBoundingClientRect();
    pins.set(el, { top: rect.top + scrollY, span: Math.max(1, rect.height - innerHeight) });
  }
}

const progress = (el, y) => { const m = pins.get(el); return m ? clamp((y - m.top) / m.span) : 0; };
const near = (el, y) => { const m = pins.get(el); return !!m && y + innerHeight > m.top && y < m.top + m.span + innerHeight; };

let smoothY = scrollY;
const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
addEventListener('pointermove', (e) => {
  pointer.tx = (e.clientX / innerWidth) * 2 - 1;
  pointer.ty = (e.clientY / innerHeight) * 2 - 1;
}, { passive: true });

let staticAdds = 0;
let staticAddsStart = 0;

function frame(now) {
  smoothY = reduced ? scrollY : lerp(smoothY, scrollY, 0.12);
  if (Math.abs(smoothY - scrollY) < 0.1) smoothY = scrollY;
  pointer.x = lerp(pointer.x, pointer.tx, 0.06);
  pointer.y = lerp(pointer.y, pointer.ty, 0.06);

  if (!reduced && (isStatic || near(hero, smoothY))) heroLoop(now);

  if (isStatic) {
    // Reduced motion holds one readable frame; narrow screens auto-play the story.
    if (reduced) renderStory(0.84, 0);
    else renderStory((now / 12000) % 1, now);
    if (!staticAddsStart && !reduced) {
      const rect = heat.getBoundingClientRect();
      if (rect.top < innerHeight * 0.85 && rect.bottom > 0) staticAddsStart = now;
    }
    if (staticAddsStart) staticAdds = range(now - staticAddsStart, 0, 2400);
    renderAdds(reduced ? 1 : staticAdds);
  } else {
    const h = progress(hero, smoothY);
    const hp = easeInOut(h);
    {
      heroParts.left.style.transform = `translate3d(${-hp * 48}vw, 0, 0)`;
      heroParts.right.style.transform = `translate3d(${hp * 48}vw, 0, 0)`;
      heroParts.left.style.opacity = heroParts.right.style.opacity = String(1 - range(h, 0.35, 0.85));
      heroParts.cactus.style.transform = `translate3d(0, ${hp * 6}vh, 0) scale(${1 + hp * 1.1})`;
      heroParts.cactus.style.opacity = String(1 - range(h, 0.7, 1));
      heroParts.ghost.style.transform = `translate(-50%, calc(-50% - ${hp * 18}vh)) scale(${1 + hp * 0.25})`;
      const fade = 1 - range(h, 0, 0.35);
      heroParts.pill.style.opacity = heroParts.foot.style.opacity = heroParts.cue.style.opacity = String(fade);
      heroParts.pill.style.transform = `translate(-50%, ${(1 - fade) * 60}px)`;
      heroParts.foot.style.transform = `translateY(${(1 - fade) * 60}px)`;
      depthEls.forEach((el) => {
        const d = Number(el.dataset.depth);
        el.style.translate = `${pointer.x * d * -36}px ${pointer.y * d * -24}px`;
      });
    }
    if (near(story, smoothY)) renderStory(progress(story, smoothY), now);
    renderFan(progress(fan, smoothY));
    renderAdds(range(progress(adds, smoothY), 0.05, 0.85));
    rail.style.transform = `translate3d(${-progress(track, smoothY) * railShift}px, 0, 0)`;
  }

  renderScrub();
  requestAnimationFrame(frame);
}

let syncCrowd = () => {};
const onReducedChange = (e) => {
  reduced = e.matches;
  if (reduced) holdHero();
  // The counters already showed their final values; don't drop them back to zero.
  else if (!staticAddsStart) staticAddsStart = performance.now() - 2400;
  measure();
  syncCrowd();
};
if (reducedQuery.addEventListener) reducedQuery.addEventListener('change', onReducedChange);
else reducedQuery.addListener(onReducedChange);

measure();
addEventListener('resize', measure);
addEventListener('load', measure);
if (document.fonts) document.fonts.ready.then(measure);
requestAnimationFrame(frame);

/* ---------- footer crowd: Open Peeps walking across a canvas ---------- */

(() => {
  const canvas = $('.crowd-canvas');
  const ctx = canvas.getContext('2d');
  const sheet = new Image();
  const COLS = 15;
  const ROWS = 7;
  const CELL_H = 324;
  const stage = { w: 0, h: 0, dpr: 1, scale: 1 };
  let peeps = [];
  let running = false;
  let visible = false;
  let last = 0;

  const rand = (a, b) => a + Math.random() * (b - a);

  function place(peep, startProgress) {
    const dir = Math.random() > 0.5 ? 1 : -1;
    const w = peep.sw * stage.scale;
    const h = peep.sh * stage.scale;
    const depth = (100 - 160 * Math.random() ** 2) * (h / CELL_H);
    peep.w = w;
    peep.h = h;
    peep.dir = dir;
    peep.y = clamp(stage.h - h + depth, Math.max(12, stage.h * 0.2), stage.h - h);
    peep.from = dir === 1 ? -w : stage.w + w;
    peep.to = dir === 1 ? stage.w : 0;
    peep.speed = rand(0.38, 0.95);
    peep.duration = 14000 / peep.speed;
    peep.t = startProgress * peep.duration;
    peep.bob = Math.max(3, 10 * (h / CELL_H));
    peep.step = 320 / peep.speed;
  }

  function layout() {
    stage.w = canvas.clientWidth;
    stage.h = canvas.clientHeight;
    if (!stage.w || !stage.h) return;
    stage.dpr = Math.min(2, devicePixelRatio || 1);
    stage.scale = Math.max(0.28, Math.min(1, stage.w / 1440, (stage.h * 0.5) / CELL_H));
    canvas.width = Math.round(stage.w * stage.dpr);
    canvas.height = Math.round(stage.h * stage.dpr);
    peeps.forEach((peep) => place(peep, Math.random()));
    sortPeeps();
  }

  const sortPeeps = () => peeps.sort((a, b) => a.y - b.y);

  function draw() {
    ctx.setTransform(stage.dpr, 0, 0, stage.dpr, 0, 0);
    ctx.clearRect(0, 0, stage.w, stage.h);
    for (const p of peeps) {
      const k = p.t / p.duration;
      const x = lerp(p.from, p.to, k);
      const hop = reduced ? 0 : Math.abs(Math.sin((p.t / p.step) * Math.PI)) * p.bob;
      ctx.save();
      ctx.translate(x, p.y - hop);
      ctx.scale(p.dir, 1);
      ctx.drawImage(sheet, p.sx, p.sy, p.sw, p.sh, 0, 0, p.w, p.h);
      ctx.restore();
    }
  }

  function tick(now) {
    if (!visible || reduced) { running = false; return; }
    const dt = Math.min(64, now - (last || now));
    last = now;
    let resort = false;
    for (const p of peeps) {
      p.t += dt;
      if (p.t >= p.duration) { place(p, 0); resort = true; }
    }
    if (resort) sortPeeps();
    draw();
    requestAnimationFrame(tick);
  }

  function start() {
    const sw = sheet.naturalWidth / COLS;
    const sh = sheet.naturalHeight / ROWS;
    peeps = Array.from({ length: COLS * ROWS }, (_, i) => ({ sx: (i % COLS) * sw, sy: Math.floor(i / COLS) * sh, sw, sh }));
    layout();
    draw();
    if ('ResizeObserver' in window) new ResizeObserver(() => { layout(); draw(); }).observe(canvas);
    else addEventListener('resize', () => { layout(); draw(); });
    syncCrowd = () => {
      if (!reduced && visible && !running) { running = true; last = 0; requestAnimationFrame(tick); }
      if (reduced) draw();
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; syncCrowd(); }).observe(canvas);
    } else {
      // No visibility signal to pause on, so keep the still frame start() drew.
      syncCrowd();
    }
  }

  const load = () => {
    sheet.onload = start;
    // Browsers without AVIF fall back to the PNG.
    sheet.onerror = () => { sheet.onerror = null; sheet.src = 'assets/peeps/open-peeps-sheet.png'; };
    sheet.src = 'assets/peeps/open-peeps-sheet.avif';
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries, obs) => {
      if (!entries[0].isIntersecting) return;
      obs.disconnect();
      load();
    }, { rootMargin: '800px 0px' }).observe(canvas);
  } else {
    load();
  }
})();
