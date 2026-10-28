const repo = 'burntcookiedough/eve-windows-dictation';

fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`)
  .then((response) => (response.ok ? response.json() : []))
  .then(([release]) => {
    if (!release) return;
    document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = release.tag_name; });
    document.querySelectorAll('[data-download]').forEach((el) => { el.href = release.html_url; });
  })
  .catch(() => {});

const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
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

/* ---------- the pill, rebuilt from the overlay ---------- */

function makePill(el, count = 30) {
  const bars = Array.from({ length: count }, () => el.appendChild(document.createElement('i')));
  const seeds = bars.map((_, i) => 1.3 + ((i * 7919) % 97) / 40);
  return {
    el,
    render(t, level) {
      const c = (count - 1) / 2;
      bars.forEach((bar, i) => {
        const envelope = Math.exp(-(((i - c) / (count * 0.26)) ** 2));
        const wobble = 0.35 + 0.65 * Math.abs(Math.sin(t * seeds[i] * 0.006 + i * 1.3));
        bar.style.height = `${3 + level * envelope * wobble * 44}px`;
      });
    },
  };
}

// Smooth voice-ish level from time: 0 when silent, ~0.4–1 while talking.
const voice = (t) => clamp(0.55 + 0.3 * Math.sin(t * 0.0047) + 0.2 * Math.sin(t * 0.013 + 1.7));

/* ---------- hero: cactus listens to the pill ---------- */

const cactus = $('.hero-cactus .cactus');
const armL = $('.c-armL', cactus);
const armR = $('.c-armR', cactus);
const heroPill = makePill($('[data-hero-pill]'));
const heroBubble = $('[data-hero-bubble]');
const heroState = $('[data-hero-state]');

if (reduced) {
  cactus.classList.add('is-idle');
} else {
  cactus.classList.add('is-drawing');
  setTimeout(() => { cactus.classList.remove('is-drawing'); cactus.classList.add('is-idle'); }, 2500);
}

const heroLines = [
  'Remind me to review the installer pull request before lunch.',
  'Reply to Priya: thanks for the notes, revised copy by Thursday.',
  'Write a commit message that says separate failed replay requests.',
];

const heroLoop = (() => {
  let line = 0;
  let start = performance.now() + 2600;
  return (now) => {
    const words = heroLines[line].split(' ');
    const t = now - start;
    const talkStart = 1300;
    const talkEnd = talkStart + 600 + words.length * 190;
    const end = talkEnd + 2000;
    if (t > end) { line = (line + 1) % heroLines.length; start = now; }
    const talking = t > talkStart && t < talkEnd;
    const level = talking ? voice(now) : 0;
    heroPill.render(now, level);
    armL.style.transform = `rotate(${level * 16}deg)`;
    armR.style.transform = `rotate(${level * -16}deg)`;
    const shown = clamp(Math.floor((t - talkStart - 600) / 190) + 1, 0, words.length);
    heroBubble.textContent = t > talkStart + 600 ? words.slice(0, shown).join(' ') : '';
    heroBubble.classList.toggle('is-on', t > talkStart + 600 && t < end - 500);
    heroState.textContent = talking ? 'listening' : t > talkEnd && t < end - 500 ? 'pasted' : 'ready';
  };
})();

// Reduced motion: one still frame of the pill mid-transcript instead of the loop.
if (reduced) {
  heroPill.render(0, 0.7);
  heroBubble.textContent = heroLines[0];
  heroBubble.classList.add('is-on');
  heroState.textContent = 'listening';
}

/* ---------- story: ready → listening → transcript → pasted ---------- */

const storyPill = makePill($('[data-story-pill]'));
const storyBubble = $('[data-story-bubble]');
const storyTyped = $('[data-story-typed]');
const storySteps = $$('.story-steps li');
const storyBig = $('[data-story-big]');
const storyWords = 'Draft a short update for the team: long dictation is merged, and chunked processing keeps memory flat.'.split(' ');

function renderStory(p, now) {
  const step = p < 0.18 ? 0 : p < 0.38 ? 1 : p < 0.76 ? 2 : 3;
  storySteps.forEach((li, i) => li.classList.toggle('is-on', i === step));
  storyBig.textContent = `0${step + 1}`;
  storyBig.style.transform = `translate3d(0, ${(0.5 - p) * 30}vh, 0)`;
  storyPill.render(now, step === 1 || step === 2 ? voice(now) : 0);
  const shown = Math.ceil(range(p, 0.4, 0.72) * storyWords.length);
  storyBubble.textContent = storyWords.slice(0, shown).join(' ');
  storyBubble.classList.toggle('is-on', step === 2 && shown > 0);
  storyTyped.textContent = step === 3 ? storyWords.join(' ') : '';
  const away = range(p, 0.8, 0.95);
  storyPill.el.style.transform = `translateY(${away * 40}px)`;
  storyPill.el.style.opacity = String(1 - away * 0.7);
}

/* ---------- fan: windows rise out of a stack ---------- */

const wins = $$('.win');
const fanBack = $('.fan-back');
const poses = {
  left: { x: -1, y: 34, ry: 16, rz: -3, s: 0.96, z: -120 },
  center: { x: 0, y: -14, ry: 0, rz: 0, s: 1.06, z: 40 },
  right: { x: 1, y: 34, ry: -16, rz: 3, s: 0.96, z: -120 },
};

function renderFan(p) {
  const e = easeInOut(range(p, 0.02, 0.62));
  const spread = Math.min(innerWidth * 0.26, 400);
  wins.forEach((win, i) => {
    const pose = poses[win.dataset.win];
    const x = lerp(0, pose.x * spread, e);
    const y = lerp(innerHeight * 0.22 + i * 14, pose.y, e);
    const rx = lerp(55, 0, e);
    const rz = lerp((i - 1) * 4, pose.rz, e);
    win.style.transform = `translate3d(${x}px, ${y}px, ${lerp(-200, pose.z, e)}px) rotateX(${rx}deg) rotateY(${pose.ry * e}deg) rotateZ(${rz}deg) scale(${lerp(0.82, pose.s, e)})`;
    win.style.setProperty('--cap', String(range(p, 0.62, 0.82)));
  });
  fanBack.style.transform = `translate3d(${10 - p * 80}vw, -50%, 0)`;
}

/* ---------- adds up: the activity grid fills in ---------- */

const heat = $('[data-heat]');
const cells = [];
{
  let s = 20261028;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const frag = document.createDocumentFragment();
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 53; col++) {
      const i = document.createElement('i');
      const r = rand();
      i.dataset.l = r < 0.3 ? '1' : r < 0.6 ? '2' : r < 0.85 ? '3' : '4';
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
    el.textContent = Math.round(Number(el.dataset.count) * k).toLocaleString('en-US') + (el.dataset.suffix || '');
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

/* ---------- tone: privacy turns the page to the app's light theme ---------- */

const themeMeta = $('meta[name="theme-color"]');
const lit = new Set();
const toneObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) lit.add(entry.target); else lit.delete(entry.target);
  }
  if (lit.size) root.dataset.tone = 'light'; else delete root.dataset.tone;
  themeMeta.content = lit.size ? '#f4f4f2' : '#0b0b0b';
}, { rootMargin: '-49% 0px -50% 0px' });
$$('[data-tone="light"]').forEach((el) => toneObserver.observe(el));

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
  dots: $('.dots-bg'),
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
    wins.forEach((win) => { win.style.transform = ''; });
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

let staticAdds = reduced ? 1 : 0;
let staticAddsStart = 0;
if (!reduced) {
  new IntersectionObserver((entries, obs) => {
    if (entries[0].isIntersecting && isStatic) { staticAddsStart = performance.now(); obs.disconnect(); }
  }, { threshold: 0.3 }).observe(heat);
}

function frame(now) {
  smoothY = reduced ? scrollY : lerp(smoothY, scrollY, 0.12);
  if (Math.abs(smoothY - scrollY) < 0.1) smoothY = scrollY;
  pointer.x = lerp(pointer.x, pointer.tx, 0.06);
  pointer.y = lerp(pointer.y, pointer.ty, 0.06);

  if (!reduced && (isStatic || near(hero, smoothY))) heroLoop(now);

  if (isStatic) {
    // Reduced motion holds one readable frame; narrow screens auto-play the story.
    if (reduced) renderStory(0.72, 0);
    else renderStory(((now / 11000) % 1) * 0.98, now);
    if (staticAddsStart) staticAdds = range(now - staticAddsStart, 0, 2400);
    renderAdds(staticAdds);
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
      heroParts.dots.style.transform = `scale(${1 + hp * 0.35})`;
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
    if (!visible) { running = false; return; }
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
    new ResizeObserver(() => { layout(); draw(); }).observe(canvas);
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible && !running && !reduced) { running = true; last = 0; requestAnimationFrame(tick); }
    }).observe(canvas);
  }

  new IntersectionObserver((entries, obs) => {
    if (!entries[0].isIntersecting) return;
    obs.disconnect();
    sheet.onload = start;
    sheet.src = 'assets/peeps/open-peeps-sheet.png';
  }, { rootMargin: '800px 0px' }).observe(canvas);
})();
