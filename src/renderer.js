import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SHORELINE_Y,
  PHYSICS,
} from './constants.js';

const TWO_PI = Math.PI * 2;

// Unified golden-afternoon directional sunlight vector (from upper-left ~35° elevation)
const SUN_X = -0.72;
const SUN_Y = -0.69;
const SHAD_X = -SUN_X;
const SHAD_Y = -SUN_Y;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Deterministic hash helpers (zero allocations, consistent textures across frames)
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function tileableValueNoise(x, y, periodX, periodY, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  const x0 = ((xi % periodX) + periodX) % periodX;
  const x1 = (x0 + 1) % periodX;
  const y0 = ((yi % periodY) + periodY) % periodY;
  const y1 = (y0 + 1) % periodY;

  const n00 = hash2(x0 + seed * 17.3, y0 + seed * 31.7);
  const n10 = hash2(x1 + seed * 17.3, y0 + seed * 31.7);
  const n01 = hash2(x0 + seed * 17.3, y1 + seed * 31.7);
  const n11 = hash2(x1 + seed * 17.3, y1 + seed * 31.7);

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

function createOffscreenCanvas(width, height) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  return null;
}

function safeRoundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rad = typeof r === 'number' ? r : (Array.isArray(r) ? r[0] || 0 : 0);
  const rr = Math.min(rad, w * 0.5, h * 0.5);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ==================== PROCEDURAL PHOTOREALISTIC TEXTURE GENERATORS ====================

/**
 * Build a seamless normal-lit ocean wave surface tile using multi-octave directional waves.
 * Upper-left sunlit wave slopes catch warm sky/sun sheen; lower-right troughs deepen to marine slate.
 */
function buildOceanWaveTile(size, mode) {
  const tile = createOffscreenCanvas(size, size);
  if (!tile) return null;
  const ctx = tile.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return null;

  const img = ctx.createImageData(size, size);
  const data = img.data;
  const heights = new Float32Array(size * size);

  const isSwell = mode === 'swell';
  const waves = isSwell
    ? [
        { kx: 1, ky: 3, amp: 0.22, ph: 0.4 },
        { kx: -2, ky: 2, amp: 0.19, ph: 1.9 },
        { kx: 3, ky: -1, amp: 0.14, ph: 3.7 },
        { kx: -1, ky: 5, amp: 0.12, ph: 5.1 },
        { kx: 4, ky: 3, amp: 0.09, ph: 2.6 },
      ]
    : [
        { kx: 5, ky: 7, amp: 0.18, ph: 0.8 },
        { kx: -6, ky: 8, amp: 0.16, ph: 2.3 },
        { kx: 8, ky: -5, amp: 0.14, ph: 4.1 },
        { kx: 3, ky: 11, amp: 0.12, ph: 1.2 },
        { kx: -9, ky: -4, amp: 0.10, ph: 3.3 },
      ];

  for (let y = 0; y < size; y++) {
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      // Domain warp coordinates gently using tileable low-frequency noise so waves curve organically!
      const warpX = (tileableValueNoise(nx * 4, ny * 4, 4, 4, isSwell ? 13 : 29) - 0.5) * 0.11;
      const warpY = (tileableValueNoise(nx * 4, ny * 4, 4, 4, isSwell ? 19 : 37) - 0.5) * 0.11;
      const wx = nx + warpX;
      const wy = ny + warpY;

      let h = 0;
      for (let w = 0; w < waves.length; w++) {
        const wv = waves[w];
        const arg = TWO_PI * (wv.kx * wx + wv.ky * wy) + wv.ph;
        const s = Math.sin(arg);
        h += (s + 0.18 * Math.sin(arg * 2 - 0.5)) * wv.amp;
      }
      // Rich multi-octave organic ocean chop fBm
      const f1 = tileableValueNoise(nx * (isSwell ? 6 : 14), ny * (isSwell ? 6 : 14), isSwell ? 6 : 14, isSwell ? 6 : 14, isSwell ? 2 : 7);
      const f2 = tileableValueNoise(nx * (isSwell ? 12 : 28), ny * (isSwell ? 12 : 28), isSwell ? 12 : 28, isSwell ? 12 : 28, isSwell ? 5 : 11);
      const f3 = tileableValueNoise(nx * (isSwell ? 24 : 48), ny * (isSwell ? 24 : 48), isSwell ? 24 : 48, isSwell ? 24 : 48, isSwell ? 9 : 17);
      h += (f1 - 0.5) * 0.92 + (f2 - 0.5) * 0.52 + (f3 - 0.5) * 0.24;
      heights[y * size + x] = h;
    }
  }

  // Compute finite-difference surface normals & shade against golden-afternoon upper-left sun
  const slopeScale = isSwell ? 2.1 : 2.8;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;

      const dhdx = (heights[y * size + xp] - heights[y * size + xm]) * slopeScale;
      const dhdy = (heights[yp * size + x] - heights[ym * size + x]) * slopeScale;

      // Normal vector N = normalize(-dhdx, -dhdy, 1)
      const invLen = 1 / Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
      const nx = -dhdx * invLen;
      const ny = -dhdy * invLen;
      const nz = invLen;

      // Directional light dot product with upper-left afternoon sun
      const ndotl = nx * SUN_X * 0.8 + ny * SUN_Y * 0.8 + nz * 0.6;
      const diff = ndotl - 0.6;
      const spec = Math.pow(clamp(ndotl, 0, 1), isSwell ? 15 : 22);

      const idx = (y * size + x) * 4;
      if (diff >= 0) {
        const lift = clamp(diff * 2.1, 0, 1);
        const sBoost = spec * (isSwell ? 0.5 : 0.68);
        data[idx] = Math.round(lerp(135, 255, clamp(lift * 0.5 + sBoost, 0, 1)));
        data[idx + 1] = Math.round(lerp(195, 250, clamp(lift * 0.6 + sBoost, 0, 1)));
        data[idx + 2] = Math.round(lerp(215, 232, clamp(sBoost, 0, 1)));
        data[idx + 3] = Math.round(clamp((lift * (isSwell ? 54 : 42)) + sBoost * 85, 0, 115));
      } else {
        const shade = clamp(-diff * 2.2, 0, 1);
        data[idx] = 3;
        data[idx + 1] = 15;
        data[idx + 2] = 27;
        data[idx + 3] = Math.round(clamp(shade * (isSwell ? 68 : 44), 0, 92));
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return tile;
}

/**
 * Seamless shallow-water sunlit caustics web (soft natural refraction lines for sandy shallows).
 */
function buildCausticsTile() {
  const size = 256;
  const tile = createOffscreenCanvas(size, size);
  if (!tile) return null;
  const ctx = tile.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return null;

  const cellCount = 24;
  const pts = [];
  for (let i = 0; i < cellCount; i++) {
    pts.push({
      x: hash2(i, 2.13) * size,
      y: hash2(i, 9.47) * size,
    });
  }

  const img = ctx.createImageData(size, size);
  const data = img.data;
  const half = size * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d1 = 1e9;
      let d2 = 1e9;
      for (let i = 0; i < cellCount; i++) {
        let dx = x - pts[i].x;
        let dy = y - pts[i].y;
        if (dx > half) dx -= size;
        else if (dx < -half) dx += size;
        if (dy > half) dy -= size;
        else if (dy < -half) dy += size;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const edge = d2 - d1;
      const intensity = clamp(1 - edge / 10.5, 0, 1);
      const ridge = intensity * intensity * intensity;
      const idx = (y * size + x) * 4;
      data[idx] = 215;
      data[idx + 1] = 248;
      data[idx + 2] = 242;
      data[idx + 3] = Math.round(ridge * 165);
    }
  }
  ctx.putImageData(img, 0, 0);
  return tile;
}

/**
 * Soft radial misty spray puff sprite — replaces opaque solid dots with photorealistic water mist!
 */
function buildMistSprite() {
  const size = 32;
  const c = createOffscreenCanvas(size, size);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const half = size * 0.5;
  const g = ctx.createRadialGradient(half, half, 0.5, half, half, half);
  g.addColorStop(0.0, 'rgba(255, 255, 255, 0.92)');
  g.addColorStop(0.28, 'rgba(235, 249, 252, 0.58)');
  g.addColorStop(0.62, 'rgba(200, 236, 244, 0.22)');
  g.addColorStop(1.0, 'rgba(180, 228, 240, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/**
 * Fine speckled organic grain tile for realistic sand beaches, seabed, and coastal soil.
 */
function buildSandGrainTile() {
  const size = 128;
  const c = createOffscreenCanvas(size, size);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return null;

  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = hash2(x * 1.13, y * 1.71);
      const idx = (y * size + x) * 4;
      if (n > 0.58) {
        data[idx] = 250;
        data[idx + 1] = 242;
        data[idx + 2] = 222;
        data[idx + 3] = Math.round((n - 0.58) * 95);
      } else if (n < 0.38) {
        data[idx] = 74;
        data[idx + 1] = 62;
        data[idx + 2] = 44;
        data[idx + 3] = Math.round((0.38 - n) * 85);
      } else {
        data[idx + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ==================== POLYGON & AERIAL TERRAIN HELPERS ====================

function getWorldPolygon(obj, fallbackPoints = 14) {
  const raw = obj.polygon || obj.points;
  if (Array.isArray(raw) && raw.length >= 3) {
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < raw.length; i++) {
      sumX += raw[i].x;
      sumY += raw[i].y;
    }
    const cx = sumX / raw.length;
    const cy = sumY / raw.length;
    const distToObj = Math.hypot(cx - obj.x, cy - obj.y);
    const distToOrigin = Math.hypot(cx, cy);
    const isRelative = distToOrigin < distToObj && distToObj > (obj.radius || 30) * 0.6;
    if (!isRelative) return raw;
    return raw.map((p) => ({ x: obj.x + p.x, y: obj.y + p.y }));
  }

  const r = obj.radius || 40;
  const rx = obj.rx || r;
  const ry = obj.ry || r * 0.88;
  const pts = [];
  for (let i = 0; i < fallbackPoints; i++) {
    const a = (i / fallbackPoints) * TWO_PI;
    const wobble = 0.86 + 0.24 * hash2(i + obj.x * 0.01, obj.y * 0.01);
    pts.push({
      x: obj.x + Math.cos(a) * rx * wobble,
      y: obj.y + Math.sin(a) * ry * wobble,
    });
  }
  return pts;
}

function traceSmoothPolygon(ctx, pts, scaleFromCenter = 1, cx = 0, cy = 0) {
  const n = pts.length;
  if (n < 3) return;
  const getPt = (i) => {
    const p = pts[(i + n) % n];
    if (scaleFromCenter === 1) return p;
    return {
      x: cx + (p.x - cx) * scaleFromCenter,
      y: cy + (p.y - cy) * scaleFromCenter,
    };
  };

  const pLast = getPt(n - 1);
  const p0 = getPt(0);
  ctx.beginPath();
  ctx.moveTo((pLast.x + p0.x) * 0.5, (pLast.y + p0.y) * 0.5);
  for (let i = 0; i < n; i++) {
    const curr = getPt(i);
    const next = getPt(i + 1);
    ctx.quadraticCurveTo(curr.x, curr.y, (curr.x + next.x) * 0.5, (curr.y + next.y) * 0.5);
  }
  ctx.closePath();
}

function traceScaledPolygonOffset(ctx, pts, scale, cx, cy, ox, oy) {
  const n = pts.length;
  if (n < 3) return;
  const getPt = (i) => {
    const p = pts[(i + n) % n];
    return {
      x: cx + (p.x - cx) * scale + ox,
      y: cy + (p.y - cy) * scale + oy,
    };
  };
  const pLast = getPt(n - 1);
  const p0 = getPt(0);
  ctx.beginPath();
  ctx.moveTo((pLast.x + p0.x) * 0.5, (pLast.y + p0.y) * 0.5);
  for (let i = 0; i < n; i++) {
    const curr = getPt(i);
    const next = getPt(i + 1);
    ctx.quadraticCurveTo(curr.x, curr.y, (curr.x + next.x) * 0.5, (curr.y + next.y) * 0.5);
  }
  ctx.closePath();
}

function getPolygonCentroid(pts, fallbackX, fallbackY) {
  if (!pts || pts.length === 0) return { x: fallbackX, y: fallbackY };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < pts.length; i++) {
    sx += pts[i].x;
    sy += pts[i].y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

/**
 * Draw photorealistic aerial coastal tree canopies (multi-tuft pine/cypress & windswept palms)
 * with realistic SE ground shadows and warm NW golden-afternoon crown highlights.
 */
function drawAerialTree(ctx, x, y, radius, type, seed) {
  const r = clamp(radius || 11, 5.5, 20);
  ctx.save();

  // Soft directional cast ground shadow toward SE (+SHAD_X, +SHAD_Y)
  const shadOffX = SHAD_X * r * 0.62;
  const shadOffY = SHAD_Y * r * 0.62;
  const sg = ctx.createRadialGradient(
    x + shadOffX,
    y + shadOffY,
    r * 0.15,
    x + shadOffX,
    y + shadOffY,
    r * 1.18
  );
  sg.addColorStop(0, 'rgba(9, 20, 14, 0.44)');
  sg.addColorStop(0.7, 'rgba(9, 20, 14, 0.22)');
  sg.addColorStop(1, 'rgba(9, 20, 14, 0)');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(x + shadOffX, y + shadOffY, r * 1.18, 0, TWO_PI);
  ctx.fill();

  if (type === 'palm') {
    // Subtle dark shaded palm understory
    ctx.fillStyle = 'rgba(18, 36, 22, 0.55)';
    ctx.beginPath();
    ctx.arc(x + SHAD_X * 1.6, y + SHAD_Y * 1.6, r * 0.45, 0, TWO_PI);
    ctx.fill();

    // 9 textured tapering coastal palm fronds with sun-angle lighting
    const fronds = 9;
    const baseAngle = seed * TWO_PI;
    for (let i = 0; i < fronds; i++) {
      const a = baseAngle + (i / fronds) * TWO_PI + (hash2(i, seed) - 0.5) * 0.25;
      const len = r * (0.85 + hash2(seed, i + 2) * 0.42);
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const sunFacing = cosA * SUN_X + sinA * SUN_Y;

      const ex = x + cosA * len;
      const ey = y + sinA * len;
      const midX = x + cosA * len * 0.52;
      const midY = y + sinA * len * 0.52;
      const px = -sinA * r * 0.22;
      const py = cosA * r * 0.22;

      ctx.fillStyle = sunFacing > 0.15 ? '#5b7847' : (sunFacing > -0.25 ? '#3d5a35' : '#243a24');
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(midX + px, midY + py, ex, ey);
      ctx.quadraticCurveTo(midX - px, midY - py, x, y);
      ctx.fill();

      // Delicate sunlit central rachis spine
      if (sunFacing > -0.1) {
        ctx.strokeStyle = 'rgba(148, 174, 108, 0.42)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(ex * 0.92 + x * 0.08, ey * 0.92 + y * 0.08);
        ctx.stroke();
      }
    }
    // Warm sunlit crown center
    ctx.fillStyle = '#738e56';
    ctx.beginPath();
    ctx.arc(x + SUN_X * r * 0.08, y + SUN_Y * r * 0.08, r * 0.18, 0, TWO_PI);
    ctx.fill();
  } else {
    // Realistic multi-tuft maritime pine / cypress canopy (never a plain circle!)
    const tufts = 18;
    // Pass 1: Deep shadowed outer lower-right foliage clusters
    for (let i = 0; i < tufts; i++) {
      const a = (i / tufts) * TWO_PI + hash2(i, seed) * 0.45;
      const dist = r * (0.28 + hash2(seed, i + 7) * 0.54);
      const tx = x + Math.cos(a) * dist;
      const ty = y + Math.sin(a) * dist;
      const tr = r * (0.24 + hash2(i + 3, seed) * 0.18);
      const sunDot = Math.cos(a) * SUN_X + Math.sin(a) * SUN_Y;

      if (sunDot < -0.15) ctx.fillStyle = '#172d20';
      else if (sunDot < 0.28) ctx.fillStyle = '#25422e';
      else ctx.fillStyle = '#36583b';

      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, TWO_PI);
      ctx.fill();
    }

    // Pass 2: Mid-height textured olive-pine tufts
    const midTufts = 11;
    for (let i = 0; i < midTufts; i++) {
      const a = (i / midTufts) * TWO_PI + hash2(seed + 4, i) * 0.6;
      const dist = r * (0.1 + hash2(i + 11, seed) * 0.38);
      const tx = x + SUN_X * r * 0.12 + Math.cos(a) * dist;
      const ty = y + SUN_Y * r * 0.12 + Math.sin(a) * dist;
      const tr = r * (0.2 + hash2(i + 17, seed) * 0.14);
      const sunDot = Math.cos(a) * SUN_X + Math.sin(a) * SUN_Y;

      ctx.fillStyle = sunDot > 0.1 ? '#4a6b44' : '#2d4c35';
      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, TWO_PI);
      ctx.fill();
    }

    // Pass 3: Warm golden-afternoon sunlit crown needle clusters on NW face
    const hiTufts = 5;
    for (let i = 0; i < hiTufts; i++) {
      const tx = x + SUN_X * r * (0.22 + hash2(i, seed + 2) * 0.22) + (hash2(seed, i + 21) - 0.5) * r * 0.3;
      const ty = y + SUN_Y * r * (0.22 + hash2(i + 1, seed + 3) * 0.22) + (hash2(seed, i + 29) - 0.5) * r * 0.3;
      const tr = r * (0.13 + hash2(i + 5, seed) * 0.09);
      ctx.fillStyle = 'rgba(128, 152, 92, 0.72)';
      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, TWO_PI);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ==================== MAIN RENDERER FACTORY ====================

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });

  // Viewport transform state
  let dpr = 1;
  let viewW = WORLD_WIDTH;
  let viewH = WORLD_HEIGHT;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  // One-time pre-generated photorealistic procedural tiles
  const swellTile = buildOceanWaveTile(256, 'swell');
  const rippleTile = buildOceanWaveTile(256, 'ripple');
  const causticsTile = buildCausticsTile();
  const mistSprite = buildMistSprite();
  const sandGrainTile = buildSandGrainTile();

  let swellPattern = null;
  let ripplePattern = null;
  let causticsPattern = null;
  let sandGrainPattern = null;

  if (ctx && typeof ctx.createPattern === 'function') {
    if (swellTile) swellPattern = ctx.createPattern(swellTile, 'repeat');
    if (rippleTile) ripplePattern = ctx.createPattern(rippleTile, 'repeat');
    if (causticsTile) causticsPattern = ctx.createPattern(causticsTile, 'repeat');
    if (sandGrainTile) sandGrainPattern = ctx.createPattern(sandGrainTile, 'repeat');
  }

  // Per-course offscreen static terrain caches
  let cachedCourseRef = null;
  let cachedCourseKey = null;
  let shoalCanvas = null;
  let islandsCanvas = null;
  let pierDeckCanvas = null;
  let cachedIslandPolys = [];
  let cachedRockPolys = [];
  let cachedLighthouses = [];
  let cachedPier = null;

  // Sun-path glitter anchors (organic golden-afternoon shimmer concentrated along NW -> center sun path)
  const sunGlints = [];
  for (let i = 0; i < 115; i++) {
    // Bias distribution gently toward sunlit upper-left/mid-bay corridor
    const rx = Math.pow(hash2(i, 101.3), 1.25) * (WORLD_WIDTH + 240) - 120;
    const ry = Math.pow(hash2(i, 113.7), 1.15) * (SHORELINE_Y - 30);
    sunGlints.push({
      x: rx,
      y: ry,
      phase: hash2(i, 127.1) * TWO_PI,
      speed: 2.1 + hash2(i, 139.5) * 3.1,
      width: 4.5 + hash2(i, 149.9) * 9.5,
      angle: -0.18 + (hash2(i, 163.3) - 0.5) * 0.28,
      warmth: hash2(i, 173.7),
    });
  }

  // Subtle breaking wind-wave micro-whitecaps drifting across open bay
  const whitecaps = [];
  for (let i = 0; i < 32; i++) {
    whitecaps.push({
      x: hash2(i, 11.3) * (WORLD_WIDTH + 460) - 230,
      y: hash2(i, 23.7) * (SHORELINE_Y - 50),
      len: 16 + hash2(i, 37.1) * 28,
      speed: 13 + hash2(i, 53.2) * 14,
      phase: hash2(i, 67.4) * TWO_PI,
    });
  }

  // Soft diffused atmospheric cloud shadows drifting across the bay
  const clouds = [
    { x: 240, y: 230, rx: 230, ry: 115, vx: 11.5, vy: 2.1, alpha: 0.068 },
    { x: 1090, y: 495, rx: 275, ry: 125, vx: 9.2, vy: 1.5, alpha: 0.06 },
    { x: 1650, y: 165, rx: 200, ry: 96, vx: 13.0, vy: 2.4, alpha: 0.052 },
  ];

  // Delicate high-altitude coastal gulls
  const seagulls = [
    { cx: 440, cy: 250, rx: 225, ry: 115, speed: 0.21, phase: 0.3, wingPhase: 0, scale: 0.92 },
    { cx: 1160, cy: 315, rx: 265, ry: 135, speed: -0.17, phase: 2.2, wingPhase: 1.9, scale: 0.82 },
    { cx: 810, cy: 585, rx: 300, ry: 125, speed: 0.14, phase: 4.4, wingPhase: 3.6, scale: 0.88 },
  ];

  // Internal particle pools
  const particles = [];
  const ripples = [];
  const confetti = [];
  const MAX_PARTICLES = 400;
  const MAX_RIPPLES = 80;
  const MAX_CONFETTI = 180;

  let screenFlash = { alpha: 0, color: '#38bdf8', decay: 2.4 };
  let goLightPulse = 0;
  let internalTime = 0;
  let prevBoatPhase = 'menu';
  const sprayAccum = new Map();

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : { width: window.innerWidth || WORLD_WIDTH, height: window.innerHeight || WORLD_HEIGHT };
    viewW = Math.max(1, rect.width || window.innerWidth || WORLD_WIDTH);
    viewH = Math.max(1, rect.height || window.innerHeight || WORLD_HEIGHT);

    const targetW = Math.round(viewW * dpr);
    const targetH = Math.round(viewH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    scale = Math.min(viewW / WORLD_WIDTH, viewH / WORLD_HEIGHT);
    offsetX = (viewW - WORLD_WIDTH * scale) * 0.5;
    offsetY = (viewH - WORLD_HEIGHT * scale) * 0.5;
  }

  function addRipple(x, y, maxRadius, color = 'rgba(218, 240, 246, 0.42)', duration = 0.95, lineWidth = 1.6) {
    if (ripples.length >= MAX_RIPPLES) {
      ripples.shift();
    }
    ripples.push({
      x,
      y,
      age: 0,
      duration,
      startRadius: 5,
      maxRadius,
      color,
      lineWidth,
    });
  }

  function spawnSplash(x, y, intensity = 1.0, color = '#f1f8fa') {
    const count = Math.min(30, Math.max(6, Math.round(12 * intensity)));
    for (let i = 0; i < count; i++) {
      if (particles.length >= MAX_PARTICLES) particles.shift();
      const angle = Math.random() * TWO_PI;
      const spd = (24 + Math.random() * 92) * (0.65 + intensity * 0.52);
      particles.push({
        x: x + (Math.random() - 0.5) * 7,
        y: y + (Math.random() - 0.5) * 7,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 4.5 + Math.random() * 6.5 * clamp(intensity, 0.6, 1.4),
        grow: 12 + Math.random() * 10,
        age: 0,
        life: 0.34 + Math.random() * 0.38,
        color,
        drag: 3.9,
        kind: 'splash',
        alphaScale: 0.62,
      });
    }
    addRipple(x, y, 28 + intensity * 28, 'rgba(224, 244, 248, 0.52)', 0.8 + intensity * 0.25, 1.8);
    addRipple(x, y, 16 + intensity * 16, 'rgba(240, 250, 252, 0.38)', 0.55 + intensity * 0.15, 1.2);
  }

  function spawnConfettiBurst(originX = WORLD_WIDTH * 0.5, originY = WORLD_HEIGHT * 0.45, count = 80) {
    // Refined champagne/coastal regatta celebration palette
    const palette = ['#e6b85c', '#f8fafc', '#38bdf8', '#e1523d', '#22b8cf', '#d4af37', '#94a3b8'];
    for (let i = 0; i < count; i++) {
      if (confetti.length >= MAX_CONFETTI) confetti.shift();
      const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * 2.1;
      const spd = 120 + Math.random() * 270;
      confetti.push({
        x: originX + (Math.random() - 0.5) * 240,
        y: originY + (Math.random() - 0.5) * 120,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 55,
        w: 4.5 + Math.random() * 5,
        h: 2.5 + Math.random() * 3.5,
        rot: Math.random() * TWO_PI,
        rotVel: (Math.random() - 0.5) * 10,
        tilt: Math.random() * TWO_PI,
        tiltVel: 4 + Math.random() * 6.5,
        color: palette[i % palette.length],
        age: 0,
        life: 2.6 + Math.random() * 1.8,
      });
    }
  }

  function triggerEffect(event) {
    if (!event || !event.type) return;
    const x = typeof event.x === 'number' ? event.x : (event.boat ? event.boat.x : WORLD_WIDTH * 0.5);
    const y = typeof event.y === 'number' ? event.y : (event.boat ? event.boat.y : WORLD_HEIGHT * 0.5);

    switch (event.type) {
      case 'countdown_tick':
        goLightPulse = 0.7;
        break;
      case 'race_start':
        goLightPulse = 1.4;
        screenFlash = { alpha: 0.14, color: '#34d399', decay: 2.6 };
        addRipple(x, y, 95, 'rgba(130, 235, 200, 0.36)', 0.95, 2.0);
        break;
      case 'buoy_hit': {
        const bx = event.buoy ? event.buoy.x : x;
        const by = event.buoy ? event.buoy.y : y;
        spawnSplash(bx, by, 1.35, '#ffffff');
        addRipple(bx, by, 52, 'rgba(248, 113, 113, 0.58)', 0.85, 2.2);
        if (event.isPlayer || event.boat?.isPlayer) {
          screenFlash = { alpha: 0.13, color: '#ea580c', decay: 3.2 };
        }
        break;
      }
      case 'buoy_rounded': {
        if (event.isPlayer || event.boat?.isPlayer) {
          const bx = event.buoy ? event.buoy.x : x;
          const by = event.buoy ? event.buoy.y : y;
          addRipple(bx, by, 44, 'rgba(186, 236, 245, 0.55)', 0.65, 1.8);
        }
        break;
      }
      case 'missed_buoy':
        if (event.isPlayer || event.boat?.isPlayer) {
          addRipple(x, y, 54, 'rgba(245, 158, 11, 0.65)', 0.9, 2.4);
        }
        break;
      case 'jump_start':
      case 'course_cut':
      case 'course_cut_penalty':
        if (event.isPlayer || event.boat?.isPlayer) {
          screenFlash = { alpha: 0.14, color: '#dc2626', decay: 2.8 };
          addRipple(x, y, 56, 'rgba(239, 68, 68, 0.58)', 0.8, 2.2);
        }
        break;
      case 'lap_complete':
      case 'final_lap':
        if (event.isPlayer || event.boat?.isPlayer) {
          screenFlash = {
            alpha: event.type === 'final_lap' ? 0.16 : 0.11,
            color: event.type === 'final_lap' ? '#e5b95c' : '#38bdf8',
            decay: 2.2,
          };
          addRipple(x, y, 78, 'rgba(240, 214, 140, 0.55)', 0.9, 2.2);
        }
        break;
      case 'race_finish':
      case 'player_finish':
      case 'victory': {
        const rank = event.playerStanding?.rank ?? event.rank ?? event.position ?? 1;
        if (rank <= 3) {
          spawnConfettiBurst(x, y, rank === 1 ? 105 : 55);
          spawnConfettiBurst(WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.35, rank === 1 ? 55 : 25);
          screenFlash = { alpha: 0.16, color: '#e5b95c', decay: 1.6 };
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Pre-render detailed weathered teak/cedar wooden pier deck with realistic grain & fasteners.
   */
  function buildPierDeckCache(pier) {
    const pw = Math.ceil(pier.width);
    const ph = Math.ceil(Math.max(pier.height + 60, 150));
    const c = createOffscreenCanvas(pw, ph);
    if (!c) return null;
    const pctx = c.getContext('2d');
    if (!pctx) return null;

    // Dark substructure shadow between board seams
    pctx.fillStyle = '#2d2118';
    pctx.beginPath();
    safeRoundRect(pctx, 0, 0, pw, ph, [4, 4, 0, 0]);
    pctx.fill();

    // Weathered cedar/teak horizontal decking planks with authentic grain streaks
    const plankH = 8.5;
    const plankCount = Math.ceil(ph / plankH);
    for (let i = 0; i < plankCount; i++) {
      const y0 = 3 + i * plankH;
      const v = hash2(i, 42.7);
      const v2 = hash2(i + 13, 19.3);
      // Sun-bleached weathered cedar/teak palette (natural silvery-brown tones)
      const r = Math.round(112 + v * 28 + v2 * 10);
      const g = Math.round(92 + v * 24 + v2 * 9);
      const b = Math.round(73 + v * 19 + v2 * 8);

      const boardGrad = pctx.createLinearGradient(0, y0, pw, y0);
      boardGrad.addColorStop(0, `rgb(${r + 8}, ${g + 7}, ${b + 5})`);
      boardGrad.addColorStop(0.5, `rgb(${r}, ${g}, ${b})`);
      boardGrad.addColorStop(1, `rgb(${r - 10}, ${g - 9}, ${b - 8})`);
      pctx.fillStyle = boardGrad;
      pctx.fillRect(4, y0, pw - 8, plankH - 1.3);

      // Fine horizontal wood-grain fibers along each board
      for (let gLine = 0; gLine < 3; gLine++) {
        const gy = y0 + 1.4 + gLine * 2.1 + (hash2(i, gLine + 3) - 0.5) * 0.8;
        const darkGrain = hash2(i + gLine, 71.1) > 0.42;
        pctx.strokeStyle = darkGrain ? 'rgba(42, 30, 20, 0.16)' : 'rgba(218, 202, 180, 0.12)';
        pctx.lineWidth = 0.7;
        pctx.beginPath();
        pctx.moveTo(4, gy);
        pctx.bezierCurveTo(
          pw * 0.33,
          gy + (hash2(i, gLine + 11) - 0.5) * 1.3,
          pw * 0.66,
          gy + (hash2(i, gLine + 19) - 0.5) * 1.3,
          pw - 4,
          gy
        );
        pctx.stroke();
      }

      // Subtle sun-bleached top bevel catching upper-left light
      pctx.fillStyle = 'rgba(235, 224, 206, 0.16)';
      pctx.fillRect(4, y0, pw - 8, 1.0);

      // Subtle recessed stainless nail/bolt dots over stringers
      pctx.fillStyle = 'rgba(30, 24, 18, 0.58)';
      pctx.beginPath();
      pctx.arc(13, y0 + 3.4, 0.85, 0, TWO_PI);
      pctx.arc(pw - 13, y0 + 3.4, 0.85, 0, TWO_PI);
      pctx.fill();
    }

    // Heavy weathered edge curb stringers (NW sunlit left edge, SE shadowed right edge)
    const leftEdge = pctx.createLinearGradient(0, 0, 6, 0);
    leftEdge.addColorStop(0, '#968068');
    leftEdge.addColorStop(1, '#614f3e');
    pctx.fillStyle = leftEdge;
    pctx.fillRect(0, 0, 5.5, ph);

    const rightEdge = pctx.createLinearGradient(pw - 6, 0, pw, 0);
    rightEdge.addColorStop(0, '#685544');
    rightEdge.addColorStop(1, '#3f3227');
    pctx.fillStyle = rightEdge;
    pctx.fillRect(pw - 5.5, 0, 5.5, ph);

    // Front bullnose timber cap
    const frontCap = pctx.createLinearGradient(0, 0, 0, 5);
    frontCap.addColorStop(0, '#a69178');
    frontCap.addColorStop(1, '#584737');
    pctx.fillStyle = frontCap;
    pctx.fillRect(0, 0, pw, 4.5);

    return c;
  }

  /**
   * Pre-render photorealistic shoal sandbars, islands, coastal rock formations & aerial tree canopies
   * onto offscreen caches whenever a new course is generated.
   */
  function rebuildCourseCache(course) {
    cachedCourseRef = course;
    cachedCourseKey = course ? (course.seed ?? course.name ?? 'course') : null;
    cachedIslandPolys = [];
    cachedRockPolys = [];
    cachedLighthouses = [];
    cachedPier = null;
    pierDeckCanvas = null;

    if (!course) return;

    const scenery = course.scenery || {};
    const islands = scenery.islands || [];
    const rocks = scenery.rocks || [];

    const rawPier = scenery.pier;
    if (rawPier) {
      const pw = rawPier.width || 144;
      const ph = rawPier.height || 92;
      const py = rawPier.y ?? (SHORELINE_Y - 7);
      const px = typeof rawPier.x === 'number'
        ? (rawPier.centered ? rawPier.x - pw * 0.5 : rawPier.x)
        : (WORLD_WIDTH - pw) * 0.5;
      cachedPier = { x: px, y: py, width: pw, height: ph };
    } else {
      cachedPier = { x: WORLD_WIDTH * 0.5 - 76, y: SHORELINE_Y - 7, width: 152, height: 94 };
    }
    pierDeckCanvas = buildPierDeckCache(cachedPier);

    for (let i = 0; i < islands.length; i++) {
      const isl = islands[i];
      const pts = getWorldPolygon(isl, 15);
      const center = getPolygonCentroid(pts, isl.x, isl.y);
      cachedIslandPolys.push({ island: isl, pts, center });
      if (isl.hasLighthouse) {
        const lx = isl.lighthousePos?.x ?? isl.lighthouse?.x ?? isl.lighthouseX ?? center.x;
        const ly = isl.lighthousePos?.y ?? isl.lighthouse?.y ?? isl.lighthouseY ?? center.y;
        cachedLighthouses.push({
          x: lx,
          y: ly,
          phase: hash2(lx, ly) * TWO_PI,
        });
      }
    }

    for (let i = 0; i < rocks.length; i++) {
      const rk = rocks[i];
      const pts = getWorldPolygon(rk, 9);
      const center = getPolygonCentroid(pts, rk.x, rk.y);
      cachedRockPolys.push({ rock: rk, pts, center });
    }

    // 1) Pre-render coastal shoals & submerged turquoise sandbars around islands & rocks
    shoalCanvas = createOffscreenCanvas(WORLD_WIDTH, WORLD_HEIGHT);
    if (shoalCanvas) {
      const sctx = shoalCanvas.getContext('2d');
      if (sctx) {
        sctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

        for (let i = 0; i < cachedIslandPolys.length; i++) {
          const { pts, center } = cachedIslandPolys[i];
          // Feathered multi-stop translucent coastal shelf transition
          const rings = [
            { scale: 1.85, color: 'rgba(22, 108, 124, 0.13)' },
            { scale: 1.58, color: 'rgba(32, 134, 144, 0.20)' },
            { scale: 1.36, color: 'rgba(54, 158, 156, 0.28)' },
            { scale: 1.20, color: 'rgba(98, 178, 164, 0.34)' },
            { scale: 1.09, color: 'rgba(154, 192, 168, 0.42)' },
          ];
          for (let r = 0; r < rings.length; r++) {
            traceSmoothPolygon(sctx, pts, rings[r].scale, center.x, center.y);
            sctx.fillStyle = rings[r].color;
            sctx.fill();
          }
          // Subtle submerged sand grain texture in the immediate shallows
          if (sandGrainPattern) {
            sctx.save();
            traceSmoothPolygon(sctx, pts, 1.32, center.x, center.y);
            sctx.clip();
            sctx.globalAlpha = 0.22;
            sctx.fillStyle = sandGrainPattern;
            sctx.fillRect(center.x - 160, center.y - 160, 320, 320);
            sctx.restore();
          }
        }

        for (let i = 0; i < cachedRockPolys.length; i++) {
          const { pts, center } = cachedRockPolys[i];
          traceSmoothPolygon(sctx, pts, 2.05, center.x, center.y);
          sctx.fillStyle = 'rgba(30, 128, 138, 0.16)';
          sctx.fill();
          traceSmoothPolygon(sctx, pts, 1.48, center.x, center.y);
          sctx.fillStyle = 'rgba(66, 160, 158, 0.26)';
          sctx.fill();
        }
      }
    }

    // 2) Pre-render photorealistic aerial islands & basalt rocks
    islandsCanvas = createOffscreenCanvas(WORLD_WIDTH, WORLD_HEIGHT);
    if (islandsCanvas) {
      const ictx = islandsCanvas.getContext('2d');
      if (ictx) {
        ictx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

        for (let i = 0; i < cachedIslandPolys.length; i++) {
          const { island, pts, center } = cachedIslandPolys[i];
          const r = island.radius || 55;

          // Deep submerged bathymetric drop-off shadow on SE side
          traceScaledPolygonOffset(ictx, pts, 1.09, center.x, center.y, SHAD_X * 7, SHAD_Y * 7);
          ictx.fillStyle = 'rgba(4, 22, 34, 0.30)';
          ictx.fill();

          // Dark wet intertidal basalt / wet sand rim
          traceSmoothPolygon(ictx, pts, 1.03, center.x, center.y);
          ictx.fillStyle = '#5e584a';
          ictx.fill();

          // Wet darkened surf-zone sand band
          traceSmoothPolygon(ictx, pts, 0.99, center.x, center.y);
          ictx.fillStyle = '#998666';
          ictx.fill();

          // Warm dry coastal sand beach with directional sun lighting + micro-speckle texture
          ictx.save();
          traceSmoothPolygon(ictx, pts, 0.93, center.x, center.y);
          const sandGrad = ictx.createLinearGradient(
            center.x + SUN_X * r,
            center.y + SUN_Y * r,
            center.x + SHAD_X * r,
            center.y + SHAD_Y * r
          );
          sandGrad.addColorStop(0.0, '#dfd0ae');
          sandGrad.addColorStop(0.55, '#cbb892');
          sandGrad.addColorStop(1.0, '#a2906f');
          ictx.fillStyle = sandGrad;
          ictx.fill();
          if (sandGrainPattern) {
            ictx.clip();
            ictx.globalAlpha = 0.65;
            ictx.fillStyle = sandGrainPattern;
            ictx.fillRect(center.x - r * 1.4, center.y - r * 1.4, r * 2.8, r * 2.8);
          }
          ictx.restore();

          // Weathered coastal granite bluff shelf peeking out along SE slope
          traceScaledPolygonOffset(ictx, pts, 0.79, center.x, center.y, SHAD_X * 3.5, SHAD_Y * 3.5);
          const bluffGrad = ictx.createLinearGradient(
            center.x + SUN_X * r * 0.8,
            center.y + SUN_Y * r * 0.8,
            center.x + SHAD_X * r * 0.8,
            center.y + SHAD_Y * r * 0.8
          );
          bluffGrad.addColorStop(0, '#8d877a');
          bluffGrad.addColorStop(0.5, '#666259');
          bluffGrad.addColorStop(1, '#3d3e3b');
          ictx.fillStyle = bluffGrad;
          ictx.fill();

          // Shaded coastal scrub & dune grass elevation (lit sunward NW vs shadowed leeward SE)
          ictx.save();
          traceSmoothPolygon(ictx, pts, 0.72, center.x, center.y);
          const terrainGrad = ictx.createLinearGradient(
            center.x + SUN_X * r * 0.75,
            center.y + SUN_Y * r * 0.75,
            center.x + SHAD_X * r * 0.75,
            center.y + SHAD_Y * r * 0.75
          );
          terrainGrad.addColorStop(0.0, '#6a7f52'); // sunlit warm coastal sage/grass
          terrainGrad.addColorStop(0.45, '#465f3d'); // natural coastal meadow
          terrainGrad.addColorStop(0.82, '#2a422b'); // shaded slope
          terrainGrad.addColorStop(1.0, '#1b2d1f'); // deep leeward shadow
          ictx.fillStyle = terrainGrad;
          ictx.fill();

          if (sandGrainPattern) {
            ictx.clip();
            ictx.globalAlpha = 0.35;
            ictx.fillStyle = sandGrainPattern;
            ictx.fillRect(center.x - r, center.y - r, r * 2, r * 2);
          }
          ictx.restore();

          // Small exposed sunlit stone outcrops along the bluff edge
          const outcropCount = clamp(Math.floor(r / 18), 2, 4);
          for (let o = 0; o < outcropCount; o++) {
            const oa = hash2(i + 5, o + 1.3) * TWO_PI;
            const od = r * (0.58 + hash2(o, i + 7) * 0.16);
            const ox = center.x + Math.cos(oa) * od;
            const oy = center.y + Math.sin(oa) * od;
            const or = 3.5 + hash2(o + 2, i) * 4.5;
            ictx.fillStyle = 'rgba(20, 26, 22, 0.28)';
            ictx.beginPath();
            ictx.ellipse(ox + 1.8, oy + 1.8, or * 1.15, or * 0.75, oa, 0, TWO_PI);
            ictx.fill();
            ictx.fillStyle = '#7e7d75';
            ictx.beginPath();
            ictx.ellipse(ox, oy, or, or * 0.68, oa, 0, TWO_PI);
            ictx.fill();
            ictx.fillStyle = 'rgba(218, 212, 198, 0.35)';
            ictx.beginPath();
            ictx.ellipse(ox - or * 0.22, oy - or * 0.18, or * 0.45, or * 0.32, oa, 0, TWO_PI);
            ictx.fill();
          }

          // Multi-tuft photorealistic aerial foliage canopies
          const foliage = island.trees || island.foliage || [];
          const lx = island.lighthousePos?.x ?? island.lighthouse?.x ?? island.lighthouseX ?? center.x;
          const ly = island.lighthousePos?.y ?? island.lighthouse?.y ?? island.lighthouseY ?? center.y;

          if (foliage.length > 0) {
            for (let t = 0; t < foliage.length; t++) {
              const tree = foliage[t];
              const tx = Math.abs(tree.x) < r * 1.5 && Math.hypot(tree.x - center.x, tree.y - center.y) > r * 1.5
                ? center.x + tree.x
                : tree.x;
              const ty = Math.abs(tree.y) < r * 1.5 && Math.hypot(tree.x - center.x, tree.y - center.y) > r * 1.5
                ? center.y + tree.y
                : tree.y;
              if (island.hasLighthouse && Math.hypot(tx - lx, ty - ly) < 17) continue;
              const tr = tree.radius || tree.r || tree.size || 10.5;
              const treeType = tree.type || (hash2(t, i + 4.1) > 0.64 ? 'palm' : 'pine');
              drawAerialTree(ictx, tx, ty, tr, treeType, hash2(t + 1, i + 2));
            }
          } else {
            const autoCount = clamp(Math.floor(r / 11), 3, 9);
            for (let t = 0; t < autoCount; t++) {
              const a = (t / autoCount) * TWO_PI + hash2(i, t) * 0.5;
              const dist = r * (0.18 + hash2(t, i + 9) * 0.34);
              const tx = center.x + Math.cos(a) * dist;
              const ty = center.y + Math.sin(a) * dist;
              if (island.hasLighthouse && Math.hypot(tx - lx, ty - ly) < 18) continue;
              const tr = 8.5 + hash2(t + 3, i) * 6;
              drawAerialTree(ictx, tx, ty, tr, t % 3 === 0 ? 'palm' : 'pine', hash2(i, t + 5));
            }
          }
        }

        // Photorealistic coastal basalt rock formations (faceted stone + wet tidal collar)
        for (let i = 0; i < cachedRockPolys.length; i++) {
          const { rock, pts, center } = cachedRockPolys[i];
          const r = rock.radius || rock.r || 14;

          // Submerged drop-off shadow
          traceScaledPolygonOffset(ictx, pts, 1.18, center.x, center.y, SHAD_X * 4.5, SHAD_Y * 4.5);
          ictx.fillStyle = 'rgba(4, 22, 34, 0.36)';
          ictx.fill();

          // Dark wet basalt intertidal shelf
          traceSmoothPolygon(ictx, pts, 1.04, center.x, center.y);
          ictx.fillStyle = '#252f36';
          ictx.fill();

          // Weathered directional-lit coastal granite body
          traceSmoothPolygon(ictx, pts, 0.88, center.x, center.y);
          const rkGrad = ictx.createLinearGradient(
            center.x + SUN_X * r,
            center.y + SUN_Y * r,
            center.x + SHAD_X * r,
            center.y + SHAD_Y * r
          );
          rkGrad.addColorStop(0.0, '#a3a59f');
          rkGrad.addColorStop(0.45, '#686e70');
          rkGrad.addColorStop(1.0, '#303940');
          ictx.fillStyle = rkGrad;
          ictx.fill();

          // Dry sun-warmed stone crest ridge on NW facet
          traceScaledPolygonOffset(ictx, pts, 0.54, center.x, center.y, SUN_X * r * 0.16, SUN_Y * r * 0.16);
          ictx.fillStyle = 'rgba(218, 214, 202, 0.36)';
          ictx.fill();

          // Subtle crevice shadow line
          ictx.strokeStyle = 'rgba(18, 24, 30, 0.35)';
          ictx.lineWidth = 0.9;
          ictx.beginPath();
          ictx.moveTo(center.x - r * 0.35, center.y + r * 0.1);
          ictx.lineTo(center.x + r * 0.1, center.y - r * 0.15);
          ictx.lineTo(center.x + r * 0.38, center.y + r * 0.2);
          ictx.stroke();
        }
      }
    }
  }

  // ==================== PHOTOREALISTIC RENDERING LAYERS ====================

  function drawOceanBase(visMinX, visMinY, visMaxX, visMaxY, t) {
    const w = visMaxX - visMinX;
    const h = visMaxY - visMinY;

    // 1) Deep natural oceanic slate-navy -> coastal teal-blue -> translucent turquoise shallows
    const oceanGrad = ctx.createLinearGradient(0, Math.min(0, visMinY), 0, SHORELINE_Y + 25);
    oceanGrad.addColorStop(0.00, '#051524'); // deep offshore slate-navy
    oceanGrad.addColorStop(0.22, '#08263d'); // deep coastal blue
    oceanGrad.addColorStop(0.48, '#0d3c56'); // mid-bay marine blue
    oceanGrad.addColorStop(0.72, '#13566f'); // coastal teal-blue
    oceanGrad.addColorStop(0.88, '#1d7382'); // luminous coastal turquoise
    oceanGrad.addColorStop(0.96, '#2d8b8f'); // shallow sandy turquoise
    oceanGrad.addColorStop(1.00, '#5a9f94'); // sandy water's edge
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(visMinX, visMinY, w, h);

    // Subtle warm sunlit aerial glow over upper-left water (sun reflection direction)
    const skyReflect = ctx.createRadialGradient(
      WORLD_WIDTH * 0.18,
      -80,
      40,
      WORLD_WIDTH * 0.28,
      260,
      1150
    );
    skyReflect.addColorStop(0.0, 'rgba(195, 224, 238, 0.13)');
    skyReflect.addColorStop(0.45, 'rgba(130, 185, 205, 0.05)');
    skyReflect.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = skyReflect;
    ctx.fillRect(visMinX, visMinY, w, h);

    // 2) Pre-rendered translucent coastal shoal shelves around islands & rocks
    if (shoalCanvas) {
      ctx.drawImage(shoalCanvas, 0, 0);
    }

    // 3) Localized sunlit underwater caustics ONLY in shallow translucent coastal water
    if (causticsPattern) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Bottom foreground sandy shallows (y ≈ 810..SHORELINE_Y+18)
      const shallowTop = SHORELINE_Y - 115;
      ctx.save();
      ctx.beginPath();
      ctx.rect(visMinX, shallowTop, w, 138);
      ctx.clip();

      ctx.globalAlpha = 0.085;
      ctx.save();
      ctx.translate((t * 11) % 256, (t * 5) % 256);
      ctx.fillStyle = causticsPattern;
      ctx.fillRect(visMinX - 256, shallowTop - 256, w + 512, 420);
      ctx.restore();

      ctx.globalAlpha = 0.055;
      ctx.save();
      ctx.scale(1.28, 1.15);
      ctx.translate((-t * 7) % 256, (t * 8) % 256);
      ctx.fillStyle = causticsPattern;
      ctx.fillRect((visMinX - 300) / 1.28, (shallowTop - 256) / 1.15, (w + 600) / 1.28, 380);
      ctx.restore();
      ctx.restore();

      // Localized caustics around each island's shallow sandbar
      for (let i = 0; i < cachedIslandPolys.length; i++) {
        const { island, pts, center } = cachedIslandPolys[i];
        const r = (island.radius || 55) * 1.6;
        ctx.save();
        traceSmoothPolygon(ctx, pts, 1.52, center.x, center.y);
        ctx.clip();
        ctx.globalAlpha = 0.095;
        ctx.translate((t * 9 + i * 37) % 256, (t * 6) % 256);
        ctx.fillStyle = causticsPattern;
        ctx.fillRect(center.x - r - 256, center.y - r - 256, r * 2 + 512, r * 2 + 512);
        ctx.restore();
      }
      ctx.restore();
    }

    // 4) Multi-layer normal-lit ocean wave swells & wind capillary ripples (cross-drifting!)
    if (swellPattern) {
      ctx.save();
      // Broad primary swell layer drifting slowly SE
      ctx.globalAlpha = 0.50;
      ctx.save();
      ctx.scale(1.85, 1.55);
      ctx.translate((t * 8.5) % 256, (t * 5.2) % 256);
      ctx.fillStyle = swellPattern;
      ctx.fillRect(
        (visMinX - 480) / 1.85,
        (visMinY - 420) / 1.55,
        (w + 960) / 1.85,
        (SHORELINE_Y - visMinY + 460) / 1.55
      );
      ctx.restore();

      // Cross-swell interference layer rotated slightly for zero visible tiling periodicity!
      ctx.globalAlpha = 0.30;
      ctx.save();
      ctx.scale(1.26, 1.14);
      ctx.translate((-t * 5.4 + 117) % 256, (t * 7.6 + 73) % 256);
      ctx.fillStyle = swellPattern;
      ctx.fillRect(
        (visMinX - 360) / 1.26,
        (visMinY - 360) / 1.14,
        (w + 720) / 1.26,
        (SHORELINE_Y - visMinY + 400) / 1.14
      );
      ctx.restore();
      ctx.restore();
    }

    if (ripplePattern) {
      ctx.save();
      // Fine wind capillary ripples
      ctx.globalAlpha = 0.34;
      ctx.save();
      ctx.scale(0.92, 0.82);
      ctx.translate((t * 13.5) % 256, (t * 4.2) % 256);
      ctx.fillStyle = ripplePattern;
      ctx.fillRect(
        (visMinX - 300) / 0.92,
        (visMinY - 280) / 0.82,
        (w + 600) / 0.92,
        (SHORELINE_Y - visMinY + 320) / 0.82
      );
      ctx.restore();
      ctx.restore();
    }

    // 5) Subtle organic wind-blown whitecaps drifting across open swells
    ctx.save();
    ctx.lineCap = 'round';
    const spanW = WORLD_WIDTH + 460;
    for (let i = 0; i < whitecaps.length; i++) {
      const wc = whitecaps[i];
      const wx = ((wc.x + t * wc.speed + 230) % spanW) - 230;
      const wy = wc.y + Math.sin(t * 0.95 + wc.phase) * 3.5;
      const crest = Math.sin(t * 0.85 + wc.phase);
      if (crest < 0.48) continue;
      const f = (crest - 0.48) / 0.52;
      ctx.strokeStyle = `rgba(225, 242, 248, ${(f * 0.24).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(wx - wc.len * 0.5, wy);
      ctx.quadraticCurveTo(wx, wy - 2.2, wx + wc.len * 0.5, wy + 0.8);
      ctx.stroke();

      ctx.strokeStyle = `rgba(248, 253, 255, ${(f * f * 0.36).toFixed(3)})`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(wx - wc.len * 0.2, wy - 0.8);
      ctx.quadraticCurveTo(wx, wy - 2.0, wx + wc.len * 0.18, wy - 0.6);
      ctx.stroke();
    }

    // 6) Realistic sun-path specular wave glints (crisp elongated sunlit wave-ridge sparkles!)
    for (let i = 0; i < sunGlints.length; i++) {
      const g = sunGlints[i];
      const wave = Math.sin(t * g.speed + g.phase) * Math.sin(t * g.speed * 0.43 + g.phase * 1.7);
      if (wave < 0.56) continue;
      const b = (wave - 0.56) / 0.44;
      const gx = g.x + Math.sin(t * 0.6 + g.phase) * 5;
      const gy = g.y + Math.cos(t * 0.5 + g.phase) * 2.5;
      const halfL = g.width * (0.45 + b * 0.75);

      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(g.angle);
      // Warm golden-white specular streak along wave crest
      const glintGrad = ctx.createLinearGradient(-halfL, 0, halfL, 0);
      const col = g.warmth > 0.45 ? '255, 248, 224' : '236, 248, 255';
      glintGrad.addColorStop(0.0, `rgba(${col}, 0)`);
      glintGrad.addColorStop(0.5, `rgba(${col}, ${(b * 0.68).toFixed(3)})`);
      glintGrad.addColorStop(1.0, `rgba(${col}, 0)`);
      ctx.fillStyle = glintGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, halfL, 0.95 + b * 0.55, 0, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // 7) Subtle far-bay atmospheric coastal horizon haze for true aerial depth
    const horizonHaze = ctx.createLinearGradient(0, Math.min(0, visMinY), 0, 170);
    horizonHaze.addColorStop(0, 'rgba(165, 198, 218, 0.14)');
    horizonHaze.addColorStop(1, 'rgba(165, 198, 218, 0)');
    ctx.fillStyle = horizonHaze;
    ctx.fillRect(visMinX, Math.min(0, visMinY), w, 170 - Math.min(0, visMinY));
  }

  /**
   * Organic multi-layered lace-foam surf feathering naturally onto beaches, islands, and rocks.
   */
  function drawShorelineFoam(t, visMinX, visMaxX) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Feathered receding & advancing surf lace around islands
    for (let i = 0; i < cachedIslandPolys.length; i++) {
      const { pts, center } = cachedIslandPolys[i];
      for (let ring = 0; ring < 3; ring++) {
        const wave = (t * 0.34 + i * 0.37 + ring * 0.333) % 1;
        const expand = 1.02 + smoothstep(0, 1, wave) * 0.15;
        const alpha = Math.sin(wave * Math.PI) * (ring === 0 ? 0.34 : 0.22);

        // Soft aerated outer wash
        traceSmoothPolygon(ctx, pts, expand, center.x, center.y);
        ctx.strokeStyle = `rgba(218, 240, 244, ${(alpha * 0.45).toFixed(3)})`;
        ctx.lineWidth = 4.6 - wave * 2.2;
        ctx.stroke();

        // Delicate broken organic lace-foam edge
        ctx.strokeStyle = `rgba(244, 251, 253, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 1.5 - wave * 0.6;
        ctx.setLineDash([7 + ring * 3, 5 + ring * 2, 13, 6]);
        ctx.lineDashOffset = (i * 19 + ring * 11) + t * 2.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Gentle foam splash wash around coastal rocks
    for (let i = 0; i < cachedRockPolys.length; i++) {
      const { pts, center } = cachedRockPolys[i];
      for (let ring = 0; ring < 2; ring++) {
        const wave = (t * 0.44 + i * 0.29 + ring * 0.5) % 1;
        const expand = 1.05 + wave * 0.34;
        const alpha = Math.sin(wave * Math.PI) * 0.34;

        traceSmoothPolygon(ctx, pts, expand, center.x, center.y);
        ctx.strokeStyle = `rgba(232, 247, 250, ${(alpha * 0.5).toFixed(3)})`;
        ctx.lineWidth = 3.2 - wave * 1.6;
        ctx.stroke();

        ctx.strokeStyle = `rgba(248, 253, 255, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4, 9, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Feathered lapping lace-surf ribbons along the bottom beach shoreline
    const startX = Math.floor(visMinX / 32) * 32 - 32;
    const endX = visMaxX + 64;
    for (let layer = 0; layer < 3; layer++) {
      const cycle = (t * 0.36 + layer * 0.333) % 1;
      const surge = Math.sin(cycle * Math.PI);
      const baseY = SHORELINE_Y + 5 - surge * 9.5 - layer * 4.5;
      const alpha = surge * (layer === 0 ? 0.42 : 0.25);

      ctx.beginPath();
      let first = true;
      for (let x = startX; x <= endX; x += 32) {
        const y = baseY + Math.sin(x * 0.015 + t * 0.9 + layer * 1.7) * 3.4 + Math.cos(x * 0.037 - t * 0.5) * 1.4;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      // Soft aerated wash ribbon
      ctx.strokeStyle = `rgba(216, 240, 244, ${(alpha * 0.42).toFixed(3)})`;
      ctx.lineWidth = 5.5 - layer * 1.2;
      ctx.stroke();

      // Delicate broken white lace foam filament
      ctx.strokeStyle = `rgba(246, 252, 254, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([14, 6, 6, 8, 20, 7]);
      ctx.lineDashOffset = layer * 23 - t * 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /**
   * Refined minimal motorsport telemetry course guide (tasteful, unobtrusive on photorealistic water).
   */
  function drawRaceCourseLane(course, t) {
    const pts = course?.splinePoints;
    if (!pts || pts.length < 4) return;

    const halfW = course.corridorHalfWidth || 92;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();

    // Very subtle navigable channel tint
    ctx.strokeStyle = 'rgba(205, 232, 242, 0.038)';
    ctx.lineWidth = halfW * 1.58;
    ctx.stroke();

    // Crisp hairline telemetry dashed centerline
    ctx.strokeStyle = 'rgba(220, 242, 250, 0.24)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([12, 20]);
    ctx.lineDashOffset = -t * 24;
    ctx.stroke();
    ctx.setLineDash([]);

    // Minimalist motorsport telemetry direction chevrons
    const chevronCount = 14;
    const step = Math.max(1, Math.floor(pts.length / chevronCount));
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      const angle = Math.atan2(p.ty, p.tx);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 - (i / pts.length) * TWO_PI * 2);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.strokeStyle = `rgba(226, 244, 252, ${(0.18 + pulse * 0.18).toFixed(3)})`;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.moveTo(-6, -7.5);
      ctx.lineTo(3.5, 0);
      ctx.lineTo(-6, 7.5);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Realistic floating Start/Finish timing gate + Inflatable Race Committee RIB with marine LED light bar.
   */
  function drawStartFinishLineAndGantry(course, raceState, effectivePhase, t) {
    const sl = course?.startLine;
    if (!sl) return;

    const lx = sl.left?.x ?? (sl.x - sl.nx * (sl.halfWidth || 75));
    const ly = sl.left?.y ?? (sl.y - sl.ny * (sl.halfWidth || 75));
    const rx = sl.right?.x ?? (sl.x + sl.nx * (sl.halfWidth || 75));
    const ry = sl.right?.y ?? (sl.y + sl.ny * (sl.halfWidth || 75));

    const dx = rx - lx;
    const dy = ry - ly;
    const lineLen = Math.hypot(dx, dy) || 1;
    const ux = dx / lineLen;
    const uy = dy / lineLen;
    const tx = sl.tx ?? -uy;
    const ty = sl.ty ?? ux;

    ctx.save();

    const phase = effectivePhase || raceState?.phase || 'menu';

    // Subtle crisp telemetry start-box brackets behind start line during menu / countdown
    if (phase === 'menu' || phase === 'countdown') {
      const halfW = sl.halfWidth || course.corridorHalfWidth || 88;
      const maxLat = Math.min(58, Math.max(46, halfW - PHYSICS.boatRadius - 8));
      const slots = [
        { lat: 0, back: 46 },
        { lat: -maxLat * 0.5, back: 76 },
        { lat: maxLat * 0.5, back: 76 },
        { lat: -maxLat * 0.96, back: 46 },
        { lat: maxLat * 0.96, back: 46 },
      ];
      ctx.strokeStyle = 'rgba(220, 238, 246, 0.22)';
      ctx.lineWidth = 1.1;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const gx = sl.x - tx * s.back + ux * s.lat;
        const gy = sl.y - ty * s.back + uy * s.lat;
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(Math.atan2(ty, tx));
        ctx.beginPath();
        ctx.moveTo(12, -10);
        ctx.lineTo(18, -10);
        ctx.lineTo(18, 10);
        ctx.lineTo(12, 10);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Sleek tensioned marine timing rope with low-profile floating checkered marker floats
    const ribbonAngle = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(ribbonAngle);

    // Subtle water shadow beneath tensioned floating timing cable
    ctx.strokeStyle = 'rgba(4, 18, 30, 0.32)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(0, 2.5);
    ctx.lineTo(lineLen, 2.5);
    ctx.stroke();

    // Tensioned floating line
    ctx.strokeStyle = 'rgba(226, 236, 242, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(lineLen, 0);
    ctx.stroke();

    // Sleek alternating dark/white marine timing floats strung along cable
    const floatCount = Math.max(9, Math.round(lineLen / 14));
    const step = lineLen / floatCount;
    for (let i = 0; i < floatCount; i++) {
      const fx = (i + 0.5) * step;
      const bob = Math.sin(t * 2.9 + i * 0.7) * 0.5;
      ctx.fillStyle = i % 2 === 0 ? '#eef3f6' : '#182430';
      ctx.beginPath();
      ctx.ellipse(fx, bob, 4.4, 2.1, 0, 0, TWO_PI);
      ctx.fill();
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.beginPath();
        ctx.ellipse(fx - 0.8, bob - 0.5, 2.0, 0.8, 0, 0, TWO_PI);
        ctx.fill();
      }
    }
    ctx.restore();

    // Anchored start/finish timing gate spar buoys
    const ends = [
      { x: lx, y: ly },
      { x: rx, y: ry },
    ];
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      const bob = Math.sin(t * 2.5 + i * 1.9) * 1.2;

      // Subtle ripple
      ctx.strokeStyle = 'rgba(220, 242, 248, 0.28)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 11.5 + Math.sin(t * 2.1 + i) * 1.6, 0, TWO_PI);
      ctx.stroke();

      // Cast shadow SE
      ctx.fillStyle = 'rgba(4, 18, 30, 0.36)';
      ctx.beginPath();
      ctx.ellipse(e.x + SHAD_X * 4.5, e.y + SHAD_Y * 4.5, 7.8, 6.8, 0.4, 0, TWO_PI);
      ctx.fill();

      // Cylindrical 3D marine timing buoy (matte-white & slate checkered collar)
      const bg = ctx.createRadialGradient(e.x - 2.6, e.y + bob - 2.6, 1, e.x, e.y + bob, 8.2);
      bg.addColorStop(0, '#ffffff');
      bg.addColorStop(0.55, '#d7e0e6');
      bg.addColorStop(1, '#586774');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, 7.8, 0, TWO_PI);
      ctx.fill();

      // Subtle checkered quarters
      ctx.fillStyle = 'rgba(15, 23, 36, 0.78)';
      ctx.beginPath();
      ctx.moveTo(e.x, e.y + bob);
      ctx.arc(e.x, e.y + bob, 6.4, 0, Math.PI * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(e.x, e.y + bob);
      ctx.arc(e.x, e.y + bob, 6.4, Math.PI, Math.PI * 1.5);
      ctx.closePath();
      ctx.fill();

      // Anodized champagne gold timing cap
      ctx.fillStyle = '#d4af37';
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, 2.5, 0, TWO_PI);
      ctx.fill();
    }

    // Realistic Inflatable Race Committee RIB (Rigid Inflatable Boat) moored outside the start gate
    const candA = { x: lx - ux * 30, y: ly - uy * 30 };
    const candB = { x: rx + ux * 30, y: ry + uy * 30 };
    const scoreCand = (c) => {
      let s = 0;
      if (c.x < 70 || c.x > WORLD_WIDTH - 70) s -= 200;
      if (c.y < 60 || c.y > SHORELINE_Y - 45) s -= 200;
      return s;
    };
    const rib = scoreCand(candA) >= scoreCand(candB) ? candA : candB;
    const ribAngle = Math.atan2(ty, tx);
    const ribBob = Math.sin(t * 2.0) * 1.2;

    ctx.save();
    ctx.translate(rib.x, rib.y + ribBob);
    ctx.rotate(ribAngle);

    // Subtle anchor ripple
    ctx.strokeStyle = 'rgba(218, 240, 246, 0.22)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(0, 0, 26 + Math.sin(t * 1.8) * 1.8, 15 + Math.sin(t * 1.8) * 1.2, 0, 0, TWO_PI);
    ctx.stroke();

    // Soft cast water shadow
    ctx.save();
    ctx.rotate(-ribAngle);
    ctx.translate(SHAD_X * 5.5, SHAD_Y * 5.5);
    ctx.rotate(ribAngle);
    ctx.fillStyle = 'rgba(4, 18, 30, 0.38)';
    ctx.beginPath();
    ctx.moveTo(23, 0);
    ctx.bezierCurveTo(18, 13, -18, 13, -22, 9);
    ctx.lineTo(-22, -9);
    ctx.bezierCurveTo(-18, -13, 18, -13, 23, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Charcoal-slate Hypalon inflatable collar tube with 3D cylindrical shading
    const tubeGrad = ctx.createLinearGradient(0, -12, 0, 12);
    tubeGrad.addColorStop(0.0, '#64748b');
    tubeGrad.addColorStop(0.32, '#475569');
    tubeGrad.addColorStop(0.75, '#2b3847');
    tubeGrad.addColorStop(1.0, '#17202b');
    ctx.fillStyle = tubeGrad;
    ctx.beginPath();
    ctx.moveTo(23, 0);
    ctx.bezierCurveTo(18, 12.5, -18, 12.5, -22, 8.8);
    ctx.lineTo(-22, -8.8);
    ctx.bezierCurveTo(-18, -12.5, 18, -12.5, 23, 0);
    ctx.closePath();
    ctx.fill();

    // Subtle grab-line patches along collar
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(-10, -11.5, 5, 2.2);
    ctx.fillRect(3, -11.5, 5, 2.2);
    ctx.fillRect(-10, 9.3, 5, 2.2);
    ctx.fillRect(3, 9.3, 5, 2.2);

    // Fiberglass interior non-skid deck
    ctx.fillStyle = '#cfd8e0';
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.bezierCurveTo(11, 7.2, -14, 7.2, -17, 5.5);
    ctx.lineTo(-17, -5.5);
    ctx.bezierCurveTo(-14, -7.2, 11, -7.2, 15, 0);
    ctx.closePath();
    ctx.fill();

    // Center helm console with smoked windscreen
    ctx.fillStyle = '#334155';
    ctx.beginPath();
    safeRoundRect(ctx, -6, -4.5, 11, 9, 2);
    ctx.fill();
    ctx.fillStyle = '#0c1622';
    ctx.beginPath();
    safeRoundRect(ctx, -1, -3.6, 4.5, 7.2, 1.4);
    ctx.fill();

    // Stern anodized aluminum A-frame arch & marine LED Starting Light Bar
    ctx.fillStyle = '#0b121c';
    ctx.beginPath();
    safeRoundRect(ctx, 7, -9.8, 7.5, 19.6, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 200, 218, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Starting signal LED states (3-2-1-GO)
    const cd = raceState?.countdown ?? 0;
    let light1 = '#263240';
    let light2 = '#263240';
    let light3 = '#263240';
    let glowColor = null;

    if (phase === 'countdown') {
      const ceilCd = Math.ceil(cd);
      if (ceilCd >= 3) {
        light1 = '#ef4444';
        glowColor = 'rgba(239, 68, 68, 0.36)';
      } else if (ceilCd === 2) {
        light1 = '#ef4444';
        light2 = '#ef4444';
        glowColor = 'rgba(239, 68, 68, 0.45)';
      } else if (ceilCd === 1) {
        light1 = '#ef4444';
        light2 = '#f59e0b';
        light3 = '#f59e0b';
        glowColor = 'rgba(245, 158, 11, 0.48)';
      } else {
        light1 = '#10b981';
        light2 = '#10b981';
        light3 = '#10b981';
        glowColor = 'rgba(16, 185, 129, 0.58)';
      }
    } else if (phase === 'racing') {
      light1 = '#10b981';
      light2 = '#10b981';
      light3 = '#10b981';
      glowColor = goLightPulse > 0.05
        ? `rgba(16, 185, 129, ${(0.34 + goLightPulse * 0.25).toFixed(2)})`
        : 'rgba(16, 185, 129, 0.18)';
    } else if (phase === 'finished') {
      const blink = Math.sin(t * 6.5) > 0;
      light1 = blink ? '#f1f5f9' : '#38bdf8';
      light2 = blink ? '#38bdf8' : '#f1f5f9';
      light3 = blink ? '#f1f5f9' : '#38bdf8';
      glowColor = 'rgba(56, 189, 248, 0.28)';
    } else {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.5);
      light2 = pulse > 0.4 ? '#38bdf8' : '#1e3248';
      glowColor = `rgba(56, 189, 248, ${(pulse * 0.24).toFixed(2)})`;
    }

    if (glowColor) {
      const bloom = ctx.createRadialGradient(10.8, 0, 1.5, 10.8, 0, 20 + goLightPulse * 8);
      bloom.addColorStop(0, glowColor);
      bloom.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(10.8, 0, 20 + goLightPulse * 8, 0, TWO_PI);
      ctx.fill();
    }

    const leds = [
      { y: -5.4, c: light1 },
      { y: 0, c: light2 },
      { y: 5.4, c: light3 },
    ];
    for (let i = 0; i < leds.length; i++) {
      ctx.fillStyle = leds[i].c;
      ctx.beginPath();
      ctx.arc(10.8, leds[i].y, 2.0, 0, TWO_PI);
      ctx.fill();
    }

    ctx.restore();
    ctx.restore();
  }

  function drawRipples() {
    if (ripples.length === 0) return;
    ctx.save();
    for (let i = 0; i < ripples.length; i++) {
      const r = ripples[i];
      const p = clamp(r.age / r.duration, 0, 1);
      const radius = lerp(r.startRadius, r.maxRadius, 1 - (1 - p) * (1 - p));
      const alpha = (1 - p) * (1 - p);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.lineWidth * (1 - p * 0.55);
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, TWO_PI);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Photorealistic boat wakes:
   * 1) Aerated turquoise underwater prop-wash churning beneath the surface
   * 2) Feathered, turbulent lace-white surface V-wakes along Kelvin arms
   * 3) Frothy micro-bubble center prop-wash trailing off the transom
   */
  function drawBoatWakes(boats, t) {
    if (!boats || boats.length === 0) return;
    const maxAge = PHYSICS.wakeMaxAge || 1.45;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let b = 0; b < boats.length; b++) {
      const boat = boats[b];
      const trail = boat.wakeTrail;
      if (!trail || trail.length < 2) continue;

      const n = trail.length;
      const leftPts = new Array(n);
      const rightPts = new Array(n);
      const innerLeft = new Array(n);
      const innerRight = new Array(n);
      const alphas = new Array(n);

      for (let i = 0; i < n; i++) {
        const pt = trail[i];
        const age = pt.age ?? ((n - 1 - i) / n) * maxAge;
        const normAge = clamp(age / maxAge, 0, 1);
        const spdFactor = clamp((pt.speed ?? boat.speed ?? 140) / 265, 0.2, 1.15);

        let nx = pt.nx;
        let ny = pt.ny;
        if (typeof nx !== 'number' || typeof ny !== 'number') {
          if (typeof pt.heading === 'number') {
            nx = -Math.sin(pt.heading);
            ny = Math.cos(pt.heading);
          } else {
            const prev = trail[Math.max(0, i - 1)];
            const next = trail[Math.min(n - 1, i + 1)];
            const dx = next.x - prev.x;
            const dy = next.y - prev.y;
            const len = Math.hypot(dx, dy) || 1;
            nx = -dy / len;
            ny = dx / len;
          }
        }

        // Subtle organic wake edge turbulence
        const turb = Math.sin(i * 1.4 + t * 4.5 + b) * (1.2 + normAge * 2.4);
        const baseHalf = typeof pt.width === 'number' ? pt.width * 0.36 : 5.2;
        const halfSpread = baseHalf + Math.pow(normAge, 0.85) * 26 * spdFactor;
        const innerSpread = baseHalf * 0.52 + normAge * 10 * spdFactor;

        leftPts[i] = { x: pt.x + nx * (halfSpread + turb), y: pt.y + ny * (halfSpread + turb) };
        rightPts[i] = { x: pt.x - nx * (halfSpread - turb), y: pt.y - ny * (halfSpread - turb) };
        innerLeft[i] = { x: pt.x + nx * innerSpread, y: pt.y + ny * innerSpread };
        innerRight[i] = { x: pt.x - nx * innerSpread, y: pt.y - ny * innerSpread };
        alphas[i] = (1 - normAge) * (1 - normAge) * spdFactor;
      }

      for (let i = 0; i < n - 1; i++) {
        const a = Math.min(alphas[i], alphas[i + 1]);
        if (a < 0.015) continue;

        // 1) Subsurface aerated turquoise-cyan prop-wash glow
        ctx.fillStyle = `rgba(56, 174, 188, ${(a * 0.24).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(leftPts[i].x, leftPts[i].y);
        ctx.lineTo(leftPts[i + 1].x, leftPts[i + 1].y);
        ctx.lineTo(rightPts[i + 1].x, rightPts[i + 1].y);
        ctx.lineTo(rightPts[i].x, rightPts[i].y);
        ctx.closePath();
        ctx.fill();

        // 2) Inner lacy pale-aqua churned wake core
        ctx.fillStyle = `rgba(202, 238, 244, ${(a * 0.22).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(innerLeft[i].x, innerLeft[i].y);
        ctx.lineTo(innerLeft[i + 1].x, innerLeft[i + 1].y);
        ctx.lineTo(innerRight[i + 1].x, innerRight[i + 1].y);
        ctx.lineTo(innerRight[i].x, innerRight[i].y);
        ctx.closePath();
        ctx.fill();

        // 3) Feathered outer Kelvin V-wake foam crests (soft outer wash + crisp white ridge)
        ctx.strokeStyle = `rgba(218, 242, 248, ${(a * 0.26).toFixed(3)})`;
        ctx.lineWidth = 3.2 + (1 - a) * 2.4;
        ctx.beginPath();
        ctx.moveTo(leftPts[i].x, leftPts[i].y);
        ctx.lineTo(leftPts[i + 1].x, leftPts[i + 1].y);
        ctx.moveTo(rightPts[i].x, rightPts[i].y);
        ctx.lineTo(rightPts[i + 1].x, rightPts[i + 1].y);
        ctx.stroke();

        ctx.strokeStyle = `rgba(248, 253, 255, ${(a * 0.56).toFixed(3)})`;
        ctx.lineWidth = 1.15 + a * 0.7;
        ctx.beginPath();
        ctx.moveTo(leftPts[i].x, leftPts[i].y);
        ctx.lineTo(leftPts[i + 1].x, leftPts[i + 1].y);
        ctx.moveTo(rightPts[i].x, rightPts[i].y);
        ctx.lineTo(rightPts[i + 1].x, rightPts[i + 1].y);
        ctx.stroke();

        // 4) Frothy prop-wash bubbles directly astern
        if (a > 0.28) {
          ctx.strokeStyle = `rgba(244, 252, 255, ${((a - 0.28) * 0.65).toFixed(3)})`;
          ctx.lineWidth = 2.6 * a;
          ctx.beginPath();
          ctx.moveTo(trail[i].x, trail[i].y);
          ctx.lineTo(trail[i + 1].x, trail[i + 1].y);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  /**
   * Refined minimal motorsport telemetry beacon for the player's next buoy.
   */
  function drawActiveBuoyBeacon(course, boats, raceState, effectivePhase, t) {
    if (!course?.buoys?.length || !boats?.length) return;
    const player = boats.find((b) => b.isPlayer) || boats[0];
    if (!player || player.finished) return;

    const phase = effectivePhase || raceState?.phase || 'menu';
    if (phase === 'finished') return;

    const missed = Boolean(player.missedBuoyWarning?.active);
    const targetIdx = missed && player.missedBuoyWarning.buoyIndex >= 0
      ? player.missedBuoyWarning.buoyIndex
      : player.nextBuoyIndex;
    const buoy = course.buoys[targetIdx % course.buoys.length];
    if (!buoy) return;

    ctx.save();

    // Disciplined motorsport telemetry colors (champagne-ice normal, surgical amber-crimson missed)
    const ringRgb = missed ? '239, 98, 68' : '226, 206, 148';
    const accentCol = missed ? '#f97316' : '#e8cb7e';

    // Subtle expanding telemetry target rings
    for (let ring = 0; ring < 2; ring++) {
      const p = (t * (missed ? 1.4 : 0.85) + ring * 0.5) % 1;
      const rad = 16 + p * 30;
      const alpha = (1 - p) * (missed ? 0.72 : 0.45);
      ctx.strokeStyle = `rgba(${ringRgb}, ${alpha.toFixed(3)})`;
      ctx.lineWidth = missed ? 2.2 : 1.5;
      ctx.beginPath();
      ctx.arc(buoy.x, buoy.y, rad, 0, TWO_PI);
      ctx.stroke();
    }

    // Crisp minimal gate plane indicator line
    if (typeof buoy.outerX === 'number' && typeof buoy.outerY === 'number') {
      ctx.strokeStyle = `rgba(${ringRgb}, ${missed ? 0.36 : 0.18})`;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 9]);
      ctx.beginPath();
      ctx.moveTo(buoy.x, buoy.y);
      ctx.lineTo(buoy.outerX, buoy.outerY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Sleek minimal telemetry heading chevron orbiting subtly around player boat
    if (phase === 'racing') {
      const gx = buoy.gateCenter?.x ?? (typeof buoy.outerX === 'number' ? (buoy.x + buoy.outerX) * 0.5 : buoy.x + (buoy.outX || 0) * 42);
      const gy = buoy.gateCenter?.y ?? (typeof buoy.outerY === 'number' ? (buoy.y + buoy.outerY) * 0.5 : buoy.y + (buoy.outY || 0) * 42);
      const dx = gx - player.x;
      const dy = gy - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 72) {
        const ang = Math.atan2(dy, dx);
        const orbitR = 34;
        const px = player.x + Math.cos(ang) * orbitR;
        const py = player.y + Math.sin(ang) * orbitR;
        const pulse = 0.72 + 0.28 * Math.sin(t * (missed ? 9 : 3.8));

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.globalAlpha = pulse * (missed ? 0.92 : 0.74);

        ctx.fillStyle = accentCol;
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(-4.5, -5.2);
        ctx.lineTo(-1.8, 0);
        ctx.lineTo(-4.5, 5.2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /**
   * Pre-cached aerial islands + Architectural Whitewashed Stone Lighthouse with rotating volumetric beam.
   */
  function drawIslandsAndLighthouses(t) {
    if (islandsCanvas) {
      ctx.drawImage(islandsCanvas, 0, 0);
    }

    for (let i = 0; i < cachedLighthouses.length; i++) {
      const lh = cachedLighthouses[i];
      const beamAngle = t * 0.48 + lh.phase;

      ctx.save();
      ctx.translate(lh.x, lh.y);

      // Delicate volumetric golden haze lighthouse beam sweeping across the bay
      ctx.save();
      ctx.rotate(beamAngle);
      const beamLen = 250;
      const beamGrad = ctx.createRadialGradient(0, 0, 5, 0, 0, beamLen);
      beamGrad.addColorStop(0.0, 'rgba(255, 242, 198, 0.30)');
      beamGrad.addColorStop(0.28, 'rgba(255, 238, 185, 0.12)');
      beamGrad.addColorStop(0.7, 'rgba(255, 238, 185, 0.035)');
      beamGrad.addColorStop(1.0, 'rgba(255, 238, 185, 0)');
      ctx.fillStyle = beamGrad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, beamLen, -0.18, 0.18);
      ctx.closePath();
      ctx.fill();

      // Secondary opposite Fresnel lens reflection beam
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, beamLen * 0.52, Math.PI - 0.13, Math.PI + 0.13);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Realistic tapered architectural tower shadow cast SE across the island
      const shadLen = 26;
      const shadGrad = ctx.createLinearGradient(0, 0, SHAD_X * shadLen, SHAD_Y * shadLen);
      shadGrad.addColorStop(0, 'rgba(10, 18, 22, 0.46)');
      shadGrad.addColorStop(1, 'rgba(10, 18, 22, 0.06)');
      ctx.fillStyle = shadGrad;
      ctx.beginPath();
      ctx.moveTo(-6, 5);
      ctx.lineTo(SHAD_X * shadLen - 3, SHAD_Y * shadLen + 4);
      ctx.lineTo(SHAD_X * shadLen + 4, SHAD_Y * shadLen - 3);
      ctx.lineTo(5, -6);
      ctx.closePath();
      ctx.fill();

      // Weathered granite masonry foundation apron
      const stoneGrad = ctx.createLinearGradient(-11, -11, 11, 11);
      stoneGrad.addColorStop(0, '#c8c5bc');
      stoneGrad.addColorStop(0.55, '#92918a');
      stoneGrad.addColorStop(1, '#585b5a');
      ctx.fillStyle = stoneGrad;
      ctx.beginPath();
      ctx.arc(0, 1, 11.8, 0, TWO_PI);
      ctx.fill();

      // Cylindrical whitewashed stone tower (3D sunlit NW -> cool slate SE)
      const towerGrad = ctx.createLinearGradient(-9, -9, 9, 9);
      towerGrad.addColorStop(0, '#f5f2ea');
      towerGrad.addColorStop(0.55, '#d6d4cc');
      towerGrad.addColorStop(1, '#7c848c');
      ctx.fillStyle = towerGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 8.8, 0, TWO_PI);
      ctx.fill();

      // Crisp maritime oxide-red daymark band (cylindrically shaded)
      const bandGrad = ctx.createLinearGradient(-7, -8, 7, 6);
      bandGrad.addColorStop(0, '#c94138');
      bandGrad.addColorStop(0.55, '#9d2b25');
      bandGrad.addColorStop(1, '#571817');
      ctx.fillStyle = bandGrad;
      ctx.beginPath();
      ctx.arc(-0.5, -1.4, 7.2, 0, TWO_PI);
      ctx.fill();

      // Upper whitewashed tower section
      ctx.fillStyle = towerGrad;
      ctx.beginPath();
      ctx.arc(-1.0, -2.8, 5.7, 0, TWO_PI);
      ctx.fill();

      // Wrought-iron gallery deck & crisp dark railing ring
      ctx.fillStyle = '#36414c';
      ctx.beginPath();
      ctx.arc(-1.3, -3.7, 5.4, 0, TWO_PI);
      ctx.fill();
      ctx.strokeStyle = '#1e2730';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(-1.4, -3.9, 5.3, 0, TWO_PI);
      ctx.stroke();

      // Warm glass Fresnel lantern room glow
      const lampGrad = ctx.createRadialGradient(-1.6, -4.4, 0.5, -1.5, -4.2, 4.0);
      lampGrad.addColorStop(0, '#fffbeb');
      lampGrad.addColorStop(0.55, '#f6d57a');
      lampGrad.addColorStop(1, '#b0863a');
      ctx.fillStyle = lampGrad;
      ctx.beginPath();
      ctx.arc(-1.5, -4.2, 3.8, 0, TWO_PI);
      ctx.fill();

      // Weathered oxidized-copper cupola dome with sunlit patina highlight
      const domeGrad = ctx.createRadialGradient(-2.4, -5.6, 0.4, -1.7, -4.8, 3.1);
      domeGrad.addColorStop(0, '#7db09e');
      domeGrad.addColorStop(0.55, '#467467');
      domeGrad.addColorStop(1, '#234039');
      ctx.fillStyle = domeGrad;
      ctx.beginPath();
      ctx.arc(-1.7, -4.8, 2.7, 0, TWO_PI);
      ctx.fill();

      // Finial glint
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.arc(-2.0, -5.2, 0.75, 0, TWO_PI);
      ctx.fill();

      ctx.restore();
    }
  }

  /**
   * Realistic aerial moored coastal yachts & cabin cruisers (zero cartoon outlines).
   */
  function drawSpectatorBoats(course, t) {
    const specBoats = course?.scenery?.spectatorBoats;
    if (!specBoats || specBoats.length === 0) return;

    for (let i = 0; i < specBoats.length; i++) {
      const sb = specBoats[i];
      const phase = sb.bobPhase ?? i * 1.9;
      const bobY = Math.sin(t * 1.7 + phase) * 1.3;
      const sway = Math.sin(t * 1.05 + phase) * 0.035;
      const ang = (sb.angle ?? sb.heading ?? 0.3) + sway;
      const len = sb.length || 36;
      const wid = sb.width || 14;
      const hullFill = sb.hullColor || '#eceff2';
      const cabinFill = sb.cabinColor || '#1e3a52';

      ctx.save();
      ctx.translate(sb.x, sb.y + bobY);

      // Gentle ambient anchor ripple
      ctx.strokeStyle = 'rgba(218, 240, 246, 0.18)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, 0, len * 0.62 + Math.sin(t * 1.9 + phase) * 1.6, wid * 0.78 + Math.sin(t * 1.9 + phase) * 1.0, ang, 0, TWO_PI);
      ctx.stroke();

      // Cast directional water shadow (SE)
      ctx.save();
      ctx.translate(SHAD_X * 5.2, SHAD_Y * 5.2);
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(4, 18, 30, 0.34)';
      ctx.beginPath();
      ctx.moveTo(len * 0.54, 0);
      ctx.quadraticCurveTo(len * 0.1, wid * 0.54, -len * 0.48, wid * 0.42);
      ctx.lineTo(-len * 0.48, -wid * 0.42);
      ctx.quadraticCurveTo(len * 0.1, -wid * 0.54, len * 0.54, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.rotate(ang);

      // Fiberglass yacht hull with directional light shading
      const hg = ctx.createLinearGradient(0, -wid * 0.5, 0, wid * 0.5);
      hg.addColorStop(0, '#ffffff');
      hg.addColorStop(0.5, hullFill);
      hg.addColorStop(1, '#a9b5c1');
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.moveTo(len * 0.54, 0);
      ctx.quadraticCurveTo(len * 0.1, wid * 0.54, -len * 0.48, wid * 0.42);
      ctx.lineTo(-len * 0.48, -wid * 0.42);
      ctx.quadraticCurveTo(len * 0.1, -wid * 0.54, len * 0.54, 0);
      ctx.closePath();
      ctx.fill();

      // Teak aft cockpit deck inlay
      ctx.fillStyle = '#9a7e5f';
      ctx.beginPath();
      safeRoundRect(ctx, -len * 0.44, -wid * 0.3, len * 0.24, wid * 0.6, 1.5);
      ctx.fill();

      // Sleek sculpted cabin superstructure
      ctx.fillStyle = '#f1f5f8';
      ctx.beginPath();
      safeRoundRect(ctx, -len * 0.22, -wid * 0.33, len * 0.38, wid * 0.66, 3);
      ctx.fill();

      // Wrap-around smoked marine glass windshield
      const windGrad = ctx.createLinearGradient(len * 0.05, -wid * 0.3, len * 0.16, wid * 0.3);
      windGrad.addColorStop(0, '#36556e');
      windGrad.addColorStop(0.45, '#111d29');
      windGrad.addColorStop(1, '#081018');
      ctx.fillStyle = windGrad;
      ctx.beginPath();
      ctx.moveTo(len * 0.22, 0);
      ctx.quadraticCurveTo(len * 0.16, wid * 0.3, len * 0.02, wid * 0.31);
      ctx.lineTo(len * 0.02, -wid * 0.31);
      ctx.quadraticCurveTo(len * 0.16, -wid * 0.3, len * 0.22, 0);
      ctx.closePath();
      ctx.fill();

      // Accent bimini / radar arch stripe
      ctx.fillStyle = cabinFill;
      ctx.fillRect(-len * 0.18, -wid * 0.3, len * 0.12, wid * 0.6);

      // Subtle chrome bow rail glint
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(len * 0.5, 0);
      ctx.quadraticCurveTo(len * 0.26, -wid * 0.34, len * 0.1, -wid * 0.38);
      ctx.stroke();

      ctx.restore();
    }
  }

  /**
   * Photorealistic matte-gloss marine racing buoys with cylindrical 3D lighting,
   * water reflections, subtle submerged anchor-line hints, and crisp stencils.
   */
  function drawBuoys(course, boats, t) {
    const buoys = course?.buoys;
    if (!buoys || buoys.length === 0) return;

    const player = boats?.find((b) => b.isPlayer);
    const nextIdx = player && !player.finished ? player.nextBuoyIndex : -1;

    for (let i = 0; i < buoys.length; i++) {
      const b = buoys[i];
      const bobPhase = b.bobPhase ?? i * 1.4;
      const bobY = Math.sin(t * 2.6 + bobPhase) * 1.3;

      // 1) Outer Gate Spar Buoy (authentic marine international-orange cylinder)
      if (typeof b.outerX === 'number' && typeof b.outerY === 'number') {
        const obob = Math.sin(t * 2.8 + bobPhase + 1.2) * 1.1;
        const oShake = b.outerHitTimer > 0 ? Math.sin(t * 42) * b.outerHitTimer * 2.8 : 0;
        const orad = b.outerRadius || PHYSICS.outerBuoyRadius || 7;
        const ox = b.outerX + oShake;
        const oy = b.outerY + obob;

        ctx.save();
        ctx.translate(ox, oy);

        // Subtle water surface reflection beneath spar buoy
        ctx.fillStyle = 'rgba(218, 92, 38, 0.18)';
        ctx.beginPath();
        ctx.ellipse(0, orad * 0.75, orad * 0.9, orad * 0.55, 0, 0, TWO_PI);
        ctx.fill();

        // Ripple ring
        ctx.strokeStyle = b.outerHitTimer > 0
          ? `rgba(248, 113, 113, ${(0.45 + b.outerHitTimer * 0.45).toFixed(2)})`
          : 'rgba(218, 240, 246, 0.28)';
        ctx.lineWidth = b.outerHitTimer > 0 ? 1.8 : 1.0;
        ctx.beginPath();
        ctx.arc(0, 0, orad + 3.5 + Math.sin(t * 2.2 + i) * 1.2, 0, TWO_PI);
        ctx.stroke();

        // Directional cast shadow SE
        ctx.fillStyle = 'rgba(4, 18, 30, 0.36)';
        ctx.beginPath();
        ctx.ellipse(SHAD_X * 4.2, SHAD_Y * 4.2, orad * 1.05, orad * 0.85, 0.5, 0, TWO_PI);
        ctx.fill();

        // Matte-gloss cylindrical orange marine spar body
        const og = ctx.createRadialGradient(SUN_X * orad * 0.45, SUN_Y * orad * 0.45, orad * 0.1, 0, 0, orad * 1.05);
        og.addColorStop(0.0, '#ffd4b2');
        og.addColorStop(0.32, '#e86826');
        og.addColorStop(0.78, '#a83c12');
        og.addColorStop(1.0, '#5c1f09');
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.arc(0, 0, orad, 0, TWO_PI);
        ctx.fill();

        // SOLAS reflective collar band
        ctx.strokeStyle = 'rgba(244, 248, 250, 0.85)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, orad * 0.56, 0, TWO_PI);
        ctx.stroke();

        ctx.restore();
      }

      // 2) Main Apex Marine Racing Buoy
      const hitShake = b.hitTimer > 0 ? Math.sin(t * 40) * b.hitTimer * 3.2 : 0;
      const bx = b.x + (b.hitVelX ? clamp(b.hitVelX * 0.04, -5, 5) : 0) + hitShake;
      const by = b.y + (b.hitVelY ? clamp(b.hitVelY * 0.04, -5, 5) : 0) + bobY;
      const rad = b.radius || PHYSICS.buoyRadius || 11;
      const isNext = i === nextIdx;

      // Natural marine-grade PVC/urethane buoy colors (realistic, never neon-plastic)
      const rawColor = (b.color || '').toLowerCase();
      let specCol = '#f8d3c9';
      let midCol = '#cf3a2b';
      let deepCol = '#5c1512';
      let reflRgb = '207, 58, 43';
      if (rawColor.includes('yellow') || rawColor.includes('fbbf24') || rawColor.includes('eab308') || rawColor.includes('f59e0b')) {
        specCol = '#fbf0c4';
        midCol = '#d99e1e';
        deepCol = '#6b490c';
        reflRgb = '217, 158, 30';
      } else if (rawColor.includes('green') || rawColor.includes('10b981') || rawColor.includes('22c55e')) {
        specCol = '#c8ebd5';
        midCol = '#1f8a58';
        deepCol = '#0d4029';
        reflRgb = '31, 138, 88';
      } else if (rawColor.includes('orange') || rawColor.includes('f97316') || rawColor.includes('ff6')) {
        specCol = '#fde0c8';
        midCol = '#dd5f1e';
        deepCol = '#6b280b';
        reflRgb = '221, 95, 30';
      }

      ctx.save();

      // Sleek minimal telemetry water-surface rounding chevrons on the outside of the turn
      if (typeof b.outX === 'number' && typeof b.outY === 'number') {
        const arrowDist = rad + 15;
        const ax = bx + b.outX * arrowDist;
        const ay = by + b.outY * arrowDist;
        const dirAngle = Math.atan2(b.dirY ?? -b.outX, b.dirX ?? b.outY);

        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(dirAngle);
        ctx.strokeStyle = isNext ? 'rgba(235, 212, 148, 0.88)' : 'rgba(218, 238, 246, 0.36)';
        ctx.lineWidth = isNext ? 2.0 : 1.35;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-5, -4.5);
        ctx.lineTo(0, 0);
        ctx.lineTo(-5, 4.5);
        ctx.moveTo(0.5, -4.5);
        ctx.lineTo(5.5, 0);
        ctx.lineTo(0.5, 4.5);
        ctx.stroke();
        ctx.restore();
      }

      ctx.translate(bx, by);

      // Subtle submerged anchor-line hint descending into deep water
      ctx.strokeStyle = 'rgba(8, 24, 34, 0.22)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, rad * 0.5);
      ctx.quadraticCurveTo(4, rad + 9, 9, rad + 18);
      ctx.stroke();

      // Soft inverted color reflection shimmering in water below buoy
      const reflGrad = ctx.createRadialGradient(0, rad * 0.85, 1, 0, rad * 0.85, rad * 1.15);
      reflGrad.addColorStop(0, `rgba(${reflRgb}, 0.24)`);
      reflGrad.addColorStop(1, `rgba(${reflRgb}, 0)`);
      ctx.fillStyle = reflGrad;
      ctx.beginPath();
      ctx.ellipse(0, rad * 0.85, rad * 1.1, rad * 0.65, 0, 0, TWO_PI);
      ctx.fill();

      // Ambient water ripple ring
      const ripR = rad + 4.5 + Math.sin(t * 2.3 + bobPhase) * 1.8;
      ctx.strokeStyle = b.hitTimer > 0
        ? `rgba(248, 113, 113, ${(0.48 + b.hitTimer * 0.45).toFixed(2)})`
        : 'rgba(220, 242, 248, 0.32)';
      ctx.lineWidth = b.hitTimer > 0 ? 2.0 : 1.1;
      ctx.beginPath();
      ctx.arc(0, 0, ripR, 0, TWO_PI);
      ctx.stroke();

      // Cast directional water shadow (SE)
      ctx.fillStyle = 'rgba(3, 16, 28, 0.42)';
      ctx.beginPath();
      ctx.ellipse(SHAD_X * 5.8, SHAD_Y * 5.8, rad * 1.08, rad * 0.88, 0.55, 0, TWO_PI);
      ctx.fill();

      // 3D matte-gloss marine buoy cylinder body (zero heavy black outline!)
      const bg = ctx.createRadialGradient(
        SUN_X * rad * 0.48,
        SUN_Y * rad * 0.48,
        rad * 0.08,
        0,
        0,
        rad * 1.08
      );
      bg.addColorStop(0.0, specCol);
      bg.addColorStop(0.32, midCol);
      bg.addColorStop(0.82, deepCol);
      bg.addColorStop(1.0, 'rgba(18, 42, 52, 0.95)'); // subtle cool ocean bounce light on rim
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, TWO_PI);
      ctx.fill();

      // Subtle water-line ambient occlusion seam around base
      ctx.strokeStyle = 'rgba(4, 18, 28, 0.32)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, TWO_PI);
      ctx.stroke();

      // Crisp SOLAS white retro-reflective tape collar
      ctx.strokeStyle = 'rgba(244, 248, 250, 0.88)';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.66, 0, TWO_PI);
      ctx.stroke();

      // Clean anodized top cap & crisp racing stencil number
      ctx.fillStyle = 'rgba(12, 20, 30, 0.84)';
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.46, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = isNext ? '#e8cb7e' : '#f1f5f9';
      ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String((b.index ?? i) + 1), 0, 0.5);

      ctx.restore();
    }
  }

  /**
   * Emit graduated misty rooster-tail plumes & translucent chine-sheath spray droplets.
   */
  function emitBoatParticles(boats, dt) {
    if (!boats || dt <= 0) return;

    for (let i = 0; i < boats.length; i++) {
      const boat = boats[i];
      const spd = Math.hypot(boat.vx || 0, boat.vy || 0);
      if (spd < 35) continue;

      const spdRatio = clamp(spd / (PHYSICS.maxSpeed || 295), 0, 1.2);
      const prev = sprayAccum.get(boat.id) || 0;
      const rate = 26 + spdRatio * 62;
      let acc = prev + dt * rate;

      const cosH = Math.cos(boat.heading || 0);
      const sinH = Math.sin(boat.heading || 0);
      const nx = -sinH;
      const ny = cosH;
      const sternX = boat.x - cosH * 22;
      const sternY = boat.y - sinH * 22;

      while (acc >= 1) {
        acc -= 1;
        if (particles.length >= MAX_PARTICLES) particles.shift();

        // 1) Graduated misty rooster-tail plume shooting behind prop
        const spread = (Math.random() - 0.5) * 0.36;
        const jetAngle = (boat.heading || 0) + Math.PI + spread;
        const jetSpeed = (34 + Math.random() * 58) * spdRatio;
        particles.push({
          x: sternX + (Math.random() - 0.5) * 2.6,
          y: sternY + (Math.random() - 0.5) * 2.6,
          vx: Math.cos(jetAngle) * jetSpeed + (boat.vx || 0) * 0.16,
          vy: Math.sin(jetAngle) * jetSpeed + (boat.vy || 0) * 0.16,
          size: 3.2 + Math.random() * 4.4 * spdRatio,
          grow: 10 + Math.random() * 8,
          age: 0,
          life: 0.24 + Math.random() * 0.28,
          color: '#eff8fa',
          drag: 3.5,
          kind: 'mist',
          alphaScale: 0.36 + spdRatio * 0.22,
        });

        // 2) Translucent chine-sheath side spray fanning off outside hull edge during high-G turns
        const rollAbs = Math.abs(boat.rollAngle || 0);
        const turnStrength = Math.max(rollAbs * 2.15, Math.abs(boat.angularVel || 0) * 0.45);
        if (turnStrength > 0.32 && spdRatio > 0.32 && Math.random() < clamp(turnStrength, 0, 0.92)) {
          if (particles.length >= MAX_PARTICLES) particles.shift();
          const outsideSign = (boat.rollAngle || boat.steer || 1) >= 0 ? -1 : 1;
          const along = -2 + Math.random() * 14;
          const chineX = boat.x + cosH * along + nx * outsideSign * 7.2;
          const chineY = boat.y + sinH * along + ny * outsideSign * 7.2;
          const throwSpd = (42 + Math.random() * 72) * spdRatio * clamp(turnStrength, 0.5, 1.35);
          particles.push({
            x: chineX,
            y: chineY,
            vx: nx * outsideSign * throwSpd + (boat.vx || 0) * 0.36,
            vy: ny * outsideSign * throwSpd + (boat.vy || 0) * 0.36,
            size: 3.6 + Math.random() * 4.8,
            grow: 11 + Math.random() * 7,
            age: 0,
            life: 0.28 + Math.random() * 0.25,
            color: '#f5fbfc',
            drag: 4.3,
            kind: 'mist',
            alphaScale: 0.48,
          });
        }
      }

      sprayAccum.set(boat.id, acc);

      if ((boat.wakeTurbulence || 0) > 0.38 && Math.random() < dt * 9) {
        addRipple(boat.x, boat.y, 24, 'rgba(218, 240, 246, 0.36)', 0.55, 1.3);
      }
    }
  }

  /**
   * Scale-model Class-1 / F1 Offshore RC Deep-V Powerboat:
   * - ZERO cartoon black outlines
   * - Sculpted stepped-chine fiberglass/carbon racing hull with metallic gelcoat shading
   * - Water-line ambient occlusion + faint inverted reflection + dynamic wave-hop cast shadow
   * - Smoked polycarbonate wrap-around canopy with curved specular glare
   * - Rear engine hatch vents, dual anodized trim tabs, pivoting CNC rudder
   * - Ultra-thin flexing carbon whip antenna
   */
  function drawBoat(boat, raceState, effectivePhase, t) {
    const x = boat.x;
    const y = boat.y;
    const heading = boat.heading || 0;
    const speed = Math.hypot(boat.vx || 0, boat.vy || 0);
    const speedRatio = clamp(speed / (PHYSICS.maxSpeed || 295), 0, 1.15);
    const roll = clamp(boat.rollAngle || 0, -0.65, 0.65);
    const bounce = clamp(boat.pitchBounce || 0, -2.5, 3.0);
    const rudder = clamp(boat.rudderAngle || 0, -0.7, 0.7);
    const antennaFlex = clamp(boat.antennaFlex || 0, -1.2, 1.2);

    const primary = boat.primaryColor || '#FF4D2E';
    const accent = boat.accentColor || '#FFD166';
    const hullCol = boat.hullColor || '#F1F5F9';
    const deckCol = boat.deckColor || '#0F172A';

    // Sleek scale offshore proportions
    const halfL = 23.0;
    const halfW = 8.4;
    const bankScaleY = 1 - Math.abs(roll) * 0.16;
    const bankShift = roll * 2.8;
    const hopLift = Math.max(0, bounce);
    const hopScale = 1 + hopLift * 0.032;

    // Trace razor-sharp stepped deep-V offshore powerboat silhouette
    const traceHull = () => {
      ctx.beginPath();
      ctx.moveTo(halfL + 2.5, 0); // needle-pointed offshore bow
      ctx.bezierCurveTo(halfL * 0.62, halfW * 0.78, halfL * 0.12, halfW * 1.05, -halfL * 0.24, halfW * 0.98);
      ctx.lineTo(-halfL * 0.98, halfW * 0.78); // crisp aft chine taper
      ctx.lineTo(-halfL, -halfW * 0.78); // flat racing transom
      ctx.lineTo(-halfL * 0.24, -halfW * 0.98);
      ctx.bezierCurveTo(halfL * 0.12, -halfW * 1.05, halfL * 0.62, -halfW * 0.78, halfL + 2.5, 0);
      ctx.closePath();
    };

    ctx.save();
    ctx.translate(x, y);

    // 1) Faint inverted hull reflection shimmering in the water directly underneath
    ctx.save();
    ctx.translate(SHAD_X * 1.8, SHAD_Y * 2.2 + 2.0);
    ctx.rotate(heading);
    ctx.scale(1.02, bankScaleY * 1.08);
    ctx.globalAlpha = 0.16;
    traceHull();
    ctx.fillStyle = primary;
    ctx.fill();
    ctx.restore();

    // 2) Soft feathered cast water shadow (SE direction, shifts cleanly with pitchBounce wave-hopping!)
    const shadowDist = 4.6 + hopLift * 3.2;
    ctx.save();
    ctx.translate(SHAD_X * shadowDist, SHAD_Y * shadowDist);
    ctx.rotate(heading);
    ctx.scale(1.03, bankScaleY * 1.04);
    traceHull();
    ctx.fillStyle = `rgba(3, 15, 26, ${(0.38 - hopLift * 0.06).toFixed(2)})`;
    ctx.fill();
    ctx.restore();

    // Enter boat local coordinate space
    ctx.save();
    ctx.rotate(heading);
    ctx.scale(hopScale, hopScale * bankScaleY);

    // 3) Subtle water-line ambient occlusion halo beneath hull chines
    traceHull();
    ctx.strokeStyle = 'rgba(4, 22, 34, 0.34)';
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // 4) Luminous mist rooster-tail spray fan directly off surface-piercing prop
    if (speedRatio > 0.16) {
      const plumeLen = 16 + speedRatio * 34 + Math.sin(t * 26 + x * 0.1) * 2.5;
      const plumeGrad = ctx.createLinearGradient(-halfL, 0, -halfL - plumeLen, 0);
      plumeGrad.addColorStop(0.0, `rgba(248, 253, 255, ${(0.48 + speedRatio * 0.34).toFixed(2)})`);
      plumeGrad.addColorStop(0.4, `rgba(205, 238, 246, ${(0.28 * speedRatio).toFixed(2)})`);
      plumeGrad.addColorStop(1.0, 'rgba(190, 232, 242, 0)');
      ctx.fillStyle = plumeGrad;
      ctx.beginPath();
      ctx.moveTo(-halfL + 1, -1.8);
      ctx.quadraticCurveTo(-halfL - plumeLen * 0.52, -4.8 * speedRatio, -halfL - plumeLen, 0);
      ctx.quadraticCurveTo(-halfL - plumeLen * 0.52, 4.8 * speedRatio, -halfL + 1, 1.8);
      ctx.closePath();
      ctx.fill();
    }

    // 5) Transom hardware: Dual anodized aluminum trim tabs + CNC pivoting outboard rudder
    ctx.fillStyle = '#64748b';
    ctx.fillRect(-halfL - 2.6, -halfW * 0.62, 2.8, 3.0);
    ctx.fillRect(-halfL - 2.6, halfW * 0.62 - 3.0, 2.8, 3.0);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(-halfL - 2.2, -halfW * 0.62, 1.2, 2.6);
    ctx.fillRect(-halfL - 2.2, halfW * 0.62 - 2.6, 1.2, 2.6);

    ctx.save();
    ctx.translate(-halfL + 0.3, 0);
    ctx.rotate(-rudder * 0.88);
    // Anodized titanium rudder blade
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(-7.2, -0.85, 6.5, 1.7);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(-6.8, -0.65, 5.4, 0.6);
    // Sleek sculpted carbon-composite drive cowling
    ctx.fillStyle = '#182230';
    ctx.beginPath();
    safeRoundRect(ctx, -4.4, -2.6, 5.2, 5.2, 1.4);
    ctx.fill();
    ctx.fillStyle = primary;
    ctx.fillRect(-3.4, -1.5, 2.6, 3.0);
    ctx.restore();

    // 6) Sculpted Fiberglass Gelcoat Hull with Dynamic Sun-Angle + Banking Lighting
    // Transform world sun direction into boat-local cross-axis for authentic metallic reflection!
    const localSunCross = -Math.sin(heading) * SUN_X + Math.cos(heading) * SUN_Y;
    const litTop = clamp(0.5 + localSunCross * 0.32 + roll * 0.45, 0.15, 0.85);

    traceHull();
    const hullGrad = ctx.createLinearGradient(0, -halfW, 0, halfW);
    hullGrad.addColorStop(0.0, '#ffffff');
    hullGrad.addColorStop(litTop, hullCol);
    hullGrad.addColorStop(1.0, '#9aa8b8');
    ctx.fillStyle = hullGrad;
    ctx.fill();

    // Clip precision motorsport livery & shading inside hull silhouette
    ctx.save();
    ctx.clip();

    // Swept Class-1 motorsport side-flanks & aerodynamic bow spear
    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.moveTo(halfL + 2.5, 0);
    ctx.lineTo(halfL * 0.22, halfW * 1.02);
    ctx.lineTo(-halfL - 1, halfW * 0.96);
    ctx.lineTo(-halfL - 1, halfW * 0.42);
    ctx.lineTo(halfL * 0.42, 0);
    ctx.lineTo(-halfL - 1, -halfW * 0.42);
    ctx.lineTo(-halfL - 1, -halfW * 0.96);
    ctx.lineTo(halfL * 0.22, -halfW * 1.02);
    ctx.closePath();
    ctx.fill();

    // Dark carbon-fiber recessed aft deck & engine bay surround
    ctx.fillStyle = deckCol;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.28, 0);
    ctx.lineTo(-halfL * 0.12, halfW * 0.5);
    ctx.lineTo(-halfL * 0.95, halfW * 0.44);
    ctx.lineTo(-halfL * 0.95, -halfW * 0.44);
    ctx.lineTo(-halfL * 0.12, -halfW * 0.5);
    ctx.closePath();
    ctx.fill();

    // Razor-sharp metallic accent pinstripe livery
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.72, 0);
    ctx.lineTo(-halfL * 0.96, halfW * 0.48);
    ctx.moveTo(halfL * 0.72, 0);
    ctx.lineTo(-halfL * 0.96, -halfW * 0.48);
    ctx.stroke();

    // Sculpted foredeck center V-crease specular highlight (shifts naturally with rollAngle!)
    const sheenGrad = ctx.createLinearGradient(0, -halfW + bankShift, 0, halfW + bankShift);
    sheenGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.36)');
    sheenGrad.addColorStop(0.42, 'rgba(255, 255, 255, 0.08)');
    sheenGrad.addColorStop(0.55, 'rgba(8, 16, 26, 0.05)');
    sheenGrad.addColorStop(1.0, 'rgba(8, 16, 26, 0.34)');
    ctx.fillStyle = sheenGrad;
    ctx.fillRect(-halfL - 2, -halfW - 2, halfL * 2 + 6, halfW * 2 + 4);

    // Subtle stepped-chine specular rim highlight along sunward gunwale
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    ctx.moveTo(halfL + 1.5, 0);
    ctx.bezierCurveTo(halfL * 0.55, -halfW * 0.75, halfL * 0.1, -halfW * 0.96, -halfL * 0.92, -halfW * 0.74);
    ctx.stroke();

    ctx.restore(); // end hull clip

    // 7) Rear Engine Hatch Cooling Louvers (subtle motorsport craftsmanship)
    const cy = bankShift * 0.28;
    ctx.strokeStyle = 'rgba(220, 232, 242, 0.25)';
    ctx.lineWidth = 0.7;
    for (let v = 0; v < 3; v++) {
      const vx = -halfL * 0.62 - v * 2.5;
      ctx.beginPath();
      ctx.moveTo(vx, cy - 2.4);
      ctx.lineTo(vx - 0.8, cy + 2.4);
      ctx.stroke();
    }

    // 8) Aerodynamic Smoked Polycarbonate Racing Canopy with Realistic Curved Specular Glare
    const canopyGrad = ctx.createLinearGradient(halfL * 0.28, cy - 3.6, -halfL * 0.55, cy + 3.6);
    canopyGrad.addColorStop(0.0, '#365066');
    canopyGrad.addColorStop(0.32, '#101c28');
    canopyGrad.addColorStop(0.75, '#070e16');
    canopyGrad.addColorStop(1.0, '#1e2c3a');
    ctx.fillStyle = canopyGrad;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.32, cy);
    ctx.bezierCurveTo(halfL * 0.18, cy + 3.9, -halfL * 0.34, cy + 3.6, -halfL * 0.52, cy + 1.9);
    ctx.lineTo(-halfL * 0.52, cy - 1.9);
    ctx.bezierCurveTo(-halfL * 0.34, cy - 3.6, halfL * 0.18, cy - 3.9, halfL * 0.32, cy);
    ctx.closePath();
    ctx.fill();

    // Crisp curved glass specular reflection streak across canopy
    const glareGrad = ctx.createLinearGradient(halfL * 0.26, cy - 2.6, -halfL * 0.22, cy - 0.5);
    glareGrad.addColorStop(0.0, 'rgba(235, 248, 255, 0.78)');
    glareGrad.addColorStop(0.5, 'rgba(186, 224, 244, 0.22)');
    glareGrad.addColorStop(1.0, 'rgba(186, 224, 244, 0)');
    ctx.fillStyle = glareGrad;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.24, cy - 0.3);
    ctx.bezierCurveTo(halfL * 0.12, cy - 2.8, -halfL * 0.14, cy - 2.6, -halfL * 0.26, cy - 1.5);
    ctx.quadraticCurveTo(-halfL * 0.04, cy - 1.2, halfL * 0.24, cy - 0.3);
    ctx.closePath();
    ctx.fill();

    // 9) Clean Motorsport Bow Stencil Number
    if (boat.number) {
      ctx.save();
      ctx.translate(halfL * 0.56, 0);
      ctx.rotate(Math.PI * 0.5);
      ctx.fillStyle = 'rgba(15, 23, 36, 0.85)';
      ctx.font = '800 5.8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(boat.number), 0, 0.4);
      ctx.restore();
    }

    // 10) Delicate Ultra-Thin Flexing Carbon RC Whip Antenna + minimalist satin ribbon
    const antBaseX = -halfL * 0.50;
    const antBaseY = cy - 1.2;
    const bendBack = 9.5 + speedRatio * 10.5;
    const bendSide = antennaFlex * 8.5 + Math.sin(t * 17 + x * 0.05) * (0.8 + speedRatio * 1.2);
    const tipX = antBaseX - bendBack;
    const tipY = antBaseY + bendSide;

    ctx.strokeStyle = 'rgba(22, 30, 40, 0.82)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(antBaseX, antBaseY);
    ctx.quadraticCurveTo(antBaseX - bendBack * 0.48, antBaseY + bendSide * 0.25, tipX, tipY);
    ctx.stroke();

    const flutter = Math.sin(t * 24 + (boat.isPlayer ? 0 : 2.3)) * 1.4;
    ctx.fillStyle = boat.isPlayer ? '#e8cb7e' : accent;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 5.2, tipY - 1.4 + flutter);
    ctx.lineTo(tipX - 4.4, tipY + 1.2 + flutter * 0.6);
    ctx.closePath();
    ctx.fill();

    ctx.restore(); // end boat local frame

    // 11) Refined Telemetry Player / Boat Identifier (sleek motorsport style, never bulky or cartoony)
    const phase = effectivePhase || raceState?.phase || 'menu';
    if (boat.isPlayer) {
      // Minimalist broken telemetry bracket arcs framing player boat
      const ringAlpha = phase === 'racing' ? 0.32 : 0.55;
      const rArc = 26.5;
      ctx.strokeStyle = `rgba(232, 203, 126, ${ringAlpha})`;
      ctx.lineWidth = 1.25;
      for (let q = 0; q < 4; q++) {
        const a0 = q * Math.PI * 0.5 + 0.35;
        ctx.beginPath();
        ctx.arc(0, 0, rArc, a0, a0 + 0.85);
        ctx.stroke();
      }

      const raceTime = raceState?.raceTime ?? 0;
      const tagAlpha = phase === 'racing'
        ? clamp(1 - (raceTime - 2.0) / 2.8, 0.22, 1)
        : 0.92;

      if (tagAlpha > 0.30) {
        ctx.save();
        ctx.globalAlpha = tagAlpha;
        ctx.translate(0, -33);
        ctx.fillStyle = 'rgba(7, 16, 26, 0.78)';
        ctx.strokeStyle = 'rgba(232, 203, 126, 0.65)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        safeRoundRect(ctx, -18, -8, 36, 14.5, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#f3df9e';
        ctx.font = '700 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('YOU', 0, -0.5);
        ctx.restore();
      } else {
        // Minimal crisp champagne pointer pip during active race
        ctx.save();
        ctx.translate(0, -29);
        ctx.fillStyle = 'rgba(232, 203, 126, 0.85)';
        ctx.beginPath();
        ctx.moveTo(0, 3.5);
        ctx.lineTo(-3.6, -2.5);
        ctx.lineTo(3.6, -2.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    } else if (boat.number) {
      // Ultra-minimal smoked glass number pip above AI racers
      ctx.save();
      ctx.translate(0, -25);
      ctx.fillStyle = 'rgba(7, 16, 26, 0.58)';
      ctx.beginPath();
      safeRoundRect(ctx, -9.5, -6, 19, 11, 3.5);
      ctx.fill();
      ctx.fillStyle = 'rgba(226, 236, 245, 0.86)';
      ctx.font = '600 7.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(boat.number), 0, -0.2);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Render misty graduated spray puffs & celebratory regatta confetti.
   */
  function drawParticlesAndConfetti() {
    ctx.save();

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const normAge = clamp(p.age / p.life, 0, 1);
      const alpha = (1 - normAge) * (1 - normAge) * (p.alphaScale ?? 0.5);
      if (alpha < 0.01) continue;

      const rad = p.size + normAge * (p.grow || 6);
      if (mistSprite) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(mistSprite, p.x - rad, p.y - rad, rad * 2, rad * 2);
      } else {
        ctx.globalAlpha = alpha * 0.7;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad * 0.55, 0, TWO_PI);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    for (let i = 0; i < confetti.length; i++) {
      const c = confetti[i];
      const alpha = clamp(1 - Math.max(0, c.age - c.life * 0.7) / (c.life * 0.3), 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(1, Math.cos(c.tilt));
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w * 0.5, -c.h * 0.5, c.w, c.h);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Photorealistic Foreground RC Yacht Club Weathered Cedar Pier & Rocky Coastal Beach (y ≈ 915..1000+),
   * seamlessly extending left/right/bottom with zero black bars.
   */
  function drawShorelineAndPier(visMinX, visMaxX, visMaxY, t) {
    const startX = Math.floor(visMinX / 40) * 40 - 40;
    const endX = visMaxX + 80;
    const bottomY = Math.max(WORLD_HEIGHT + 40, visMaxY + 40);

    ctx.save();

    // 1) Shallow sandy seabed softly visible just off the beach edge
    const seabedGrad = ctx.createLinearGradient(0, SHORELINE_Y - 26, 0, SHORELINE_Y + 14);
    seabedGrad.addColorStop(0, 'rgba(135, 165, 146, 0)');
    seabedGrad.addColorStop(0.7, 'rgba(155, 166, 138, 0.32)');
    seabedGrad.addColorStop(1, 'rgba(150, 136, 108, 0.65)');
    ctx.fillStyle = seabedGrad;
    ctx.fillRect(startX, SHORELINE_Y - 26, endX - startX, 42);

    // 2) Wet darkened shoreline sand -> warm natural speckled coastal beach
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(startX, bottomY);
    for (let x = startX; x <= endX; x += 36) {
      const wave = Math.sin(x * 0.0085) * 5.5 + Math.cos(x * 0.021) * 2.6;
      ctx.lineTo(x, SHORELINE_Y + 6 + wave);
    }
    ctx.lineTo(endX, bottomY);
    ctx.closePath();

    const beachGrad = ctx.createLinearGradient(0, SHORELINE_Y, 0, WORLD_HEIGHT + 20);
    beachGrad.addColorStop(0.00, '#7d6e54'); // wet tide-line sand
    beachGrad.addColorStop(0.14, '#b5a282'); // damp coastal sand
    beachGrad.addColorStop(0.32, '#cbb894'); // dry sunlit coastal sand
    beachGrad.addColorStop(0.70, '#b39e7a');
    beachGrad.addColorStop(1.00, '#85755a');
    ctx.fillStyle = beachGrad;
    ctx.fill();

    if (sandGrainPattern) {
      ctx.clip();
      ctx.globalAlpha = 0.68;
      ctx.fillStyle = sandGrainPattern;
      ctx.fillRect(startX, SHORELINE_Y, endX - startX, bottomY - SHORELINE_Y);
    }
    ctx.restore();

    // 3) Coastal dune-grass & weathered rocky embankment along bottom edge
    ctx.beginPath();
    ctx.moveTo(startX, bottomY);
    for (let x = startX; x <= endX; x += 44) {
      const y = SHORELINE_Y + 46 + Math.sin(x * 0.011 + 1.3) * 4.5 + Math.cos(x * 0.029) * 2.0;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(endX, bottomY);
    ctx.closePath();
    const duneGrad = ctx.createLinearGradient(0, SHORELINE_Y + 40, 0, WORLD_HEIGHT + 12);
    duneGrad.addColorStop(0, '#536844');
    duneGrad.addColorStop(0.45, '#374d32');
    duneGrad.addColorStop(1, '#1e2e1f');
    ctx.fillStyle = duneGrad;
    ctx.fill();

    // Organic coastal boulder clusters tucked naturally along the beach (leaving open sandy stretches)
    const pier = cachedPier || { x: WORLD_WIDTH * 0.5 - 76, y: SHORELINE_Y - 7, width: 152, height: 94 };
    for (let x = startX + 40; x < endX; x += 210) {
      const clusterSeed = hash2(x, 19.4);
      if (clusterSeed < 0.25) continue; // leave natural open sandy cove gaps
      const cxBase = x + (clusterSeed - 0.5) * 95;
      if (cxBase > pier.x - 42 && cxBase < pier.x + pier.width + 42) continue;

      const rockCount = 2 + Math.floor(hash2(x, 41.2) * 3);
      for (let k = 0; k < rockCount; k++) {
        const rx = cxBase + (hash2(x + k, 3.1) - 0.5) * 44;
        const ry = SHORELINE_Y + 22 + hash2(x + k, 7.2) * 22;
        const rr = (k === 0 ? 9 : 4.5) + hash2(x + k, 9.7) * (k === 0 ? 8 : 6);
        const rot = hash2(x + k, 1.4) * 1.2 - 0.6;

        // Cast shadow SE
        ctx.fillStyle = 'rgba(18, 22, 20, 0.30)';
        ctx.beginPath();
        ctx.ellipse(rx + SHAD_X * 3.0, ry + SHAD_Y * 3.0, rr * 1.12, rr * 0.68, rot, 0, TWO_PI);
        ctx.fill();

        // Faceted directional-lit coastal granite boulder
        const bg = ctx.createLinearGradient(rx - rr, ry - rr, rx + rr, ry + rr);
        bg.addColorStop(0, '#a2a098');
        bg.addColorStop(0.55, '#686b6a');
        bg.addColorStop(1, '#363c3f');
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.ellipse(rx, ry, rr, rr * 0.64, rot, 0, TWO_PI);
        ctx.fill();
      }
    }

    // Subtle organic coastal grass tufts softening the dune edge transition
    for (let x = startX + 18; x < endX; x += 48) {
      const gx = x + hash2(x, 5.7) * 24;
      if (gx > pier.x - 14 && gx < pier.x + pier.width + 14) continue;
      const gy = SHORELINE_Y + 46 + Math.sin(gx * 0.011 + 1.3) * 4.5;
      const gr = 5 + hash2(x, 8.3) * 6;
      ctx.fillStyle = hash2(x, 2.9) > 0.5 ? 'rgba(68, 90, 54, 0.58)' : 'rgba(46, 66, 42, 0.62)';
      ctx.beginPath();
      ctx.ellipse(gx, gy, gr * 1.3, gr * 0.65, 0, 0, TWO_PI);
      ctx.fill();
    }

    // 4) Photorealistic Weathered Cedar RC Yacht Club Pier
    const px = pier.x;
    const py = Math.min(pier.y, SHORELINE_Y - 7);
    const pw = pier.width;
    const ph = Math.max(pier.height, bottomY - py);

    // Submerged timber pilings visible underwater + refracted underwater piling shadows
    const pilingPosts = [
      { x: px + 7.5, y: py + 6.5 },
      { x: px + pw * 0.36, y: py + 6.5 },
      { x: px + pw * 0.64, y: py + 6.5 },
      { x: px + pw - 7.5, y: py + 6.5 },
      { x: px + 7.5, y: py + 44 },
      { x: px + pw - 7.5, y: py + 44 },
    ];

    // Deep realistic cast shadow of pier deck onto the turquoise shallows & sand
    const pierShad = ctx.createLinearGradient(px + pw, py, px + pw + 18, py + 16);
    pierShad.addColorStop(0, 'rgba(4, 18, 28, 0.44)');
    pierShad.addColorStop(1, 'rgba(4, 18, 28, 0.14)');
    ctx.fillStyle = pierShad;
    ctx.beginPath();
    safeRoundRect(ctx, px + SHAD_X * 11, py + SHAD_Y * 11, pw + 2, ph + 10, 4);
    ctx.fill();

    // Subtle underwater piling silhouettes & gentle water-line foam around front pilings
    for (let i = 0; i < pilingPosts.length; i++) {
      const pp = pilingPosts[i];
      if (pp.y < SHORELINE_Y + 10) {
        // Submerged piling shadow into sandy shallow bottom
        ctx.fillStyle = 'rgba(10, 26, 32, 0.32)';
        ctx.beginPath();
        ctx.ellipse(pp.x + SHAD_X * 5, pp.y + SHAD_Y * 7, 5.5, 8.0, 0.35, 0, TWO_PI);
        ctx.fill();

        // Delicate water-line lap ring
        const ring = 8.2 + Math.sin(t * 2.1 + i) * 1.1;
        ctx.strokeStyle = 'rgba(226, 245, 248, 0.32)';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, ring, 0, TWO_PI);
        ctx.stroke();
      }
    }

    // Draw pre-cached weathered wood-grain cedar deck
    if (pierDeckCanvas) {
      ctx.drawImage(pierDeckCanvas, px, py);
    } else {
      ctx.fillStyle = '#7c654e';
      ctx.fillRect(px, py, pw, ph);
    }

    // Weathered timber piling post tops with cast deck shadows & growth-ring grain
    for (let i = 0; i < pilingPosts.length; i++) {
      const pp = pilingPosts[i];
      ctx.fillStyle = 'rgba(16, 12, 8, 0.42)';
      ctx.beginPath();
      ctx.arc(pp.x + SHAD_X * 3.2, pp.y + SHAD_Y * 3.2, 5.6, 0, TWO_PI);
      ctx.fill();

      const pg = ctx.createRadialGradient(pp.x - 1.8, pp.y - 1.8, 0.8, pp.x, pp.y, 5.6);
      pg.addColorStop(0, '#9e8870');
      pg.addColorStop(0.65, '#665341');
      pg.addColorStop(1, '#3b2f24');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 5.4, 0, TWO_PI);
      ctx.fill();

      // Subtle end-grain ring
      ctx.strokeStyle = 'rgba(42, 32, 22, 0.35)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 3.0, 0, TWO_PI);
      ctx.stroke();
    }

    // Brushed stainless-steel marine horn cleats
    const cleats = [px + pw * 0.24, px + pw * 0.76];
    for (let i = 0; i < cleats.length; i++) {
      const cx = cleats[i];
      const cy = py + 11.5;
      ctx.fillStyle = 'rgba(12, 10, 8, 0.36)';
      ctx.fillRect(cx - 5.5, cy - 0.5, 12, 3.2);
      const metal = ctx.createLinearGradient(cx - 6, cy - 2, cx + 6, cy + 2);
      metal.addColorStop(0, '#e2e8f0');
      metal.addColorStop(0.5, '#94a3b8');
      metal.addColorStop(1, '#475569');
      ctx.fillStyle = metal;
      ctx.beginPath();
      safeRoundRect(ctx, cx - 6, cy - 1.3, 12, 2.6, 1);
      ctx.fill();
      ctx.fillStyle = '#64748b';
      ctx.fillRect(cx - 2.6, cy - 2.4, 5.2, 4.8);
    }

    // Subtle natural flemished braided hemp mooring line
    const ropeX = px + Math.min(30, pw * 0.21);
    const ropeY = py + 31;
    ctx.strokeStyle = 'rgba(18, 14, 10, 0.26)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.arc(ropeX + 1.2, ropeY + 1.4, 7.6, 0, TWO_PI);
    ctx.stroke();

    ctx.strokeStyle = '#bfa67e';
    ctx.lineWidth = 1.8;
    for (let r = 2.6; r <= 8.2; r += 2.0) {
      ctx.beginPath();
      ctx.arc(ropeX, ropeY, r, 0, TWO_PI);
      ctx.stroke();
    }

    // Sleek Anodized Aluminum RC Pit Stand / Telemetry Case (realistic hardware, zero toy look!)
    const caseW = 24;
    const caseH = 14;
    const boxX = px + pw * 0.5 - caseW * 0.5;
    const boxY = py + 23;
    ctx.fillStyle = 'rgba(12, 10, 8, 0.38)';
    ctx.fillRect(boxX + 2.0, boxY + 2.2, caseW, caseH);

    const aluGrad = ctx.createLinearGradient(boxX, boxY, boxX + caseW, boxY + caseH);
    aluGrad.addColorStop(0, '#5a6674');
    aluGrad.addColorStop(0.5, '#333e4b');
    aluGrad.addColorStop(1, '#1b2430');
    ctx.fillStyle = aluGrad;
    ctx.beginPath();
    safeRoundRect(ctx, boxX, boxY, caseW, caseH, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(205, 218, 232, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Machined lid ribs + tiny recessed cyan telemetry LED
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(boxX + 4, boxY + 4.5);
    ctx.lineTo(boxX + caseW - 4, boxY + 4.5);
    ctx.moveTo(boxX + 4, boxY + 9.5);
    ctx.lineTo(boxX + caseW - 4, boxY + 9.5);
    ctx.stroke();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(boxX + caseW - 4.5, boxY + 7, 1.1, 0, TWO_PI);
    ctx.fill();

    // Subtle coiled spare mooring bollard / aluminum dock cleat box on right side
    const rightX = px + pw - Math.min(28, pw * 0.2);
    const rightY = py + 31;
    ctx.fillStyle = 'rgba(12, 10, 8, 0.34)';
    ctx.beginPath();
    ctx.arc(rightX + 1.6, rightY + 1.8, 7.2, 0, TWO_PI);
    ctx.fill();
    const ringGrad = ctx.createRadialGradient(rightX - 2, rightY - 2, 1, rightX, rightY, 7.2);
    ringGrad.addColorStop(0, '#e2e8f0');
    ringGrad.addColorStop(0.6, '#b8c4cf');
    ringGrad.addColorStop(1, '#64748b');
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.arc(rightX, rightY, 5.8, 0, TWO_PI);
    ctx.stroke();
    ctx.strokeStyle = '#b93829';
    ctx.lineWidth = 3.2;
    for (let q = 0; q < 4; q++) {
      const a0 = q * Math.PI * 0.5 + 0.18;
      ctx.beginPath();
      ctx.arc(rightX, rightY, 5.8, a0, a0 + 0.36);
      ctx.stroke();
    }

    // Realistic Fabric Maritime Windsock on galvanized pier mast
    const poleX = px + 14;
    const poleY = py + 13;
    const windAngle = -0.16 + Math.sin(t * 3.1) * 0.12;
    const flutter = Math.sin(t * 8.8) * 2.6;

    ctx.save();
    ctx.translate(poleX, poleY);

    // Soft cast shadow of windsock across weathered planks
    ctx.strokeStyle = 'rgba(12, 14, 14, 0.28)';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(SHAD_X * 4, SHAD_Y * 4);
    ctx.lineTo(SHAD_X * 4 + Math.cos(windAngle) * 24, SHAD_Y * 4 + Math.sin(windAngle) * 24);
    ctx.stroke();

    // Translucent ripstop nylon segmented windsock (muted maritime orange & weathered off-white)
    ctx.rotate(windAngle);
    const sockSegs = 4;
    const segL = 6.2;
    for (let s = 0; s < sockSegs; s++) {
      const x0 = 2.8 + s * segL;
      const x1 = x0 + segL;
      const w0 = 3.8 - s * 0.62;
      const w1 = 3.8 - (s + 1) * 0.62;
      const y0 = Math.sin(t * 8.8 - s * 0.85) * (s * 0.78);
      const y1 = Math.sin(t * 8.8 - (s + 1) * 0.85) * ((s + 1) * 0.78);

      const segGrad = ctx.createLinearGradient(x0, y0 - w0, x0, y0 + w0);
      if (s % 2 === 0) {
        segGrad.addColorStop(0, '#e87338');
        segGrad.addColorStop(0.55, '#c8501c');
        segGrad.addColorStop(1, '#7a2e0e');
      } else {
        segGrad.addColorStop(0, '#f3f0e8');
        segGrad.addColorStop(0.6, '#d3cfc4');
        segGrad.addColorStop(1, '#8c8982');
      }
      ctx.fillStyle = segGrad;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - w0);
      ctx.lineTo(x1, y1 - w1);
      ctx.lineTo(x1, y1 + w1);
      ctx.lineTo(x0, y0 + w0);
      ctx.closePath();
      ctx.fill();
    }

    // Subtle fabric tail flicker
    ctx.strokeStyle = 'rgba(200, 80, 28, 0.55)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(27.5, flutter * 0.5);
    ctx.lineTo(31.5, flutter * 0.78);
    ctx.stroke();

    // Galvanized steel mast swivel cap
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  /**
   * Subtle atmospheric coastal cloud shadows & delicate high-altitude seagulls.
   */
  function drawAtmosphere(t, dt) {
    ctx.save();

    // 1) Soft diffused cloud shadows gliding gently across the bay
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      if (c.x - c.rx > WORLD_WIDTH + 240) {
        c.x = -c.rx - 200;
        c.y = 110 + hash2(t, i) * 520;
      }

      const cg = ctx.createRadialGradient(c.x, c.y, c.rx * 0.12, c.x, c.y, c.rx);
      cg.addColorStop(0, `rgba(3, 14, 26, ${c.alpha})`);
      cg.addColorStop(0.55, `rgba(3, 14, 26, ${(c.alpha * 0.52).toFixed(3)})`);
      cg.addColorStop(1, 'rgba(3, 14, 26, 0)');
      ctx.fillStyle = cg;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(1, c.ry / c.rx);
      ctx.beginPath();
      ctx.arc(0, 0, c.rx, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }

    // 2) Delicate realistic coastal gulls soaring high above the bay
    for (let i = 0; i < seagulls.length; i++) {
      const g = seagulls[i];
      const ang = t * g.speed + g.phase;
      const gx = g.cx + Math.cos(ang) * g.rx;
      const gy = g.cy + Math.sin(ang) * g.ry;
      const vx = -Math.sin(ang) * g.rx * g.speed;
      const vy = Math.cos(ang) * g.ry * g.speed;
      const heading = Math.atan2(vy, vx);
      const flap = Math.sin(t * 4.8 + g.wingPhase) * 0.42 + 0.58;
      const wingSpan = 8.8 * g.scale * (0.7 + flap * 0.32);
      const wingSweep = 4.0 * g.scale;

      // Faint distant gull shadow on water below (offset toward SE sun shadow)
      ctx.save();
      ctx.translate(gx + SHAD_X * 48, gy + SHAD_Y * 48);
      ctx.rotate(heading);
      ctx.strokeStyle = 'rgba(3, 14, 24, 0.11)';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-wingSweep, -wingSpan * 0.68);
      ctx.quadraticCurveTo(1, -wingSpan * 0.28, 3, 0);
      ctx.quadraticCurveTo(1, wingSpan * 0.28, -wingSweep, wingSpan * 0.68);
      ctx.stroke();
      ctx.restore();

      // Gull body & pale-grey sunlit wings
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(heading);
      ctx.strokeStyle = 'rgba(242, 246, 248, 0.88)';
      ctx.lineWidth = 1.8 * g.scale;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-wingSweep, -wingSpan);
      ctx.quadraticCurveTo(2.0, -wingSpan * 0.42, 3.8 * g.scale, 0);
      ctx.quadraticCurveTo(2.0, wingSpan * 0.42, -wingSweep, wingSpan);
      ctx.stroke();

      // Dark slate primary wingtips
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.72)';
      ctx.lineWidth = 1.3 * g.scale;
      ctx.beginPath();
      ctx.moveTo(-wingSweep * 0.62, -wingSpan * 0.78);
      ctx.lineTo(-wingSweep, -wingSpan);
      ctx.moveTo(-wingSweep * 0.62, wingSpan * 0.78);
      ctx.lineTo(-wingSweep, wingSpan);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function updateParticles(dt) {
    if (dt <= 0) return;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        continue;
      }
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.age += dt;
      if (r.age >= r.duration) {
        ripples.splice(i, 1);
      }
    }

    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i];
      c.age += dt;
      if (c.age >= c.life) {
        confetti.splice(i, 1);
        continue;
      }
      c.vy += 150 * dt;
      c.vx *= Math.exp(-0.9 * dt);
      c.x += (c.vx + Math.sin(c.tilt) * 26) * dt;
      c.y += c.vy * dt;
      c.rot += c.rotVel * dt;
      c.tilt += c.tiltVel * dt;
    }

    if (screenFlash.alpha > 0) {
      screenFlash.alpha = Math.max(0, screenFlash.alpha - screenFlash.decay * dt);
    }
    if (goLightPulse > 0) {
      goLightPulse = Math.max(0, goLightPulse - 1.6 * dt);
    }
  }

  function render(state = {}, dt = 1 / 60) {
    if (!ctx) return;

    const safeDt = clamp(typeof dt === 'number' && Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
    internalTime = typeof state.time === 'number' ? state.time : internalTime + safeDt;
    const t = internalTime;

    const { course, boats, raceState } = state;

    const courseKey = course ? (course.seed ?? course.name ?? 'course') : null;
    if (course !== cachedCourseRef || courseKey !== cachedCourseKey) {
      rebuildCourseCache(course);
      particles.length = 0;
      ripples.length = 0;
      confetti.length = 0;
      sprayAccum.clear();
    }

    const effectivePhase = state.cameraMode === 'title' ? 'menu' : (raceState?.phase || 'menu');
    if (effectivePhase !== prevBoatPhase) {
      if (effectivePhase === 'racing' && prevBoatPhase === 'countdown') {
        goLightPulse = 1.4;
      }
      prevBoatPhase = effectivePhase;
    }

    emitBoatParticles(boats, safeDt);
    updateParticles(safeDt);

    const visMinX = -offsetX / scale;
    const visMinY = -offsetY / scale;
    const visMaxX = (viewW - offsetX) / scale;
    const visMaxY = (viewH - offsetY) / scale;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Layer 0–2: Photorealistic depth-graded coastal ocean + normal-lit wave swells + sun-path glints + shallow caustics
    drawOceanBase(visMinX, visMinY, visMaxX, visMaxY, t);

    // Layer 3: Subtle telemetry course guide & Start/Finish Committee RIB gate
    if (course) {
      drawRaceCourseLane(course, t);
      drawStartFinishLineAndGantry(course, raceState, effectivePhase, t);
    }

    // Layer 4: Organic lace-foam surf & expanding ripples
    drawShorelineFoam(t, visMinX, visMaxX);
    drawRipples();

    // Layer 5: Layered aerated turquoise + feathered lace-white boat V-wakes
    drawBoatWakes(boats, t);

    // Layer 6: Minimal telemetry next-buoy beacon & heading chevron
    if (course && boats) {
      drawActiveBuoyBeacon(course, boats, raceState, effectivePhase, t);
    }

    // Layer 7: Aerial islands, multi-tuft trees, basalt rocks, architectural lighthouse, & moored yachts
    drawIslandsAndLighthouses(t);
    if (course) {
      drawSpectatorBoats(course, t);
    }

    // Layer 8: Matte-gloss 3D marine racing buoys & spar gate buoys
    if (course) {
      drawBuoys(course, boats, t);
    }

    // Layer 9: Scale-model Class-1 offshore RC powerboats (player drawn last)
    if (boats && boats.length > 0) {
      for (let i = 0; i < boats.length; i++) {
        if (!boats[i].isPlayer) drawBoat(boats[i], raceState, effectivePhase, t);
      }
      for (let i = 0; i < boats.length; i++) {
        if (boats[i].isPlayer) drawBoat(boats[i], raceState, effectivePhase, t);
      }
    }

    // Layer 10: Graduated misty spray plumes & regatta confetti
    drawParticlesAndConfetti();

    // Layer 11: Foreground weathered cedar RC Yacht Club Pier & rocky coastal shoreline
    drawShorelineAndPier(visMinX, visMaxX, visMaxY, t);

    // Layer 12: Atmospheric cloud shadows & delicate coastal gulls
    drawAtmosphere(t, safeDt);

    ctx.restore(); // end world transform

    // Layer 13: Subtle photographic golden-afternoon lens warmth & disciplined edge vignette
    const sunGlow = ctx.createRadialGradient(
      viewW * 0.06,
      viewH * 0.03,
      10,
      viewW * 0.08,
      viewH * 0.04,
      Math.max(viewW, viewH) * 0.58
    );
    sunGlow.addColorStop(0, 'rgba(255, 244, 214, 0.09)');
    sunGlow.addColorStop(0.5, 'rgba(255, 240, 205, 0.025)');
    sunGlow.addColorStop(1, 'rgba(255, 240, 205, 0)');
    ctx.fillStyle = sunGlow;
    ctx.fillRect(0, 0, viewW, viewH);

    // Subtle natural camera vignette anchoring focus on the bay
    const vig = ctx.createRadialGradient(
      viewW * 0.5,
      viewH * 0.5,
      Math.min(viewW, viewH) * 0.42,
      viewW * 0.5,
      viewH * 0.5,
      Math.max(viewW, viewH) * 0.78
    );
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(3, 12, 22, 0.24)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, viewW, viewH);

    if (screenFlash.alpha > 0.005) {
      ctx.save();
      ctx.globalAlpha = screenFlash.alpha;
      const edgeGrad = ctx.createRadialGradient(
        viewW * 0.5,
        viewH * 0.5,
        Math.min(viewW, viewH) * 0.36,
        viewW * 0.5,
        viewH * 0.5,
        Math.max(viewW, viewH) * 0.72
      );
      edgeGrad.addColorStop(0, 'rgba(0,0,0,0)');
      edgeGrad.addColorStop(1, screenFlash.color);
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.restore();
    }

    ctx.restore();
  }

  resize();

  return {
    resize,
    render,
    spawnSplash,
    triggerEffect,
  };
}
