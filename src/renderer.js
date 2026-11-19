import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SHORELINE_Y,
  PHYSICS,
} from './constants.js';

const TWO_PI = Math.PI * 2;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Deterministic pseudo-random helper for organic texture & sparkle placement
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
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

/**
 * Generate a seamless 256x256 sunlit underwater caustic web pattern tile.
 * Drawn twice with opposing drift for lush, zero-cost animated ocean caustics.
 */
function buildCausticsTile() {
  const size = 256;
  const tile = createOffscreenCanvas(size, size);
  if (!tile) return null;
  const ctx = tile.getContext('2d');
  if (!ctx) return null;

  // Deterministic Voronoi-style cell centers tiled seamlessly across 256x256
  const cellCount = 26;
  const pts = [];
  for (let i = 0; i < cellCount; i++) {
    pts.push({
      x: hash2(i, 1.37) * size,
      y: hash2(i, 7.91) * size,
    });
  }

  // Render bright caustic ridges where nearest-two cell distances are nearly equal
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
      // Sharp glowing filament along Voronoi ridge
      const intensity = clamp(1 - edge / 9.5, 0, 1);
      const ridge = intensity * intensity * intensity;
      const idx = (y * size + x) * 4;
      data[idx] = 170;
      data[idx + 1] = 244;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(ridge * 210);
    }
  }
  ctx.putImageData(img, 0, 0);
  return tile;
}

/**
 * Normalize an island or rock polygon into absolute world coordinates.
 */
function getWorldPolygon(obj, fallbackPoints = 14) {
  const raw = obj.polygon || obj.points;
  if (Array.isArray(raw) && raw.length >= 3) {
    // Detect whether points are already world coords or relative to (obj.x, obj.y)
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

  // Fallback organic polygon around (obj.x, obj.y)
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

/**
 * Trace a smooth closed Catmull-Rom / quadratic-midpoint curve through polygon vertices.
 */
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
 * Draw a lush illustrated coastal pine or tropical palm tree.
 */
function drawTree(ctx, x, y, radius, type, seed) {
  const r = radius || 12;
  // Soft ground drop shadow (sun coming from top-left)
  ctx.save();
  ctx.fillStyle = 'rgba(11, 34, 24, 0.28)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.35, y + r * 0.4, r * 0.95, r * 0.78, 0.2, 0, TWO_PI);
  ctx.fill();

  if (type === 'palm') {
    // Slender curved trunk hint
    ctx.strokeStyle = '#7c5c3b';
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.15, y + r * 0.2);
    ctx.lineTo(x, y);
    ctx.stroke();

    // 7 sunlit palm fronds radiating outward
    const fronds = 7;
    const baseAngle = seed * TWO_PI;
    for (let i = 0; i < fronds; i++) {
      const a = baseAngle + (i / fronds) * TWO_PI + (hash2(i, seed) - 0.5) * 0.22;
      const len = r * (0.95 + hash2(seed, i) * 0.35);
      const ex = x + Math.cos(a) * len;
      const ey = y + Math.sin(a) * len;
      const cpx = x + Math.cos(a - 0.28) * len * 0.55;
      const cpy = y + Math.sin(a - 0.28) * len * 0.55;
      const cpx2 = x + Math.cos(a + 0.28) * len * 0.55;
      const cpy2 = y + Math.sin(a + 0.28) * len * 0.55;

      ctx.fillStyle = i % 2 === 0 ? '#3f8f46' : '#58ab4d';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(cpx, cpy, ex, ey);
      ctx.quadraticCurveTo(cpx2, cpy2, x, y);
      ctx.fill();
    }
    // Warm sunlit crown center
    ctx.fillStyle = '#89cb63';
    ctx.beginPath();
    ctx.arc(x - r * 0.08, y - r * 0.08, r * 0.26, 0, TWO_PI);
    ctx.fill();
  } else {
    // Layered coastal maritime pine with serrated silhouette
    const tiers = [
      { scale: 1.0, ox: 0, oy: 0, color: '#1b5338' },
      { scale: 0.78, ox: -r * 0.1, oy: -r * 0.1, color: '#287049' },
      { scale: 0.52, ox: -r * 0.18, oy: -r * 0.18, color: '#45955d' },
    ];
    for (let t = 0; t < tiers.length; t++) {
      const tier = tiers[t];
      const spikes = 9;
      ctx.fillStyle = tier.color;
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const a = seed * 3 + t * 0.4 + (i / (spikes * 2)) * TWO_PI;
        const rad = r * tier.scale * (i % 2 === 0 ? 1.05 : 0.74);
        const px = x + tier.ox + Math.cos(a) * rad;
        const py = y + tier.oy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    // Sunlit tip highlight
    ctx.fillStyle = 'rgba(182, 232, 132, 0.45)';
    ctx.beginPath();
    ctx.arc(x - r * 0.22, y - r * 0.22, r * 0.24, 0, TWO_PI);
    ctx.fill();
  }
  ctx.restore();
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });

  // Viewport transform state
  let dpr = 1;
  let viewW = WORLD_WIDTH;
  let viewH = WORLD_HEIGHT;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  // Offscreen cached layers
  const causticsTile = buildCausticsTile();
  let causticsPattern = null;
  if (causticsTile && ctx) {
    causticsPattern = ctx.createPattern(causticsTile, 'repeat');
  }

  let cachedCourseRef = null;
  let cachedCourseKey = null;
  let shoalCanvas = null;
  let islandsCanvas = null;
  let cachedIslandPolys = [];
  let cachedRockPolys = [];
  let cachedLighthouses = [];
  let cachedPier = null;

  // Pre-seeded ambient ocean sparkle & wave crest anchors (zero per-frame allocations)
  const waveCrests = [];
  for (let i = 0; i < 48; i++) {
    waveCrests.push({
      x: hash2(i, 11.3) * (WORLD_WIDTH + 500) - 250,
      y: hash2(i, 23.7) * (SHORELINE_Y + 40) - 80,
      len: 36 + hash2(i, 37.1) * 68,
      amp: 2.5 + hash2(i, 41.9) * 3.5,
      speed: 14 + hash2(i, 53.2) * 18,
      phase: hash2(i, 67.4) * TWO_PI,
      hasCap: hash2(i, 79.8) > 0.62,
    });
  }

  const sunGlints = [];
  for (let i = 0; i < 72; i++) {
    sunGlints.push({
      x: hash2(i, 101.3) * (WORLD_WIDTH + 300) - 150,
      y: hash2(i, 113.7) * (SHORELINE_Y - 25),
      phase: hash2(i, 127.1) * TWO_PI,
      speed: 1.6 + hash2(i, 139.5) * 2.4,
      size: 1.5 + hash2(i, 149.9) * 2.6,
    });
  }

  // Drifting cloud shadows across the bay
  const clouds = [
    { x: 260, y: 240, rx: 190, ry: 95, vx: 13, vy: 2.2, alpha: 0.055 },
    { x: 1080, y: 510, rx: 240, ry: 110, vx: 10.5, vy: 1.6, alpha: 0.05 },
    { x: 1620, y: 170, rx: 165, ry: 80, vx: 15, vy: 2.6, alpha: 0.045 },
  ];

  // High-altitude circling coastal seagulls
  const seagulls = [
    { cx: 460, cy: 260, rx: 210, ry: 115, speed: 0.24, phase: 0.2, wingPhase: 0, scale: 1.0 },
    { cx: 1140, cy: 330, rx: 250, ry: 135, speed: -0.19, phase: 2.1, wingPhase: 1.8, scale: 0.88 },
    { cx: 820, cy: 590, rx: 290, ry: 120, speed: 0.16, phase: 4.3, wingPhase: 3.5, scale: 0.94 },
  ];

  // Internal particle pools
  const particles = [];
  const ripples = [];
  const confetti = [];
  const MAX_PARTICLES = 360;
  const MAX_RIPPLES = 75;
  const MAX_CONFETTI = 180;

  // Transient screen / race feedback effects
  let screenFlash = { alpha: 0, color: '#38bdf8', decay: 2.2 };
  let goLightPulse = 0;
  let internalTime = 0;
  let prevBoatPhase = 'menu';
  let sprayAccum = new Map();

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

  function addRipple(x, y, maxRadius, color = 'rgba(225, 250, 255, 0.55)', duration = 0.9, lineWidth = 2) {
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

  function spawnSplash(x, y, intensity = 1.0, color = '#effcff') {
    const count = Math.min(28, Math.max(5, Math.round(10 * intensity)));
    for (let i = 0; i < count; i++) {
      if (particles.length >= MAX_PARTICLES) particles.shift();
      const angle = Math.random() * TWO_PI;
      const spd = (25 + Math.random() * 95) * (0.65 + intensity * 0.55);
      particles.push({
        x: x + (Math.random() - 0.5) * 8,
        y: y + (Math.random() - 0.5) * 8,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: 2.0 + Math.random() * 3.6 * clamp(intensity, 0.6, 1.5),
        age: 0,
        life: 0.32 + Math.random() * 0.36,
        color,
        drag: 3.8,
        kind: 'splash',
      });
    }
    addRipple(x, y, 26 + intensity * 26, 'rgba(235, 252, 255, 0.68)', 0.72 + intensity * 0.25, 2.2);
  }

  function spawnConfettiBurst(originX = WORLD_WIDTH * 0.5, originY = WORLD_HEIGHT * 0.45, count = 85) {
    const palette = ['#ff4d2e', '#ffd166', '#38bdf8', '#10b981', '#f472b6', '#ffffff', '#f59e0b'];
    for (let i = 0; i < count; i++) {
      if (confetti.length >= MAX_CONFETTI) confetti.shift();
      const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * 2.2;
      const spd = 120 + Math.random() * 290;
      confetti.push({
        x: originX + (Math.random() - 0.5) * 260,
        y: originY + (Math.random() - 0.5) * 140,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 60,
        w: 5 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        rot: Math.random() * TWO_PI,
        rotVel: (Math.random() - 0.5) * 11,
        tilt: Math.random() * TWO_PI,
        tiltVel: 4 + Math.random() * 7,
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
        screenFlash = { alpha: 0.22, color: '#34d399', decay: 2.4 };
        addRipple(x, y, 110, 'rgba(110, 255, 200, 0.55)', 1.0, 3);
        break;
      case 'buoy_hit': {
        const bx = event.buoy ? event.buoy.x : x;
        const by = event.buoy ? event.buoy.y : y;
        spawnSplash(bx, by, 1.35, '#ffffff');
        addRipple(bx, by, 54, 'rgba(255, 110, 90, 0.78)', 0.85, 3);
        if (event.isPlayer || event.boat?.isPlayer) {
          screenFlash = { alpha: 0.18, color: '#f97316', decay: 3.0 };
        }
        break;
      }
      case 'buoy_rounded': {
        if (event.isPlayer || event.boat?.isPlayer) {
          const bx = event.buoy ? event.buoy.x : x;
          const by = event.buoy ? event.buoy.y : y;
          addRipple(bx, by, 48, 'rgba(125, 249, 255, 0.72)', 0.65, 2.5);
        }
        break;
      }
      case 'missed_buoy':
        if (event.isPlayer || event.boat?.isPlayer) {
          addRipple(x, y, 56, 'rgba(251, 146, 60, 0.8)', 0.9, 3);
        }
        break;
      case 'jump_start':
      case 'course_cut':
      case 'course_cut_penalty':
        if (event.isPlayer || event.boat?.isPlayer) {
          screenFlash = { alpha: 0.2, color: '#ef4444', decay: 2.6 };
          addRipple(x, y, 60, 'rgba(251, 146, 60, 0.75)', 0.8, 3);
        }
        break;
      case 'lap_complete':
      case 'final_lap':
        if (event.isPlayer || event.boat?.isPlayer) {
          screenFlash = {
            alpha: event.type === 'final_lap' ? 0.24 : 0.16,
            color: event.type === 'final_lap' ? '#fbbf24' : '#38bdf8',
            decay: 2.0,
          };
          addRipple(x, y, 85, 'rgba(253, 224, 71, 0.72)', 0.9, 3);
        }
        break;
      case 'race_finish':
      case 'player_finish':
      case 'victory': {
        const rank = event.playerStanding?.rank ?? event.rank ?? event.position ?? 1;
        if (rank <= 3) {
          spawnConfettiBurst(x, y, rank === 1 ? 115 : 65);
          spawnConfettiBurst(WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.35, rank === 1 ? 65 : 30);
          screenFlash = { alpha: 0.24, color: '#fde047', decay: 1.4 };
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Pre-render static shoal depth halos and detailed islands onto offscreen canvases
   * whenever a new course is loaded — keeps rendering rich & locked at 60fps.
   */
  function rebuildCourseCache(course) {
    cachedCourseRef = course;
    cachedCourseKey = course ? (course.seed ?? course.name ?? 'course') : null;
    cachedIslandPolys = [];
    cachedRockPolys = [];
    cachedLighthouses = [];
    cachedPier = null;

    if (!course) return;

    const scenery = course.scenery || {};
    const islands = scenery.islands || [];
    const rocks = scenery.rocks || [];

    // Resolve pier dimensions safely (supports top-left or center coordinates)
    const rawPier = scenery.pier;
    if (rawPier) {
      const pw = rawPier.width || 220;
      const ph = rawPier.height || 86;
      const py = rawPier.y ?? SHORELINE_Y;
      // If rawPier.x looks centered near WORLD_WIDTH/2, interpret cleanly
      const px = typeof rawPier.x === 'number'
        ? (rawPier.centered ? rawPier.x - pw * 0.5 : rawPier.x)
        : (WORLD_WIDTH - pw) * 0.5;
      cachedPier = { x: px, y: py, width: pw, height: ph };
    } else {
      cachedPier = { x: WORLD_WIDTH * 0.5 - 120, y: SHORELINE_Y - 12, width: 240, height: 96 };
    }

    // Prepare polygon caches
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
      const pts = getWorldPolygon(rk, 8);
      const center = getPolygonCentroid(pts, rk.x, rk.y);
      cachedRockPolys.push({ rock: rk, pts, center });
    }

    // Build offscreen shoal canvas (turquoise depth gradients & bathymetry lines)
    shoalCanvas = createOffscreenCanvas(WORLD_WIDTH, WORLD_HEIGHT);
    if (shoalCanvas) {
      const sctx = shoalCanvas.getContext('2d');
      if (sctx) {
        sctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

        // Island turquoise shoal halos + subtle nautical depth contours
        for (let i = 0; i < cachedIslandPolys.length; i++) {
          const { pts, center } = cachedIslandPolys[i];
          const rings = [
            { scale: 1.62, color: 'rgba(28, 168, 196, 0.14)' },
            { scale: 1.42, color: 'rgba(46, 198, 212, 0.22)' },
            { scale: 1.24, color: 'rgba(84, 224, 222, 0.34)' },
            { scale: 1.11, color: 'rgba(155, 240, 232, 0.48)' },
          ];
          for (let r = 0; r < rings.length; r++) {
            traceSmoothPolygon(sctx, pts, rings[r].scale, center.x, center.y);
            sctx.fillStyle = rings[r].color;
            sctx.fill();
          }
          // Subtle chart-style bathymetry contour ring
          traceSmoothPolygon(sctx, pts, 1.46, center.x, center.y);
          sctx.strokeStyle = 'rgba(148, 236, 245, 0.16)';
          sctx.lineWidth = 1.2;
          sctx.setLineDash([7, 7]);
          sctx.stroke();
          sctx.setLineDash([]);
        }

        // Rock turquoise shallows
        for (let i = 0; i < cachedRockPolys.length; i++) {
          const { pts, center } = cachedRockPolys[i];
          traceSmoothPolygon(sctx, pts, 1.85, center.x, center.y);
          sctx.fillStyle = 'rgba(56, 206, 218, 0.22)';
          sctx.fill();
          traceSmoothPolygon(sctx, pts, 1.38, center.x, center.y);
          sctx.fillStyle = 'rgba(116, 234, 234, 0.34)';
          sctx.fill();
        }
      }
    }

    // Build offscreen static islands & rocks terrain canvas
    islandsCanvas = createOffscreenCanvas(WORLD_WIDTH, WORLD_HEIGHT);
    if (islandsCanvas) {
      const ictx = islandsCanvas.getContext('2d');
      if (ictx) {
        ictx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

        // Render detailed coastal islands
        for (let i = 0; i < cachedIslandPolys.length; i++) {
          const { island, pts, center } = cachedIslandPolys[i];
          const r = island.radius || 55;

          // Underwater submerged drop-off shadow
          traceScaledPolygonOffset(ictx, pts, 1.06, center.x, center.y, 6, 8);
          ictx.fillStyle = 'rgba(4, 34, 54, 0.26)';
          ictx.fill();

          // Wet dark sand rim
          traceSmoothPolygon(ictx, pts, 1.03, center.x, center.y);
          ictx.fillStyle = '#ba9765';
          ictx.fill();

          // Warm sunlit golden sand beach
          traceSmoothPolygon(ictx, pts, 0.96, center.x, center.y);
          const sandGrad = ictx.createRadialGradient(
            center.x - r * 0.25,
            center.y - r * 0.25,
            r * 0.1,
            center.x,
            center.y,
            r * 1.1
          );
          sandGrad.addColorStop(0, '#f6e6be');
          sandGrad.addColorStop(0.7, '#e8cf97');
          sandGrad.addColorStop(1, '#d1b074');
          ictx.fillStyle = sandGrad;
          ictx.fill();

          // Rocky coastal shelf accent on one edge
          traceScaledPolygonOffset(ictx, pts, 0.8, center.x, center.y, 4, 4);
          ictx.fillStyle = '#8b8577';
          ictx.fill();

          // Lush elevated grassy interior
          traceSmoothPolygon(ictx, pts, 0.74, center.x, center.y);
          const grassGrad = ictx.createRadialGradient(
            center.x - r * 0.22,
            center.y - r * 0.22,
            r * 0.05,
            center.x,
            center.y,
            r * 0.85
          );
          grassGrad.addColorStop(0, '#72ba63');
          grassGrad.addColorStop(0.6, '#4d9750');
          grassGrad.addColorStop(1, '#326f3f');
          ictx.fillStyle = grassGrad;
          ictx.fill();

          // Subtle inner sunlit meadow highlight
          traceScaledPolygonOffset(ictx, pts, 0.5, center.x, center.y, -r * 0.08, -r * 0.08);
          ictx.fillStyle = 'rgba(155, 219, 114, 0.24)';
          ictx.fill();

          // Foliage / trees
          const foliage = island.trees || island.foliage || [];
          if (foliage.length > 0) {
            for (let t = 0; t < foliage.length; t++) {
              const tree = foliage[t];
              const tx = Math.abs(tree.x) < r * 1.5 && Math.hypot(tree.x - center.x, tree.y - center.y) > r * 1.5
                ? center.x + tree.x
                : tree.x;
              const ty = Math.abs(tree.y) < r * 1.5 && Math.hypot(tree.x - center.x, tree.y - center.y) > r * 1.5
                ? center.y + tree.y
                : tree.y;
              // Leave clear stone terrace right around lighthouse tower
              if (island.hasLighthouse) {
                const lx = island.lighthousePos?.x ?? island.lighthouse?.x ?? island.lighthouseX ?? center.x;
                const ly = island.lighthousePos?.y ?? island.lighthouse?.y ?? island.lighthouseY ?? center.y;
                if (Math.hypot(tx - lx, ty - ly) < 16) continue;
              }
              const tr = tree.radius || tree.r || tree.size || 11;
              const treeType = tree.type || (hash2(t, i + 4.1) > 0.62 ? 'palm' : 'pine');
              drawTree(ictx, tx, ty, tr, treeType, hash2(t + 1, i + 2));
            }
          } else {
            // Synthesize tasteful coastal pines/palms if none explicitly listed
            const autoCount = clamp(Math.floor(r / 12), 3, 9);
            for (let t = 0; t < autoCount; t++) {
              const a = (t / autoCount) * TWO_PI + hash2(i, t) * 0.5;
              const dist = r * (0.2 + hash2(t, i + 9) * 0.34);
              const tx = center.x + Math.cos(a) * dist;
              const ty = center.y + Math.sin(a) * dist;
              if (island.hasLighthouse && Math.hypot(tx - center.x, ty - center.y) < 17) continue;
              const tr = 9 + hash2(t + 3, i) * 6;
              drawTree(ictx, tx, ty, tr, t % 3 === 0 ? 'palm' : 'pine', hash2(i, t + 5));
            }
          }
        }

        // Render coastal rock clusters
        for (let i = 0; i < cachedRockPolys.length; i++) {
          const { rock, pts, center } = cachedRockPolys[i];
          const r = rock.radius || rock.r || 14;

          // Underwater shadow
          traceScaledPolygonOffset(ictx, pts, 1.12, center.x, center.y, 4, 5);
          ictx.fillStyle = 'rgba(4, 30, 48, 0.32)';
          ictx.fill();

          // Dark wet intertidal base rock
          traceSmoothPolygon(ictx, pts, 1.02, center.x, center.y);
          ictx.fillStyle = '#3b4856';
          ictx.fill();

          // Mid-tone weathered granite
          traceSmoothPolygon(ictx, pts, 0.85, center.x, center.y);
          const rkGrad = ictx.createLinearGradient(
            center.x - r,
            center.y - r,
            center.x + r,
            center.y + r
          );
          rkGrad.addColorStop(0, '#9ba6b0');
          rkGrad.addColorStop(0.55, '#6c7782');
          rkGrad.addColorStop(1, '#47525e');
          ictx.fillStyle = rkGrad;
          ictx.fill();

          // Sunlit top facet
          traceScaledPolygonOffset(ictx, pts, 0.52, center.x, center.y, -r * 0.14, -r * 0.14);
          ictx.fillStyle = 'rgba(226, 232, 240, 0.35)';
          ictx.fill();
        }
      }
    }
  }

  // ==================== DRAWING LAYERS ====================

  function drawOceanBase(visMinX, visMinY, visMaxX, visMaxY, t) {
    const w = visMaxX - visMinX;
    const h = visMaxY - visMinY;

    // Rich depth-graded coastal ocean gradient
    const oceanGrad = ctx.createLinearGradient(0, Math.min(0, visMinY), 0, SHORELINE_Y + 20);
    oceanGrad.addColorStop(0.0, '#053154');
    oceanGrad.addColorStop(0.24, '#084b78');
    oceanGrad.addColorStop(0.55, '#0d6d9b');
    oceanGrad.addColorStop(0.78, '#148db1');
    oceanGrad.addColorStop(0.92, '#22afc1');
    oceanGrad.addColorStop(1.0, '#44ccc9');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(visMinX, visMinY, w, h);

    // Subtle broad ocean depth swells drifting across open water
    ctx.save();
    for (let i = 0; i < 6; i++) {
      const bandY = ((i * 155 + t * 9) % (SHORELINE_Y + 80)) - 40;
      const bandGrad = ctx.createLinearGradient(0, bandY - 38, 0, bandY + 38);
      bandGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
      bandGrad.addColorStop(0.5, 'rgba(130, 232, 255, 0.032)');
      bandGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = bandGrad;
      ctx.fillRect(visMinX, bandY - 38, w, 76);
    }
    ctx.restore();

    // Pre-rendered island & rock shoal halos
    if (shoalCanvas) {
      ctx.drawImage(shoalCanvas, 0, 0);
    }

    // Dual-layer animated sunlit underwater caustics
    if (causticsPattern) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Layer A drifting gently ESE
      ctx.globalAlpha = 0.085;
      ctx.save();
      ctx.translate((t * 14) % 256, (t * 7) % 256);
      ctx.fillStyle = causticsPattern;
      ctx.fillRect(visMinX - 256, visMinY - 256, w + 512, Math.min(h + 512, SHORELINE_Y - visMinY + 320));
      ctx.restore();

      // Layer B counter-drifting slightly larger scale
      ctx.globalAlpha = 0.055;
      ctx.save();
      ctx.scale(1.35, 1.2);
      ctx.translate((-t * 9) % 256, (t * 11) % 256);
      ctx.fillStyle = causticsPattern;
      ctx.fillRect((visMinX - 300) / 1.35, (visMinY - 300) / 1.2, (w + 600) / 1.35, (SHORELINE_Y - visMinY + 340) / 1.2);
      ctx.restore();

      ctx.restore();
    }

    // Directional wind-swept wave crests & occasional whitecaps
    ctx.save();
    ctx.lineCap = 'round';
    const spanW = WORLD_WIDTH + 500;
    for (let i = 0; i < waveCrests.length; i++) {
      const wc = waveCrests[i];
      const wx = ((wc.x + t * wc.speed + 250) % spanW) - 250;
      const wy = wc.y + Math.sin(t * 1.1 + wc.phase) * 4;
      if (wy > SHORELINE_Y - 14) continue;
      const fade = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.9 + wc.phase));

      ctx.strokeStyle = `rgba(186, 242, 255, ${(0.08 + fade * 0.09).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(wx - wc.len * 0.5, wy);
      ctx.quadraticCurveTo(wx, wy - wc.amp, wx + wc.len * 0.5, wy + 1.5);
      ctx.stroke();

      if (wc.hasCap && fade > 0.72) {
        ctx.strokeStyle = `rgba(245, 253, 255, ${((fade - 0.72) * 0.85).toFixed(3)})`;
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(wx - wc.len * 0.16, wy - wc.amp * 0.45);
        ctx.quadraticCurveTo(wx, wy - wc.amp * 0.85, wx + wc.len * 0.16, wy - wc.amp * 0.35);
        ctx.stroke();
      }
    }

    // Shimmering specular sunlight sparkles across the water
    for (let i = 0; i < sunGlints.length; i++) {
      const g = sunGlints[i];
      const pulse = Math.sin(t * g.speed + g.phase);
      if (pulse < 0.68) continue;
      const b = (pulse - 0.68) / 0.32;
      const gx = g.x + Math.sin(t * 0.5 + g.phase) * 6;
      const gy = g.y + Math.cos(t * 0.6 + g.phase) * 3;
      const s = g.size * (0.6 + b * 0.9);

      ctx.fillStyle = `rgba(255, 253, 232, ${(b * 0.72).toFixed(3)})`;
      ctx.beginPath();
      // Crisp 4-point star sparkle
      ctx.moveTo(gx - s * 2.1, gy);
      ctx.lineTo(gx - s * 0.35, gy - s * 0.35);
      ctx.lineTo(gx, gy - s * 1.7);
      ctx.lineTo(gx + s * 0.35, gy - s * 0.35);
      ctx.lineTo(gx + s * 2.1, gy);
      ctx.lineTo(gx + s * 0.35, gy + s * 0.35);
      ctx.lineTo(gx, gy + s * 1.7);
      ctx.lineTo(gx - s * 0.35, gy + s * 0.35);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawShorelineFoam(t, visMinX, visMaxX) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Animated lapping foam collars around every island
    for (let i = 0; i < cachedIslandPolys.length; i++) {
      const { pts, center } = cachedIslandPolys[i];
      for (let ring = 0; ring < 2; ring++) {
        const wave = ((t * 0.42 + i * 0.37 + ring * 0.5) % 1);
        const expand = 1.03 + wave * 0.16;
        const alpha = Math.sin(wave * Math.PI) * 0.46;
        traceSmoothPolygon(ctx, pts, expand, center.x, center.y);
        ctx.strokeStyle = `rgba(232, 251, 255, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 2.6 - wave * 1.3;
        ctx.stroke();
      }
    }

    // Animated foam collars around coastal rocks
    for (let i = 0; i < cachedRockPolys.length; i++) {
      const { pts, center } = cachedRockPolys[i];
      const wave = ((t * 0.52 + i * 0.29) % 1);
      const expand = 1.06 + wave * 0.32;
      const alpha = Math.sin(wave * Math.PI) * 0.48;
      traceSmoothPolygon(ctx, pts, expand, center.x, center.y);
      ctx.strokeStyle = `rgba(236, 252, 255, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 2.0 - wave * 0.9;
      ctx.stroke();
    }

    // Gentle lapping white surf line along the bottom beach / seawall
    for (let layer = 0; layer < 2; layer++) {
      const phase = t * 1.55 + layer * Math.PI;
      const baseY = SHORELINE_Y + 3 - Math.sin(phase) * 5.5 - layer * 7;
      const alpha = layer === 0 ? 0.55 : 0.28 + 0.18 * Math.sin(phase);
      ctx.strokeStyle = `rgba(238, 252, 255, ${clamp(alpha, 0.08, 0.65).toFixed(3)})`;
      ctx.lineWidth = layer === 0 ? 3.2 : 2.0;
      ctx.beginPath();
      const startX = Math.floor(visMinX / 36) * 36 - 36;
      const endX = visMaxX + 72;
      let first = true;
      for (let x = startX; x <= endX; x += 36) {
        const y = baseY + Math.sin(x * 0.018 + t * 1.2 + layer * 1.4) * 3.8;
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRaceCourseLane(course, t) {
    const pts = course?.splinePoints;
    if (!pts || pts.length < 4) return;

    const halfW = course.corridorHalfWidth || 92;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Subtle luminous channel ribbon indicating navigable racing corridor
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();

    ctx.strokeStyle = 'rgba(186, 245, 255, 0.065)';
    ctx.lineWidth = halfW * 1.65;
    ctx.stroke();

    // Subtle crisp hydro-guide racing line (animated gentle dashes flowing forward)
    ctx.strokeStyle = 'rgba(215, 250, 255, 0.19)';
    ctx.lineWidth = 2.2;
    ctx.setLineDash([14, 18]);
    ctx.lineDashOffset = -t * 28;
    ctx.stroke();
    ctx.setLineDash([]);

    // Tasteful directional water-surface chevrons spaced evenly around the circuit
    const chevronCount = 14;
    const step = Math.max(1, Math.floor(pts.length / chevronCount));
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      const angle = Math.atan2(p.ty, p.tx);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 - (i / pts.length) * TWO_PI * 2);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.strokeStyle = `rgba(210, 250, 255, ${(0.14 + pulse * 0.14).toFixed(3)})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-7, -9);
      ctx.lineTo(4, 0);
      ctx.lineTo(-7, 9);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

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

    // Subtle start grid slots behind start line during menu / countdown
    const phase = effectivePhase || raceState?.phase || 'menu';
    if (phase === 'menu' || phase === 'countdown') {
      ctx.strokeStyle = 'rgba(224, 248, 255, 0.22)';
      ctx.lineWidth = 1.6;
      for (let lane = -2; lane <= 2; lane++) {
        const backDist = 36 + (Math.abs(lane) % 2) * 18;
        const gx = sl.x - tx * backDist + ux * (lane * 26);
        const gy = sl.y - ty * backDist + uy * (lane * 26);
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(Math.atan2(ty, tx));
        ctx.beginPath();
        ctx.moveTo(8, -11);
        ctx.lineTo(14, -11);
        ctx.lineTo(14, 11);
        ctx.lineTo(8, 11);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Floating checkerboard start/finish ribbon across the water
    const checks = Math.max(8, Math.round(lineLen / 11));
    const segLen = lineLen / checks;
    const ribbonAngle = Math.atan2(dy, dx);

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(ribbonAngle);

    // Subtle water shadow under floating line
    ctx.fillStyle = 'rgba(4, 28, 46, 0.25)';
    ctx.fillRect(0, -3, lineLen, 10);

    // Alternating crisp checkered floats
    for (let i = 0; i < checks; i++) {
      const bob = Math.sin(t * 3.2 + i * 0.6) * 0.7;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(248, 250, 252, 0.88)' : 'rgba(15, 23, 42, 0.84)';
      ctx.fillRect(i * segLen, -4 + bob, segLen + 0.4, 4);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(15, 23, 42, 0.84)' : 'rgba(248, 250, 252, 0.88)';
      ctx.fillRect(i * segLen, 0 + bob, segLen + 0.4, 4);
    }
    ctx.restore();

    // Two anchored start/finish marker buoys at ends of line
    const ends = [
      { x: lx, y: ly },
      { x: rx, y: ry },
    ];
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      const bob = Math.sin(t * 2.8 + i * 1.9) * 1.6;
      // Ripple ring
      ctx.strokeStyle = 'rgba(235, 252, 255, 0.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 13 + Math.sin(t * 2.2 + i) * 2, 0, TWO_PI);
      ctx.stroke();

      // Shadow
      ctx.fillStyle = 'rgba(4, 28, 46, 0.34)';
      ctx.beginPath();
      ctx.arc(e.x + 3, e.y + 4, 8.5, 0, TWO_PI);
      ctx.fill();

      // Checkered racing buoy cylinder
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, 8.5, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, 8.5, 0, Math.PI * 0.5);
      ctx.lineTo(e.x, e.y + bob);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, 8.5, Math.PI, Math.PI * 1.5);
      ctx.lineTo(e.x, e.y + bob);
      ctx.fill();

      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(e.x, e.y + bob, 8.5, 0, TWO_PI);
      ctx.stroke();
    }

    // Miniature Race Committee Pontoon / Starting Light Barge moored just outside the start line
    // Pick whichever side stays better inside the bay (away from shoreline/edges)
    const candA = { x: lx - ux * 28, y: ly - uy * 28 };
    const candB = { x: rx + ux * 28, y: ry + uy * 28 };
    const scoreCand = (c) => {
      let s = 0;
      if (c.x < 70 || c.x > WORLD_WIDTH - 70) s -= 200;
      if (c.y < 60 || c.y > SHORELINE_Y - 45) s -= 200;
      return s;
    };
    const barge = scoreCand(candA) >= scoreCand(candB) ? candA : candB;
    const bargeAngle = Math.atan2(ty, tx);
    const bargeBob = Math.sin(t * 2.1) * 1.6;

    ctx.save();
    ctx.translate(barge.x, barge.y + bargeBob);
    ctx.rotate(bargeAngle);

    // Water ripple around committee pontoon
    ctx.strokeStyle = 'rgba(220, 248, 255, 0.28)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(0, 0, 25 + Math.sin(t * 2) * 2, 16 + Math.sin(t * 2) * 1.5, 0, 0, TWO_PI);
    ctx.stroke();

    // Pontoon drop shadow
    ctx.fillStyle = 'rgba(4, 24, 42, 0.36)';
    ctx.beginPath();
    ctx.roundRect(-20, -10, 44, 26, 6);
    ctx.fill();

    // Twin marine blue pontoons
    ctx.fillStyle = '#1e3a5f';
    ctx.beginPath();
    ctx.roundRect(-22, -13, 44, 6, 3);
    ctx.roundRect(-22, 7, 44, 6, 3);
    ctx.fill();

    // Deck platform
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.roundRect(-18, -10, 36, 20, 3);
    ctx.fill();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Blue & white race committee awning on stern half
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(-16, -8, 15, 16);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(-13, -8, 4, 16);
    ctx.fillRect(-5, -8, 3, 16);

    // Signal gantry housing (mounted on bow half of pontoon)
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.roundRect(2, -9.5, 13, 19, 2.5);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 0.9;
    ctx.stroke();

    // Determine starting signal light states (3-2-1-GO)
    const cd = raceState?.countdown ?? 0;
    let light1 = '#334155';
    let light2 = '#334155';
    let light3 = '#334155';
    let glowColor = null;

    if (phase === 'countdown') {
      const ceilCd = Math.ceil(cd);
      if (ceilCd >= 3) {
        light1 = '#ef4444';
        glowColor = 'rgba(239, 68, 68, 0.45)';
      } else if (ceilCd === 2) {
        light1 = '#ef4444';
        light2 = '#ef4444';
        glowColor = 'rgba(239, 68, 68, 0.55)';
      } else if (ceilCd === 1) {
        light1 = '#ef4444';
        light2 = '#f59e0b';
        light3 = '#f59e0b';
        glowColor = 'rgba(245, 158, 11, 0.6)';
      } else {
        light1 = '#22c55e';
        light2 = '#22c55e';
        light3 = '#22c55e';
        glowColor = 'rgba(34, 197, 94, 0.75)';
      }
    } else if (phase === 'racing') {
      light1 = '#22c55e';
      light2 = '#22c55e';
      light3 = '#22c55e';
      if (goLightPulse > 0.05) {
        glowColor = `rgba(52, 211, 153, ${(0.45 + goLightPulse * 0.35).toFixed(2)})`;
      } else {
        glowColor = 'rgba(34, 197, 94, 0.25)';
      }
    } else if (phase === 'finished') {
      const blink = Math.sin(t * 7) > 0;
      light1 = blink ? '#f8fafc' : '#38bdf8';
      light2 = blink ? '#38bdf8' : '#f8fafc';
      light3 = blink ? '#f8fafc' : '#38bdf8';
      glowColor = 'rgba(56, 189, 248, 0.4)';
    } else {
      // Menu standby soft aqua pulse
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      light2 = pulse > 0.45 ? '#38bdf8' : '#1e3a5f';
      glowColor = `rgba(56, 189, 248, ${(pulse * 0.32).toFixed(2)})`;
    }

    if (glowColor) {
      const bloom = ctx.createRadialGradient(8.5, 0, 2, 8.5, 0, 24 + goLightPulse * 10);
      bloom.addColorStop(0, glowColor);
      bloom.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(8.5, 0, 24 + goLightPulse * 10, 0, TWO_PI);
      ctx.fill();
    }

    const lights = [
      { y: -5.5, color: light1 },
      { y: 0, color: light2 },
      { y: 5.5, color: light3 },
    ];
    for (let i = 0; i < lights.length; i++) {
      ctx.fillStyle = lights[i].color;
      ctx.beginPath();
      ctx.arc(8.5, lights[i].y, 2.3, 0, TWO_PI);
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

  function drawBoatWakes(boats) {
    if (!boats || boats.length === 0) return;
    const maxAge = PHYSICS.wakeMaxAge || 1.45;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let b = 0; b < boats.length; b++) {
      const boat = boats[b];
      const trail = boat.wakeTrail;
      if (!trail || trail.length < 2) continue;

      // Build left and right expanding V-wake edges
      const n = trail.length;
      const leftPts = new Array(n);
      const rightPts = new Array(n);
      const alphas = new Array(n);

      for (let i = 0; i < n; i++) {
        const pt = trail[i];
        const age = pt.age ?? ((n - 1 - i) / n) * maxAge;
        const normAge = clamp(age / maxAge, 0, 1);
        const spdFactor = clamp((pt.speed ?? boat.speed ?? 140) / 260, 0.25, 1.15);

        // Determine perpendicular direction (prefer sample heading from physics.js for razor-sharp turns)
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

        const baseHalf = typeof pt.width === 'number' ? pt.width * 0.42 : 5.5;
        const halfSpread = baseHalf + normAge * 24 * spdFactor;
        leftPts[i] = { x: pt.x + nx * halfSpread, y: pt.y + ny * halfSpread };
        rightPts[i] = { x: pt.x - nx * halfSpread, y: pt.y - ny * halfSpread };
        alphas[i] = (1 - normAge) * (1 - normAge) * spdFactor;
      }

      // Draw segmented soft translucent wake fill ribbon (fades naturally along length)
      for (let i = 0; i < n - 1; i++) {
        const a = Math.min(alphas[i], alphas[i + 1]);
        if (a < 0.02) continue;

        ctx.fillStyle = `rgba(195, 246, 255, ${(a * 0.22).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(leftPts[i].x, leftPts[i].y);
        ctx.lineTo(leftPts[i + 1].x, leftPts[i + 1].y);
        ctx.lineTo(rightPts[i + 1].x, rightPts[i + 1].y);
        ctx.lineTo(rightPts[i].x, rightPts[i].y);
        ctx.closePath();
        ctx.fill();

        // Crisp twin V-wake foam crests on port & starboard outer edges
        ctx.strokeStyle = `rgba(242, 253, 255, ${(a * 0.52).toFixed(3)})`;
        ctx.lineWidth = 1.2 + (1 - a) * 1.4;
        ctx.beginPath();
        ctx.moveTo(leftPts[i].x, leftPts[i].y);
        ctx.lineTo(leftPts[i + 1].x, leftPts[i + 1].y);
        ctx.moveTo(rightPts[i].x, rightPts[i].y);
        ctx.lineTo(rightPts[i + 1].x, rightPts[i + 1].y);
        ctx.stroke();

        // Inner bubbly prop-wash trail right behind the stern
        if (a > 0.35) {
          ctx.strokeStyle = `rgba(232, 252, 255, ${((a - 0.35) * 0.58).toFixed(3)})`;
          ctx.lineWidth = 3.2 * a;
          ctx.beginPath();
          ctx.moveTo(trail[i].x, trail[i].y);
          ctx.lineTo(trail[i + 1].x, trail[i + 1].y);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  function drawActiveBuoyBeacon(course, boats, raceState, t) {
    if (!course?.buoys?.length || !boats?.length) return;
    const player = boats.find((b) => b.isPlayer) || boats[0];
    if (!player || player.finished) return;

    const phase = raceState?.phase || 'menu';
    if (phase === 'finished') return;

    const missed = Boolean(player.missedBuoyWarning?.active);
    const targetIdx = missed && player.missedBuoyWarning.buoyIndex >= 0
      ? player.missedBuoyWarning.buoyIndex
      : player.nextBuoyIndex;
    const buoy = course.buoys[targetIdx % course.buoys.length];
    if (!buoy) return;

    ctx.save();

    // Expanding glowing target rings around next turn buoy
    const baseColor = missed ? '251, 113, 133' : '56, 226, 248';
    const accentColor = missed ? '#fb923c' : '#fde047';

    for (let ring = 0; ring < 2; ring++) {
      const p = ((t * (missed ? 1.55 : 0.95) + ring * 0.5) % 1);
      const rad = 16 + p * 34;
      const alpha = (1 - p) * (missed ? 0.85 : 0.62);
      ctx.strokeStyle = `rgba(${baseColor}, ${alpha.toFixed(3)})`;
      ctx.lineWidth = missed ? 3.2 : 2.4;
      ctx.beginPath();
      ctx.arc(buoy.x, buoy.y, rad, 0, TWO_PI);
      ctx.stroke();
    }

    // Subtle target gate line connecting apex buoy to outer gate buoy
    if (typeof buoy.outerX === 'number' && typeof buoy.outerY === 'number') {
      ctx.strokeStyle = `rgba(${baseColor}, ${missed ? 0.42 : 0.24})`;
      ctx.lineWidth = 2.0;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(buoy.x, buoy.y);
      ctx.lineTo(buoy.outerX, buoy.outerY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Floating directional pointer chevron near the player boat pointing toward next gate center
    if (phase === 'racing') {
      const gx = buoy.gateCenter?.x ?? (typeof buoy.outerX === 'number' ? (buoy.x + buoy.outerX) * 0.5 : buoy.x + (buoy.outX || 0) * 42);
      const gy = buoy.gateCenter?.y ?? (typeof buoy.outerY === 'number' ? (buoy.y + buoy.outerY) * 0.5 : buoy.y + (buoy.outY || 0) * 42);
      const dx = gx - player.x;
      const dy = gy - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 68) {
        const ang = Math.atan2(dy, dx);
        const orbitR = 34;
        const px = player.x + Math.cos(ang) * orbitR;
        const py = player.y + Math.sin(ang) * orbitR;
        const pulse = 0.72 + 0.28 * Math.sin(t * (missed ? 10 : 4.5));

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.globalAlpha = pulse * (missed ? 0.95 : 0.72);

        ctx.fillStyle = accentColor;
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(9, 0);
        ctx.lineTo(-5, -6.5);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-5, 6.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  function drawIslandsAndLighthouses(t) {
    // Draw pre-rendered high-detail islands, trees, and rocks
    if (islandsCanvas) {
      ctx.drawImage(islandsCanvas, 0, 0);
    }

    // Animated lighthouses with slowly rotating golden volumetric light beam
    for (let i = 0; i < cachedLighthouses.length; i++) {
      const lh = cachedLighthouses[i];
      const beamAngle = t * 0.58 + lh.phase;

      ctx.save();
      ctx.translate(lh.x, lh.y);

      // Rotating translucent warm lighthouse beam sweeping over the bay
      ctx.save();
      ctx.rotate(beamAngle);
      const beamLen = 235;
      const beamGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, beamLen);
      beamGrad.addColorStop(0, 'rgba(255, 250, 200, 0.42)');
      beamGrad.addColorStop(0.35, 'rgba(255, 244, 175, 0.16)');
      beamGrad.addColorStop(1, 'rgba(255, 244, 175, 0)');
      ctx.fillStyle = beamGrad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, beamLen, -0.22, 0.22);
      ctx.closePath();
      ctx.fill();

      // Secondary opposite softer reflection cone
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, beamLen * 0.6, Math.PI - 0.16, Math.PI + 0.16);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Long crisp tower shadow cast on island ground
      ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
      ctx.beginPath();
      ctx.moveTo(-4, 6);
      ctx.lineTo(14, 16);
      ctx.lineTo(22, 9);
      ctx.lineTo(7, -3);
      ctx.closePath();
      ctx.fill();

      // Stone terrace plinth
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.arc(0, 2, 12.5, 0, TWO_PI);
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Tapered red-and-white striped tower (top-down angled perspective)
      // Base white ring
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(0, 0, 9.8, 0, TWO_PI);
      ctx.fill();

      // Red band
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(-0.5, -1.5, 8.0, 0, TWO_PI);
      ctx.fill();

      // Upper white band
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(-1.0, -3.0, 6.2, 0, TWO_PI);
      ctx.fill();

      // Gallery rail ring
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(-1.4, -4.2, 5.6, 0, TWO_PI);
      ctx.stroke();

      // Glowing lantern core
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(-1.5, -4.5, 4.0, 0, TWO_PI);
      ctx.fill();

      // Red cupola roof cap
      ctx.fillStyle = '#b91c1c';
      ctx.beginPath();
      ctx.arc(-1.7, -5.0, 2.7, 0, TWO_PI);
      ctx.fill();

      // Specular glint on cupola
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(-2.4, -5.7, 0.9, 0, TWO_PI);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawSpectatorBoats(course, t) {
    const specBoats = course?.scenery?.spectatorBoats;
    if (!specBoats || specBoats.length === 0) return;

    for (let i = 0; i < specBoats.length; i++) {
      const sb = specBoats[i];
      const phase = sb.bobPhase ?? i * 1.9;
      const bobY = Math.sin(t * 1.85 + phase) * 1.8;
      const sway = Math.sin(t * 1.15 + phase) * 0.045;
      const ang = (sb.angle ?? sb.heading ?? 0.3) + sway;
      const len = sb.length || 34;
      const wid = sb.width || 14;
      const hullFill = sb.hullColor || '#f8fafc';
      const cabinFill = sb.cabinColor || sb.color || sb.accentColor || (i % 2 === 0 ? '#0284c7' : '#e11d48');
      const trimFill = sb.accentColor || cabinFill;

      ctx.save();
      ctx.translate(sb.x, sb.y + bobY);
      ctx.rotate(ang);

      // Gentle anchor ripple
      ctx.strokeStyle = 'rgba(225, 250, 255, 0.25)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, len * 0.65 + Math.sin(t * 2 + phase) * 2, wid * 0.8 + Math.sin(t * 2 + phase) * 1.2, 0, 0, TWO_PI);
      ctx.stroke();

      // Soft water shadow
      ctx.fillStyle = 'rgba(4, 24, 42, 0.3)';
      ctx.beginPath();
      ctx.moveTo(len * 0.55 + 3, 4);
      ctx.quadraticCurveTo(len * 0.1 + 3, wid * 0.55 + 4, -len * 0.48 + 3, wid * 0.42 + 4);
      ctx.lineTo(-len * 0.48 + 3, -wid * 0.42 + 4);
      ctx.quadraticCurveTo(len * 0.1 + 3, -wid * 0.55 + 4, len * 0.55 + 3, 4);
      ctx.closePath();
      ctx.fill();

      // Crisp cruiser hull
      ctx.fillStyle = hullFill;
      ctx.beginPath();
      ctx.moveTo(len * 0.55, 0);
      ctx.quadraticCurveTo(len * 0.1, wid * 0.55, -len * 0.48, wid * 0.42);
      ctx.lineTo(-len * 0.48, -wid * 0.42);
      ctx.quadraticCurveTo(len * 0.1, -wid * 0.55, len * 0.55, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = trimFill;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Colored sheer stripe / cabin trim
      ctx.fillStyle = cabinFill;
      ctx.beginPath();
      ctx.roundRect(-len * 0.25, -wid * 0.34, len * 0.42, wid * 0.68, 3);
      ctx.fill();

      // Tinted cabin windshield
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.roundRect(len * 0.04, -wid * 0.28, len * 0.15, wid * 0.56, 2);
      ctx.fill();

      // White bimini canopy / deck detail
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(-len * 0.36, -wid * 0.26, len * 0.24, wid * 0.52, 2);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawBuoys(course, boats, t) {
    const buoys = course?.buoys;
    if (!buoys || buoys.length === 0) return;

    const player = boats?.find((b) => b.isPlayer);
    const nextIdx = player && !player.finished ? player.nextBuoyIndex : -1;

    for (let i = 0; i < buoys.length; i++) {
      const b = buoys[i];
      const bobPhase = b.bobPhase ?? i * 1.4;
      const bobY = Math.sin(t * 2.9 + bobPhase) * 1.8;

      // 1) Outer gate spar marker buoy (smaller crisp orange/white float)
      if (typeof b.outerX === 'number' && typeof b.outerY === 'number') {
        const obob = Math.sin(t * 3.1 + bobPhase + 1.2) * 1.5;
        const oShake = b.outerHitTimer > 0 ? Math.sin(t * 44) * b.outerHitTimer * 3.0 : 0;
        const orad = b.outerRadius || PHYSICS.outerBuoyRadius || 7;

        ctx.save();
        ctx.translate(b.outerX + oShake, b.outerY + obob);

        ctx.strokeStyle = b.outerHitTimer > 0
          ? `rgba(255, 120, 100, ${(0.5 + b.outerHitTimer * 0.45).toFixed(2)})`
          : 'rgba(224, 250, 255, 0.34)';
        ctx.lineWidth = b.outerHitTimer > 0 ? 2.2 : 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, orad + 4 + Math.sin(t * 2.4 + i) * 1.5, 0, TWO_PI);
        ctx.stroke();

        ctx.fillStyle = 'rgba(4, 26, 44, 0.32)';
        ctx.beginPath();
        ctx.arc(2.5, 3.2, orad, 0, TWO_PI);
        ctx.fill();

        const og = ctx.createRadialGradient(-2, -2, 1, 0, 0, orad);
        og.addColorStop(0, '#fff7ed');
        og.addColorStop(0.45, '#fb923c');
        og.addColorStop(1, '#c2410c');
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.arc(0, 0, orad, 0, TWO_PI);
        ctx.fill();

        // White reflective ring
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, orad * 0.55, 0, TWO_PI);
        ctx.stroke();

        ctx.restore();
      }

      // 2) Main apex turn buoy (3D-shaded marine racing buoy)
      const hitShake = b.hitTimer > 0 ? Math.sin(t * 42) * b.hitTimer * 3.5 : 0;
      const bx = b.x + (b.hitVelX ? clamp(b.hitVelX * 0.04, -5, 5) : 0) + hitShake;
      const by = b.y + (b.hitVelY ? clamp(b.hitVelY * 0.04, -5, 5) : 0) + bobY;
      const rad = b.radius || PHYSICS.buoyRadius || 11;
      const isNext = i === nextIdx;

      // Determine rich 3D buoy color palette
      const rawColor = (b.color || '').toLowerCase();
      let lightCol = '#fecaca';
      let midCol = '#ef4444';
      let darkCol = '#991b1b';
      if (rawColor.includes('yellow') || rawColor.includes('fbbf24') || rawColor.includes('eab308') || rawColor.includes('f59e0b')) {
        lightCol = '#fef9c3';
        midCol = '#facc15';
        darkCol = '#a16207';
      } else if (rawColor.includes('green') || rawColor.includes('10b981') || rawColor.includes('22c55e')) {
        lightCol = '#bbf7d0';
        midCol = '#22c55e';
        darkCol = '#166534';
      } else if (rawColor.includes('orange') || rawColor.includes('f97316') || rawColor.includes('ff6')) {
        lightCol = '#ffedd5';
        midCol = '#f97316';
        darkCol = '#9a3412';
      } else if (b.color && b.color.startsWith('#')) {
        midCol = b.color;
      }

      ctx.save();

      // Clear curved directional rounding arrow floating on the OUTSIDE of the buoy
      if (typeof b.outX === 'number' && typeof b.outY === 'number') {
        const arrowDist = rad + 16;
        const ax = bx + b.outX * arrowDist;
        const ay = by + b.outY * arrowDist;
        const dirAngle = Math.atan2(b.dirY ?? -b.outX, b.dirX ?? b.outY);

        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(dirAngle);
        const arrowAlpha = isNext ? 0.92 : 0.44;
        ctx.strokeStyle = isNext ? `rgba(254, 240, 138, ${arrowAlpha})` : `rgba(224, 248, 255, ${arrowAlpha})`;
        ctx.lineWidth = isNext ? 2.6 : 1.8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Sleek double-chevron indicating flow direction on the outside of the turn
        ctx.beginPath();
        ctx.moveTo(-6, -5);
        ctx.lineTo(0, 0);
        ctx.lineTo(-6, 5);
        ctx.moveTo(0, -5);
        ctx.lineTo(6, 0);
        ctx.lineTo(0, 5);
        ctx.stroke();
        ctx.restore();
      }

      ctx.translate(bx, by);

      // Buoy ambient water ripple ring
      const ripR = rad + 5 + Math.sin(t * 2.5 + bobPhase) * 2.2;
      ctx.strokeStyle = b.hitTimer > 0
        ? `rgba(255, 130, 110, ${(0.5 + b.hitTimer * 0.45).toFixed(2)})`
        : 'rgba(225, 250, 255, 0.42)';
      ctx.lineWidth = b.hitTimer > 0 ? 2.6 : 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, ripR, 0, TWO_PI);
      ctx.stroke();

      // Drop shadow on water
      ctx.fillStyle = 'rgba(4, 24, 42, 0.38)';
      ctx.beginPath();
      ctx.ellipse(3.5, 4.5, rad * 1.04, rad * 0.92, 0.2, 0, TWO_PI);
      ctx.fill();

      // 3D-shaded spherical/conical marine buoy body
      const bg = ctx.createRadialGradient(-rad * 0.34, -rad * 0.34, rad * 0.12, 0, 0, rad * 1.08);
      bg.addColorStop(0, lightCol);
      bg.addColorStop(0.42, midCol);
      bg.addColorStop(1, darkCol);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, TWO_PI);
      ctx.fill();

      // Crisp white reflective marine collar band
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.68, 0, TWO_PI);
      ctx.stroke();

      // Dark outer contour rim for clarity against sunlit foam
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, TWO_PI);
      ctx.stroke();

      // Buoy number badge cleanly centered
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.47, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = isNext ? '#fde047' : '#ffffff';
      ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String((b.index ?? i) + 1), 0, 0.5);

      ctx.restore();
    }
  }

  function emitBoatParticles(boats, dt, t) {
    if (!boats || dt <= 0) return;

    for (let i = 0; i < boats.length; i++) {
      const boat = boats[i];
      const spd = Math.hypot(boat.vx || 0, boat.vy || 0);
      if (spd < 38) continue;

      const spdRatio = clamp(spd / (PHYSICS.maxSpeed || 295), 0, 1.2);
      const prev = sprayAccum.get(boat.id) || 0;
      const rate = 22 + spdRatio * 55;
      let acc = prev + dt * rate;

      const cosH = Math.cos(boat.heading || 0);
      const sinH = Math.sin(boat.heading || 0);
      const nx = -sinH;
      const ny = cosH;
      const sternX = boat.x - cosH * 20;
      const sternY = boat.y - sinH * 20;

      while (acc >= 1) {
        acc -= 1;
        if (particles.length >= MAX_PARTICLES) particles.shift();

        // 1) Propeller rooster-tail spray shooting directly behind stern
        const spread = (Math.random() - 0.5) * 0.48;
        const jetAngle = (boat.heading || 0) + Math.PI + spread;
        const jetSpeed = (35 + Math.random() * 60) * spdRatio;
        particles.push({
          x: sternX + (Math.random() - 0.5) * 3,
          y: sternY + (Math.random() - 0.5) * 3,
          vx: Math.cos(jetAngle) * jetSpeed + (boat.vx || 0) * 0.15,
          vy: Math.sin(jetAngle) * jetSpeed + (boat.vy || 0) * 0.15,
          size: 1.8 + Math.random() * 2.5 * spdRatio,
          age: 0,
          life: 0.24 + Math.random() * 0.26,
          color: Math.random() > 0.3 ? '#f4fdff' : '#bae6fd',
          drag: 3.4,
          kind: 'spray',
        });

        // 2) Juicy carving side-spray fan during hard turns!
        const rollAbs = Math.abs(boat.rollAngle || 0);
        const turnStrength = Math.max(rollAbs * 2.1, Math.abs(boat.angularVel || 0) * 0.45);
        if (turnStrength > 0.35 && spdRatio > 0.35 && Math.random() < clamp(turnStrength, 0, 0.9)) {
          if (particles.length >= MAX_PARTICLES) particles.shift();
          // Spray throws off the outside chine of the turn
          const outsideSign = (boat.rollAngle || boat.steer || 1) >= 0 ? -1 : 1;
          const chineX = boat.x + cosH * (-2 + Math.random() * 12) + nx * outsideSign * 7;
          const chineY = boat.y + sinH * (-2 + Math.random() * 12) + ny * outsideSign * 7;
          const throwSpd = (45 + Math.random() * 75) * spdRatio * clamp(turnStrength, 0.5, 1.4);
          particles.push({
            x: chineX,
            y: chineY,
            vx: nx * outsideSign * throwSpd + (boat.vx || 0) * 0.35,
            vy: ny * outsideSign * throwSpd + (boat.vy || 0) * 0.35,
            size: 2.0 + Math.random() * 2.8,
            age: 0,
            life: 0.28 + Math.random() * 0.24,
            color: '#ffffff',
            drag: 4.2,
            kind: 'spray',
          });
        }
      }

      sprayAccum.set(boat.id, acc);

      // Subtle wake chop splash when crossing heavy wake turbulence
      if ((boat.wakeTurbulence || 0) > 0.38 && Math.random() < dt * 9) {
        addRipple(boat.x, boat.y, 24, 'rgba(225, 250, 255, 0.45)', 0.55, 1.6);
      }
    }
  }

  function drawBoat(boat, raceState, t) {
    const x = boat.x;
    const y = boat.y;
    const heading = boat.heading || 0;
    const speed = Math.hypot(boat.vx || 0, boat.vy || 0);
    const speedRatio = clamp(speed / (PHYSICS.maxSpeed || 295), 0, 1.15);
    const roll = clamp(boat.rollAngle || 0, -0.65, 0.65);
    const bounce = clamp(boat.pitchBounce || 0, -4, 6);
    const rudder = clamp(boat.rudderAngle || 0, -0.7, 0.7);
    const antennaFlex = clamp(boat.antennaFlex || 0, -1.2, 1.2);

    const primary = boat.primaryColor || '#FF4D2E';
    const accent = boat.accentColor || '#FFD166';
    const hullCol = boat.hullColor || '#F8FAFC';
    const deckCol = boat.deckColor || '#0F172A';

    // Hull geometry (sculpted offshore racing V-hull)
    const halfL = 21.5;
    const halfW = 8.6;
    // Slight visual banking foreshortening & roll shift
    const bankScaleY = 1 - Math.abs(roll) * 0.16;
    const bankShift = roll * 3.0;
    const hopLift = Math.max(0, bounce);
    const hopScale = 1 + hopLift * 0.032;

    ctx.save();
    ctx.translate(x, y);

    // 1) Water Drop Shadow (offsets further when pitchBounce leaps over waves!)
    const shadowOffX = 4.2 + hopLift * 3.0;
    const shadowOffY = 5.4 + hopLift * 3.4;
    ctx.save();
    ctx.translate(shadowOffX, shadowOffY);
    ctx.rotate(heading);
    ctx.scale(1, bankScaleY);
    ctx.fillStyle = 'rgba(3, 20, 38, 0.34)';
    ctx.beginPath();
    ctx.moveTo(halfL + 1, 0);
    ctx.bezierCurveTo(halfL * 0.45, halfW * 1.05, -halfL * 0.4, halfW * 1.02, -halfL, halfW * 0.76);
    ctx.lineTo(-halfL, -halfW * 0.76);
    ctx.bezierCurveTo(-halfL * 0.4, -halfW * 1.02, halfL * 0.45, -halfW * 1.05, halfL + 1, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Rotate into boat local frame
    ctx.save();
    ctx.rotate(heading);
    ctx.scale(hopScale, hopScale * bankScaleY);

    // 2) Live luminous propeller rooster tail plume behind the outboard
    if (speedRatio > 0.18) {
      const plumeLen = 14 + speedRatio * 28 + Math.sin(t * 28 + x * 0.1) * 3;
      const plumeGrad = ctx.createLinearGradient(-halfL, 0, -halfL - plumeLen, 0);
      plumeGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.55 + speedRatio * 0.35).toFixed(2)})`);
      plumeGrad.addColorStop(0.5, `rgba(186, 242, 255, ${(0.35 * speedRatio).toFixed(2)})`);
      plumeGrad.addColorStop(1, 'rgba(186, 242, 255, 0)');
      ctx.fillStyle = plumeGrad;
      ctx.beginPath();
      ctx.moveTo(-halfL + 1, -2.2);
      ctx.quadraticCurveTo(-halfL - plumeLen * 0.55, -4.5 * speedRatio, -halfL - plumeLen, 0);
      ctx.quadraticCurveTo(-halfL - plumeLen * 0.55, 4.5 * speedRatio, -halfL + 1, 2.2);
      ctx.closePath();
      ctx.fill();
    }

    // 3) Animated Outboard Motor & Rudder Unit pivoting at the stern transom
    ctx.save();
    ctx.translate(-halfL + 0.5, 0);
    ctx.rotate(-rudder * 0.9);
    // Rudder blade / prop guard
    ctx.fillStyle = '#475569';
    ctx.fillRect(-6.8, -1.1, 6.2, 2.2);
    // Glossy outboard cowling
    ctx.fillStyle = deckCol;
    ctx.beginPath();
    ctx.roundRect(-4.6, -3.1, 5.8, 6.2, 1.8);
    ctx.fill();
    ctx.fillStyle = primary;
    ctx.fillRect(-3.6, -2.0, 2.8, 4.0);
    ctx.restore();

    // 4) Sculpted Offshore V-Hull Base Silhouette
    ctx.beginPath();
    ctx.moveTo(halfL + 1.5, 0);
    ctx.bezierCurveTo(halfL * 0.52, halfW * 1.04, -halfL * 0.38, halfW * 1.02, -halfL, halfW * 0.78);
    ctx.lineTo(-halfL, -halfW * 0.78);
    ctx.bezierCurveTo(-halfL * 0.38, -halfW * 1.02, halfL * 0.52, -halfW * 1.04, halfL + 1.5, 0);
    ctx.closePath();

    // Bank-aware 3D metallic hull shading across port/starboard chines
    const hullGrad = ctx.createLinearGradient(0, -halfW, 0, halfW);
    hullGrad.addColorStop(0, roll > 0.1 ? '#ffffff' : hullCol);
    hullGrad.addColorStop(0.5, hullCol);
    hullGrad.addColorStop(1, roll < -0.1 ? '#cbd5e1' : '#dbe5ef');
    ctx.fillStyle = hullGrad;
    ctx.fill();

    // Clip livery stripes & deck inside hull silhouette
    ctx.save();
    ctx.clip();

    // Bold sweeping primary color racing side-flanks & bow wedge
    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.moveTo(halfL + 2, 0);
    ctx.lineTo(halfL * 0.15, halfW * 0.98);
    ctx.lineTo(-halfL - 1, halfW * 0.95);
    ctx.lineTo(-halfL - 1, halfW * 0.38);
    ctx.lineTo(halfL * 0.32, 0);
    ctx.lineTo(-halfL - 1, -halfW * 0.38);
    ctx.lineTo(-halfL - 1, -halfW * 0.95);
    ctx.lineTo(halfL * 0.15, -halfW * 0.98);
    ctx.closePath();
    ctx.fill();

    // Crisp metallic accent racing stripes running bow-to-stern
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.85;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.68, 0);
    ctx.lineTo(-halfL, halfW * 0.44);
    ctx.moveTo(halfL * 0.68, 0);
    ctx.lineTo(-halfL, -halfW * 0.44);
    ctx.stroke();

    // Center V-ridge sunlit gloss reflection (shifts slightly with rollAngle!)
    const ridgeGrad = ctx.createLinearGradient(0, -halfW + bankShift, 0, halfW + bankShift);
    ridgeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.38)');
    ridgeGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0.05)');
    ridgeGrad.addColorStop(1, 'rgba(15, 23, 42, 0.24)');
    ctx.fillStyle = ridgeGrad;
    ctx.fillRect(-halfL - 2, -halfW - 2, halfL * 2 + 5, halfW * 2 + 4);

    ctx.restore(); // end hull clip

    // Crisp gunwale outline
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.62)';
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(halfL + 1.5, 0);
    ctx.bezierCurveTo(halfL * 0.52, halfW * 1.04, -halfL * 0.38, halfW * 1.02, -halfL, halfW * 0.78);
    ctx.lineTo(-halfL, -halfW * 0.78);
    ctx.bezierCurveTo(-halfL * 0.38, -halfW * 1.02, halfL * 0.52, -halfW * 1.04, halfL + 1.5, 0);
    ctx.closePath();
    ctx.stroke();

    // 5) Aerodynamic Tinted Cockpit Canopy (shifts subtly with banking)
    const cy = bankShift * 0.32;
    ctx.fillStyle = deckCol;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.26, cy);
    ctx.bezierCurveTo(halfL * 0.14, cy + 4.3, -halfL * 0.42, cy + 4.0, -halfL * 0.58, cy + 2.4);
    ctx.lineTo(-halfL * 0.58, cy - 2.4);
    ctx.bezierCurveTo(-halfL * 0.42, cy - 4.0, halfL * 0.14, cy - 4.3, halfL * 0.26, cy);
    ctx.closePath();
    ctx.fill();

    // Glossy wrap-around windshield sky reflection
    const glassGrad = ctx.createLinearGradient(halfL * 0.22, cy - 3.5, -halfL * 0.2, cy + 3.5);
    glassGrad.addColorStop(0, 'rgba(186, 230, 253, 0.85)');
    glassGrad.addColorStop(0.45, 'rgba(56, 189, 248, 0.38)');
    glassGrad.addColorStop(1, 'rgba(15, 23, 42, 0.2)');
    ctx.fillStyle = glassGrad;
    ctx.beginPath();
    ctx.moveTo(halfL * 0.2, cy);
    ctx.bezierCurveTo(halfL * 0.1, cy + 3.0, -halfL * 0.12, cy + 2.8, -halfL * 0.18, cy + 1.8);
    ctx.lineTo(-halfL * 0.18, cy - 1.8);
    ctx.bezierCurveTo(-halfL * 0.12, cy - 2.8, halfL * 0.1, cy - 3.0, halfL * 0.2, cy);
    ctx.closePath();
    ctx.fill();

    // Racing number on bow foredeck
    if (boat.number) {
      ctx.save();
      ctx.translate(halfL * 0.54, 0);
      ctx.rotate(Math.PI * 0.5);
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 6.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(boat.number), 0, 0.5);
      ctx.restore();
    }

    // 6) Flexing RC Radio Whip Antenna + tiny fluttering pennant!
    const antBaseX = -halfL * 0.52;
    const antBaseY = cy - 1.5;
    const bendBack = 9 + speedRatio * 10;
    const bendSide = antennaFlex * 9 + Math.sin(t * 16 + x * 0.05) * (1.0 + speedRatio * 1.4);
    const tipX = antBaseX - bendBack;
    const tipY = antBaseY + bendSide;

    ctx.strokeStyle = 'rgba(30, 41, 59, 0.88)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(antBaseX, antBaseY);
    ctx.quadraticCurveTo(antBaseX - bendBack * 0.45, antBaseY + bendSide * 0.25, tipX, tipY);
    ctx.stroke();

    // Tiny fluttering colored pennant at antenna tip
    const flutter = Math.sin(t * 22 + (boat.isPlayer ? 0 : 2.5)) * 1.8;
    ctx.fillStyle = boat.isPlayer ? '#fde047' : accent;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 6.5, tipY - 2.2 + flutter);
    ctx.lineTo(tipX - 5.2, tipY + 1.8 + flutter * 0.6);
    ctx.closePath();
    ctx.fill();

    ctx.restore(); // end boat local rotation

    // 7) Tasteful Player / Boat Indicator (world-aligned, crisp & unobtrusive)
    const phase = raceState?.phase || 'menu';
    if (boat.isPlayer) {
      // Subtle luminous ring beneath/around player boat
      const ringAlpha = phase === 'racing' ? 0.34 : 0.62;
      ctx.strokeStyle = `rgba(253, 224, 71, ${ringAlpha})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(0, 0, 26 + Math.sin(t * 4) * 1.5, 0, TWO_PI);
      ctx.stroke();

      // Clean "YOU" pill badge bright before/at start, gracefully fading to subtle pip during racing
      const raceTime = raceState?.raceTime ?? 0;
      const tagAlpha = phase === 'racing'
        ? clamp(1 - (raceTime - 2.2) / 3.0, 0.28, 1)
        : 0.95;

      if (tagAlpha > 0.32) {
        ctx.save();
        ctx.globalAlpha = tagAlpha;
        ctx.translate(0, -32);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.roundRect(-18, -9, 36, 16, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#fde047';
        ctx.font = '800 9.5px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('YOU', 0, -0.5);
        ctx.restore();
      } else {
        // Minimal crisp golden downward chevron above player boat while deep in race
        ctx.save();
        ctx.translate(0, -29);
        ctx.fillStyle = 'rgba(253, 224, 71, 0.88)';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, 4);
        ctx.lineTo(-4.5, -3);
        ctx.lineTo(4.5, -3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    } else if (boat.number) {
      // Tiny unobtrusive number pip above AI racers for quick identification
      ctx.save();
      ctx.translate(0, -25);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.56)';
      ctx.beginPath();
      ctx.roundRect(-10, -6.5, 20, 12, 6);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.font = '700 8px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(boat.number), 0, -0.2);
      ctx.restore();
    }

    ctx.restore();
  }

  function drawParticlesAndConfetti() {
    ctx.save();
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alpha = clamp(1 - p.age / p.life, 0, 1);
      ctx.globalAlpha = alpha * (p.kind === 'splash' ? 0.88 : 0.72);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.5 + alpha * 0.55), 0, TWO_PI);
      ctx.fill();
    }

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
   * Bottom-edge RC Yacht Club Pier & Rocky Coastal Shoreline (y ≈ 915..1000+),
   * seamlessly extending left/right/bottom to eliminate any black bars.
   */
  function drawShorelineAndPier(visMinX, visMaxX, visMaxY, t) {
    const startX = Math.floor(visMinX / 40) * 40 - 40;
    const endX = visMaxX + 80;
    const bottomY = Math.max(WORLD_HEIGHT + 40, visMaxY + 40);

    ctx.save();

    // 1) Wet sand & warm coastal beach strip extending seamlessly across full width
    ctx.beginPath();
    ctx.moveTo(startX, bottomY);
    for (let x = startX; x <= endX; x += 40) {
      const wave = Math.sin(x * 0.0085) * 6 + Math.cos(x * 0.021) * 3;
      ctx.lineTo(x, SHORELINE_Y + 6 + wave);
    }
    ctx.lineTo(endX, bottomY);
    ctx.closePath();

    const beachGrad = ctx.createLinearGradient(0, SHORELINE_Y, 0, WORLD_HEIGHT + 20);
    beachGrad.addColorStop(0.0, '#b59465'); // wet shoreline sand
    beachGrad.addColorStop(0.18, '#e3cb98'); // sunlit beach sand
    beachGrad.addColorStop(0.55, '#d5b982');
    beachGrad.addColorStop(1.0, '#a68b5b');
    ctx.fillStyle = beachGrad;
    ctx.fill();

    // Subtle coastal stone seawall & grassy embankment along bottom edge
    ctx.beginPath();
    ctx.moveTo(startX, bottomY);
    for (let x = startX; x <= endX; x += 48) {
      const y = SHORELINE_Y + 44 + Math.sin(x * 0.011 + 1.3) * 5;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(endX, bottomY);
    ctx.closePath();
    const grassGrad = ctx.createLinearGradient(0, SHORELINE_Y + 38, 0, WORLD_HEIGHT + 10);
    grassGrad.addColorStop(0, '#5a9455');
    grassGrad.addColorStop(0.5, '#437844');
    grassGrad.addColorStop(1, '#2c5431');
    ctx.fillStyle = grassGrad;
    ctx.fill();

    // Decorative coastal rocks tucked naturally along the rocky shoreline
    for (let x = startX + 30; x < endX; x += 115) {
      const pier = cachedPier;
      // Keep shoreline rocks clear of pier deck footprint
      if (pier && x > pier.x - 24 && x < pier.x + pier.width + 24) continue;
      const rx = x + hash2(x, 3.1) * 35;
      const ry = SHORELINE_Y + 18 + hash2(x, 7.2) * 18;
      const rr = 8 + hash2(x, 9.7) * 11;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.24)';
      ctx.beginPath();
      ctx.ellipse(rx + 2, ry + 3, rr * 1.15, rr * 0.72, 0.1, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = '#6c7782';
      ctx.beginPath();
      ctx.ellipse(rx, ry, rr, rr * 0.68, hash2(x, 1.4) * 0.4 - 0.2, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = 'rgba(226, 232, 240, 0.32)';
      ctx.beginPath();
      ctx.ellipse(rx - rr * 0.2, ry - rr * 0.16, rr * 0.5, rr * 0.3, 0, 0, TWO_PI);
      ctx.fill();
    }

    // 2) Charming Wooden RC Yacht Club Pier jutting slightly into the turquoise shallows
    const pier = cachedPier || { x: WORLD_WIDTH * 0.5 - 120, y: SHORELINE_Y - 14, width: 240, height: 96 };
    const px = pier.x;
    const py = Math.min(pier.y, SHORELINE_Y - 8);
    const pw = pier.width;
    const ph = Math.max(pier.height, bottomY - py);

    // Soft water drop shadow cast beneath pier into turquoise shallows
    ctx.fillStyle = 'rgba(4, 28, 44, 0.34)';
    ctx.beginPath();
    ctx.roundRect(px + 8, py + 7, pw, ph + 10, 6);
    ctx.fill();

    // Wooden pilings along pier perimeter with water shadows & tiny foam collars
    const pilingPosts = [
      { x: px + 8, y: py + 6 },
      { x: px + pw * 0.35, y: py + 6 },
      { x: px + pw * 0.65, y: py + 6 },
      { x: px + pw - 8, y: py + 6 },
      { x: px + 8, y: py + 44 },
      { x: px + pw - 8, y: py + 44 },
    ];
    for (let i = 0; i < pilingPosts.length; i++) {
      const pp = pilingPosts[i];
      if (pp.y < SHORELINE_Y + 12) {
        // Water foam collar around front pilings
        const ring = 9 + Math.sin(t * 2.4 + i) * 1.4;
        ctx.strokeStyle = 'rgba(232, 251, 255, 0.42)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, ring, 0, TWO_PI);
        ctx.stroke();
      }
    }

    // Pier base deck backing
    ctx.fillStyle = '#5e4028';
    ctx.beginPath();
    ctx.roundRect(px, py, pw, ph, [5, 5, 0, 0]);
    ctx.fill();

    // Individually shaded weathered cedar deck planks
    const plankH = 10;
    const plankCount = Math.ceil(ph / plankH);
    for (let i = 0; i < plankCount; i++) {
      const y0 = py + 3 + i * plankH;
      const tone = hash2(i, 42.7);
      const r = Math.round(140 + tone * 26);
      const g = Math.round(101 + tone * 20);
      const b = Math.round(67 + tone * 14);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(px + 3, y0, pw - 6, plankH - 1.6);

      // Subtle sun-bleached highlight along top of plank
      ctx.fillStyle = 'rgba(255, 240, 214, 0.14)';
      ctx.fillRect(px + 3, y0, pw - 6, 1.8);

      // Tiny nail heads near left & right stringers
      ctx.fillStyle = 'rgba(42, 28, 18, 0.55)';
      ctx.fillRect(px + 13, y0 + 3.5, 1.8, 1.8);
      ctx.fillRect(px + pw - 15, y0 + 3.5, 1.8, 1.8);
    }

    // Side edge stringer timbers
    ctx.fillStyle = '#734f32';
    ctx.fillRect(px, py, 6, ph);
    ctx.fillRect(px + pw - 6, py, 6, ph);
    ctx.fillRect(px, py, pw, 5);

    // Timber piling caps rising slightly above deck
    for (let i = 0; i < pilingPosts.length; i++) {
      const pp = pilingPosts[i];
      ctx.fillStyle = 'rgba(20, 14, 8, 0.35)';
      ctx.beginPath();
      ctx.arc(pp.x + 2, pp.y + 2.5, 6.2, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = '#4e3524';
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 6.0, 0, TWO_PI);
      ctx.fill();

      ctx.fillStyle = '#8b6343';
      ctx.beginPath();
      ctx.arc(pp.x - 0.6, pp.y - 0.6, 4.2, 0, TWO_PI);
      ctx.fill();
    }

    // Cast-iron mooring cleats on pier edge
    const cleats = [px + pw * 0.22, px + pw * 0.78];
    for (let i = 0; i < cleats.length; i++) {
      const cx = cleats[i];
      const cy = py + 11;
      ctx.fillStyle = '#334155';
      ctx.fillRect(cx - 7, cy - 1.6, 14, 3.2);
      ctx.fillStyle = '#64748b';
      ctx.fillRect(cx - 4, cy - 3, 8, 6);
    }

    // Neatly coiled nautical rope on left side of pier
    const ropeX = px + Math.min(34, pw * 0.2);
    const ropeY = py + 31;
    ctx.strokeStyle = '#d6b682';
    ctx.lineWidth = 2.2;
    for (let r = 3; r <= 9.5; r += 2.3) {
      ctx.beginPath();
      ctx.arc(ropeX, ropeY, r, 0, TWO_PI);
      ctx.stroke();
    }

    // Classic red-and-white life preserver ring resting on pier
    const ringX = px + pw - Math.min(34, pw * 0.2);
    const ringY = py + 33;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
    ctx.beginPath();
    ctx.arc(ringX + 2, ringY + 2.5, 10.5, 0, TWO_PI);
    ctx.fill();

    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.arc(ringX, ringY, 7.8, 0, TWO_PI);
    ctx.stroke();

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 4.2;
    for (let q = 0; q < 4; q++) {
      const a0 = q * Math.PI * 0.5 + 0.15;
      ctx.beginPath();
      ctx.arc(ringX, ringY, 7.8, a0, a0 + 0.45);
      ctx.stroke();
    }

    // Small RC Yacht Club pit mat / radio case centered on pier
    const boxW = 22;
    const boxX = px + pw * 0.5 - boxW * 0.5;
    const boxY = py + 24;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
    ctx.fillRect(boxX + 2, boxY + 2, boxW, 14);
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, 14, 2.5);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(boxX + 4, boxY + 4, boxW - 8, 3);

    // Fluttering Orange-and-White Windsock on pier corner pole!
    const poleX = px + 14;
    const poleY = py + 12;
    const windAngle = -0.18 + Math.sin(t * 3.4) * 0.14;
    const flutter = Math.sin(t * 9.5) * 3.2;

    ctx.save();
    ctx.translate(poleX, poleY);

    // Windsock shadow on planks/water
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.26)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(2, 4);
    ctx.lineTo(2 + Math.cos(windAngle) * 26, 4 + Math.sin(windAngle) * 26);
    ctx.stroke();

    // Animated striped windsock cone
    ctx.rotate(windAngle);
    const sockSegs = 4;
    const segL = 7;
    for (let s = 0; s < sockSegs; s++) {
      const x0 = 3 + s * segL;
      const x1 = x0 + segL;
      const w0 = 4.6 - s * 0.75;
      const w1 = 4.6 - (s + 1) * 0.75;
      const y0 = Math.sin(t * 9.5 - s * 0.8) * (s * 0.9);
      const y1 = Math.sin(t * 9.5 - (s + 1) * 0.8) * ((s + 1) * 0.9);

      ctx.fillStyle = s % 2 === 0 ? '#f97316' : '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(x0, y0 - w0);
      ctx.lineTo(x1, y1 - w1);
      ctx.lineTo(x1, y1 + w1);
      ctx.lineTo(x0, y0 + w0);
      ctx.closePath();
      ctx.fill();
    }
    // Tail ribbons
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(31, flutter * 0.6);
    ctx.lineTo(36, flutter * 0.9);
    ctx.stroke();

    // Metal pole cap
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(0, 0, 2.8, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  function drawAtmosphere(t, dt) {
    ctx.save();

    // 1) Slow drifting translucent cloud shadows gliding softly across the bay
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      if (c.x - c.rx > WORLD_WIDTH + 220) {
        c.x = -c.rx - 180;
        c.y = 120 + hash2(t, i) * 520;
      }

      const cg = ctx.createRadialGradient(c.x, c.y, c.rx * 0.15, c.x, c.y, c.rx);
      cg.addColorStop(0, `rgba(4, 24, 48, ${c.alpha})`);
      cg.addColorStop(0.6, `rgba(4, 24, 48, ${(c.alpha * 0.55).toFixed(3)})`);
      cg.addColorStop(1, 'rgba(4, 24, 48, 0)');
      ctx.fillStyle = cg;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(1, c.ry / c.rx);
      ctx.beginPath();
      ctx.arc(0, 0, c.rx, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }

    // 2) High-altitude circling coastal seagulls
    for (let i = 0; i < seagulls.length; i++) {
      const g = seagulls[i];
      const ang = t * g.speed + g.phase;
      const gx = g.cx + Math.cos(ang) * g.rx;
      const gy = g.cy + Math.sin(ang) * g.ry;
      const vx = -Math.sin(ang) * g.rx * g.speed;
      const vy = Math.cos(ang) * g.ry * g.speed;
      const heading = Math.atan2(vy, vx);
      const flap = Math.sin(t * 5.2 + g.wingPhase) * 0.45 + 0.55;
      const wingSpan = 9.5 * g.scale * (0.68 + flap * 0.35);
      const wingSweep = 4.2 * g.scale;

      // Tiny faint distant gull shadow on the water below
      ctx.save();
      ctx.translate(gx + 34, gy + 44);
      ctx.rotate(heading);
      ctx.strokeStyle = 'rgba(4, 24, 42, 0.12)';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-wingSweep, -wingSpan * 0.7);
      ctx.quadraticCurveTo(1, -wingSpan * 0.3, 3, 0);
      ctx.quadraticCurveTo(1, wingSpan * 0.3, -wingSweep, wingSpan * 0.7);
      ctx.stroke();
      ctx.restore();

      // Crisp white gull soaring high above the bay
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(heading);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = 2.2 * g.scale;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-wingSweep, -wingSpan);
      ctx.quadraticCurveTo(2, -wingSpan * 0.42, 4 * g.scale, 0);
      ctx.quadraticCurveTo(2, wingSpan * 0.42, -wingSweep, wingSpan);
      ctx.stroke();

      // Subtle slate wingtips
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.75)';
      ctx.lineWidth = 1.6 * g.scale;
      ctx.beginPath();
      ctx.moveTo(-wingSweep * 0.65, -wingSpan * 0.8);
      ctx.lineTo(-wingSweep, -wingSpan);
      ctx.moveTo(-wingSweep * 0.65, wingSpan * 0.8);
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
      c.vy += 155 * dt;
      c.vx *= Math.exp(-0.9 * dt);
      c.x += (c.vx + Math.sin(c.tilt) * 28) * dt;
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

    // Rebuild cached static course scenery if course changed
    const courseKey = course ? (course.seed ?? course.name ?? 'course') : null;
    if (course !== cachedCourseRef || courseKey !== cachedCourseKey) {
      rebuildCourseCache(course);
      // Clear transient particles on fresh course
      particles.length = 0;
      ripples.length = 0;
      confetti.length = 0;
      sprayAccum.clear();
    }

    // Auto-trigger celebratory visual polish if phase transitions cleanly
    const effectivePhase = state.cameraMode === 'title' ? 'menu' : (raceState?.phase || 'menu');
    if (effectivePhase !== prevBoatPhase) {
      if (effectivePhase === 'racing' && prevBoatPhase === 'countdown') {
        goLightPulse = 1.4;
      }
      prevBoatPhase = effectivePhase;
    }

    // Update internal spray, ripples, confetti
    emitBoatParticles(boats, safeDt, t);
    updateParticles(safeDt);

    // Visible world bounds covering the ENTIRE viewport (zero black bars!)
    const visMinX = -offsetX / scale;
    const visMinY = -offsetY / scale;
    const visMaxX = (viewW - offsetX) / scale;
    const visMaxY = (viewH - offsetY) / scale;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Transform into logical 1600x1000 world space
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Layer 0–2: Infinite living coastal ocean + shoals + animated caustics + waves + sun glints
    drawOceanBase(visMinX, visMinY, visMaxX, visMaxY, t);

    // Layer 3: Race course guide lane & start/finish gantry pontoon
    if (course) {
      drawRaceCourseLane(course, t);
      drawStartFinishLineAndGantry(course, raceState, effectivePhase, t);
    }

    // Layer 4: Animated shoreline foam & expanding ripples
    drawShorelineFoam(t, visMinX, visMaxX);
    drawRipples();

    // Layer 5: Multi-layered dynamic boat V-wake ribbons
    drawBoatWakes(boats);

    // Layer 6: Active next-buoy highlight beacon & guidance chevron
    if (course && boats) {
      drawActiveBuoyBeacon(course, boats, raceState, t);
    }

    // Layer 7: Islands, lush trees, rocks, animated lighthouse beam, & moored spectator boats
    drawIslandsAndLighthouses(t);
    if (course) {
      drawSpectatorBoats(course, t);
    }

    // Layer 8: 3D-shaded turn buoys & outer gate spar buoys
    if (course) {
      drawBuoys(course, boats, t);
    }

    // Layer 9: High-fidelity RC offshore racing boats (player drawn last so never buried)
    if (boats && boats.length > 0) {
      for (let i = 0; i < boats.length; i++) {
        if (!boats[i].isPlayer) drawBoat(boats[i], raceState, t);
      }
      for (let i = 0; i < boats.length; i++) {
        if (boats[i].isPlayer) drawBoat(boats[i], raceState, t);
      }
    }

    // Layer 10: Water spray droplets, splashes & victory confetti
    drawParticlesAndConfetti();

    // Layer 11: Foreground RC Yacht Club Wooden Pier & Rocky Shoreline
    drawShorelineAndPier(visMinX, visMaxX, visMaxY, t);

    // Layer 12: Living coastal atmosphere (drifting cloud shadows & circling seagulls)
    drawAtmosphere(t, safeDt);

    ctx.restore(); // end world transform

    // Layer 13: Subtle sunlit top-left atmospheric glow & transient event edge flash
    const sunGlow = ctx.createRadialGradient(viewW * 0.08, viewH * 0.04, 10, viewW * 0.08, viewH * 0.04, Math.max(viewW, viewH) * 0.55);
    sunGlow.addColorStop(0, 'rgba(255, 250, 220, 0.08)');
    sunGlow.addColorStop(1, 'rgba(255, 250, 220, 0)');
    ctx.fillStyle = sunGlow;
    ctx.fillRect(0, 0, viewW, viewH);

    if (screenFlash.alpha > 0.005) {
      ctx.save();
      ctx.globalAlpha = screenFlash.alpha;
      const edgeGrad = ctx.createRadialGradient(
        viewW * 0.5,
        viewH * 0.5,
        Math.min(viewW, viewH) * 0.34,
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

  // Initial sizing
  resize();

  return {
    resize,
    render,
    spawnSplash,
    triggerEffect,
  };
}
