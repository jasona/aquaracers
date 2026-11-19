// Procedural ocean race course generator, spline helpers, and coastal scenery for AquaRacers

import { WORLD_WIDTH, WORLD_HEIGHT, SHORELINE_Y, BAY_BOUNDS, PHYSICS } from './constants.js';

const SPLINE_SAMPLE_COUNT = 240;

const NAME_PREFIXES = [
  'Emerald', 'Sapphire', 'Pelican', 'Coral', 'Sunset', 'Breaker',
  'Mariner', 'Azure', 'Tradewind', 'Beacon', 'Osprey', 'Mistral',
  'Dolphin', 'Saltwater', 'Crescent', 'Harbor', 'Cobalt', 'Seabreeze',
];

const NAME_NOUNS = [
  'Shoals', 'Cove', 'Harbor', 'Bay', 'Lagoon', 'Point',
  'Reef', 'Sound', 'Inlet', 'Marina', 'Cay', 'Channel', 'Atoll',
];

const NAME_SUFFIXES = [
  'GP', 'Cup', 'Classic', 'Trophy', 'Regatta', 'Circuit', 'Challenge',
];

// Normalized closed-loop archetypes in [-1, 1] x [-1, 1] (clockwise in canvas coords: x right, y down)
const ARCHETYPES = [
  {
    name: 'Harbor Sweep',
    corridorHalfWidth: 94,
    points: [
      [-0.84, 0.72],
      [-0.95, 0.04],
      [-0.74, -0.78],
      [-0.22, -0.88],
      [0.22, -0.48],
      [0.74, -0.78],
      [0.95, 0.06],
      [0.78, 0.80],
      [0.02, 0.84],
    ],
  },
  {
    name: 'Archipelago S',
    corridorHalfWidth: 92,
    points: [
      [-0.84, 0.78],
      [-0.95, -0.06],
      [-0.64, -0.86],
      [-0.16, -0.82],
      [0.14, -0.34],
      [0.68, -0.80],
      [0.95, -0.12],
      [0.84, 0.76],
      [-0.02, 0.86],
    ],
  },
  {
    name: 'Tri-Oval Bay',
    corridorHalfWidth: 98,
    points: [
      [-0.82, 0.78],
      [-0.94, 0.14],
      [-0.48, -0.82],
      [0.14, -0.90],
      [0.86, -0.34],
      [0.90, 0.62],
      [0.06, 0.86],
    ],
  },
  {
    name: 'Twin-Cove Technical',
    corridorHalfWidth: 90,
    points: [
      [-0.85, 0.72],
      [-0.95, -0.14],
      [-0.68, -0.88],
      [-0.04, -0.38],
      [0.68, -0.88],
      [0.95, -0.12],
      [0.84, 0.76],
      [0.02, 0.72],
    ],
  },
  {
    name: 'Double-Apex Loop',
    corridorHalfWidth: 92,
    points: [
      [-0.88, 0.54],
      [-0.84, -0.52],
      [-0.26, -0.88],
      [0.42, -0.86],
      [0.92, -0.36],
      [0.74, 0.22],
      [0.64, 0.82],
      [0.06, 0.86],
      [-0.56, 0.82],
    ],
  },
  {
    name: 'Lagoon Kidney',
    corridorHalfWidth: 92,
    points: [
      [-0.88, 0.68],
      [-0.95, -0.18],
      [-0.54, -0.88],
      [0.24, -0.88],
      [0.88, -0.50],
      [0.94, 0.34],
      [0.54, 0.86],
      [-0.10, 0.42],
      [-0.54, 0.84],
    ],
  },
];

// Mulberry32 deterministic PRNG
function createRng(seed) {
  let a = (seed >>> 0) || 0x6d2b79f5;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return (Math.floor(seed) >>> 0) || 1;
  }
  if (typeof seed === 'string' && seed.length > 0) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) || 1;
  }
  return ((Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0) || 1;
}

export function wrapT(t) {
  return ((t % 1) + 1) % 1;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Signed polygon area in canvas coords (x right, y down): > 0 is clockwise, < 0 is counter-clockwise
function computeSignedArea(pts) {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

// Centripetal Catmull-Rom interpolation between p1 and p2 (alpha = 0.5 avoids cusps)
function catmullRomPoint(p0, p1, p2, p3, u) {
  const alpha = 0.5;
  const d01 = Math.max(1e-4, Math.pow(dist(p0.x, p0.y, p1.x, p1.y), alpha));
  const d12 = Math.max(1e-4, Math.pow(dist(p1.x, p1.y, p2.x, p2.y), alpha));
  const d23 = Math.max(1e-4, Math.pow(dist(p2.x, p2.y, p3.x, p3.y), alpha));

  const t0 = 0;
  const t1 = t0 + d01;
  const t2 = t1 + d12;
  const t3 = t2 + d23;
  const t = t1 + u * (t2 - t1);

  const lerpPt = (a, b, ta, tb) => {
    const w = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };

  const A1 = lerpPt(p0, p1, t0, t1);
  const A2 = lerpPt(p1, p2, t1, t2);
  const A3 = lerpPt(p2, p3, t2, t3);
  const B1 = lerpPt(A1, A2, t0, t2);
  const B2 = lerpPt(A2, A3, t1, t3);
  return lerpPt(B1, B2, t1, t2);
}

// Build evenly arc-length-resampled closed spline with tangents, normals, and curvature
function buildClosedSpline(controlPoints, sampleCount = SPLINE_SAMPLE_COUNT) {
  const m = controlPoints.length;
  const stepsPerSeg = 48;
  const raw = [];

  for (let i = 0; i < m; i++) {
    const p0 = controlPoints[(i - 1 + m) % m];
    const p1 = controlPoints[i];
    const p2 = controlPoints[(i + 1) % m];
    const p3 = controlPoints[(i + 2) % m];
    for (let s = 0; s < stepsPerSeg; s++) {
      raw.push(catmullRomPoint(p0, p1, p2, p3, s / stepsPerSeg));
    }
  }

  // Cumulative arc length on closed loop
  const cumLen = new Float64Array(raw.length + 1);
  let totalLength = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const b = raw[(i + 1) % raw.length];
    totalLength += dist(a.x, a.y, b.x, b.y);
    cumLen[i + 1] = totalLength;
  }

  // Resample evenly by arc length
  const pts = [];
  let rawIdx = 0;
  for (let i = 0; i < sampleCount; i++) {
    const targetS = (i / sampleCount) * totalLength;
    while (rawIdx < raw.length - 1 && cumLen[rawIdx + 1] < targetS) {
      rawIdx++;
    }
    const segStart = cumLen[rawIdx];
    const segLen = Math.max(1e-6, cumLen[rawIdx + 1] - segStart);
    const frac = clamp((targetS - segStart) / segLen, 0, 1);
    const a = raw[rawIdx];
    const b = raw[(rawIdx + 1) % raw.length];
    pts.push({
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      tx: 1,
      ty: 0,
      nx: 0,
      ny: 1,
      s: targetS,
      t: i / sampleCount,
      curvature: 0,
    });
  }

  computeSplineFrames(pts, totalLength);
  return { points: pts, totalLength };
}

function computeSplineFrames(pts, totalLength) {
  const n = pts.length;
  const ds = totalLength / n;

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    pts[i].tx = tx;
    pts[i].ty = ty;
    // Right-hand (starboard) normal in canvas coords (x right, y down)
    pts[i].nx = -ty;
    pts[i].ny = tx;
    pts[i].s = i * ds;
    pts[i].t = i / n;
  }

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    // Signed curvature: > 0 means right (CW) turn, < 0 means left (CCW) turn
    const cross = prev.tx * next.ty - prev.ty * next.tx;
    const dot = clamp(prev.tx * next.tx + prev.ty * next.ty, -1, 1);
    const angle = Math.atan2(cross, dot);
    pts[i].curvature = angle / (2 * ds);
  }
}

// Segment-segment intersection test (proper or touching)
function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (o1 * o2 < 0 && o3 * o4 < 0) return true;

  const onSeg = (p, q, r) =>
    Math.min(p.x, r.x) - 1e-6 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-6 &&
    Math.min(p.y, r.y) - 1e-6 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-6;

  if (Math.abs(o1) < 1e-6 && onSeg(a, c, b)) return true;
  if (Math.abs(o2) < 1e-6 && onSeg(a, d, b)) return true;
  if (Math.abs(o3) < 1e-6 && onSeg(c, a, d)) return true;
  if (Math.abs(o4) < 1e-6 && onSeg(c, b, d)) return true;
  return false;
}

// Strict geometric validation of the closed spline
function validateSplineGeometry(pts, totalLength, corridorHalfWidth) {
  const n = pts.length;
  const edgeMargin = corridorHalfWidth * 0.80;
  const minX = BAY_BOUNDS.minX + edgeMargin;
  const maxX = BAY_BOUNDS.maxX - edgeMargin;
  const minY = BAY_BOUNDS.minY + edgeMargin;
  const maxY = BAY_BOUNDS.maxY - edgeMargin;

  // 1. Bay bounds & minimum turn radius
  const maxCurvature = 1 / (corridorHalfWidth * 0.82);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
      return false;
    }
    if (Math.abs(p.curvature) > maxCurvature) {
      return false;
    }
  }

  // 2. Zero self-intersections across all non-adjacent segments
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) {
        return false;
      }
    }
  }

  // 3. Minimum clearance between non-adjacent segments (>= corridorHalfWidth * 2.35)
  const minClearance = corridorHalfWidth * 2.35;
  const minClearanceSq = minClearance * minClearance;
  const ds = totalLength / n;
  const adjIdxGap = Math.max(12, Math.ceil((corridorHalfWidth * 3.25) / ds));

  for (let i = 0; i < n; i++) {
    const a = pts[i];
    for (let j = i + adjIdxGap; j < n; j++) {
      const idxDist = Math.min(j - i, n - (j - i));
      if (idxDist < adjIdxGap) continue;
      const b = pts[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy < minClearanceSq) {
        return false;
      }
    }
  }

  return true;
}

// Pick the cleanest straightaway for the start/finish line (preferring foreground/mid-bay visibility)
function findStartLineIndex(pts) {
  const n = pts.length;
  const windowHalf = 10;
  let bestIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < n; i++) {
    let avgAbsCurv = 0;
    let maxAbsCurv = 0;
    // Check both ahead and behind (behind needs room for the 5-boat starting grid)
    for (let k = -windowHalf - 4; k <= windowHalf; k++) {
      const c = Math.abs(pts[(i + k + n) % n].curvature);
      avgAbsCurv += c;
      if (c > maxAbsCurv) maxAbsCurv = c;
    }
    avgAbsCurv /= (windowHalf * 2 + 5);

    const p = pts[i];
    // Strong reward for straight segments
    const straightScore = 1.0 / (avgAbsCurv * 650 + maxAbsCurv * 220 + 0.12);

    // Prefer foreground / lower-mid bay (y ~ 520..810) and central X (360..1240)
    const foregroundBonus = p.y >= 500 && p.y <= 825 ? 1.55 : (p.y >= 380 ? 1.05 : 0.72);
    const centerXDist = Math.abs(p.x - WORLD_WIDTH * 0.5) / (WORLD_WIDTH * 0.5);
    const centerBonus = 1.18 - centerXDist * 0.45;
    // Prefer running somewhat horizontally along the bay front when available
    const horizBonus = 0.92 + Math.abs(p.tx) * 0.20;

    const score = straightScore * foregroundBonus * centerBonus * horizBonus;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function rotateSplineToStart(pts, startIdx, totalLength) {
  const n = pts.length;
  const rotated = new Array(n);
  for (let i = 0; i < n; i++) {
    rotated[i] = { ...pts[(startIdx + i) % n] };
  }
  computeSplineFrames(rotated, totalLength);
  return rotated;
}

// Place 5 to 8 ordered turn/gate buoys at key apexes & chicanes
function placeCourseBuoys(pts, totalLength, corridorHalfWidth, direction, rng) {
  const n = pts.length;
  const smoothK = new Float64Array(n);
  const win = 3;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -win; k <= win; k++) {
      sum += pts[(i + k + n) % n].curvature;
    }
    smoothK[i] = sum / (win * 2 + 1);
  }

  // Keep buoys clear of start line & starting grid (t in [0.085, 0.915])
  const minIdx = Math.ceil(n * 0.085);
  const maxIdx = Math.floor(n * 0.915);

  // Detect local curvature peaks
  const candidates = [];
  for (let i = minIdx; i <= maxIdx; i++) {
    const absK = Math.abs(smoothK[i]);
    const prevK = Math.abs(smoothK[(i - 1 + n) % n]);
    const nextK = Math.abs(smoothK[(i + 1) % n]);
    if (absK >= prevK && absK >= nextK && absK > 0.0014) {
      candidates.push({ idx: i, strength: absK });
    }
  }

  // Sort strongest apexes first
  candidates.sort((a, b) => b.strength - a.strength);

  const selected = [];
  const minIdxSep = Math.floor(n * 0.095);
  const minEuclidSep = corridorHalfWidth * 1.55;
  const targetMax = 7 + (rng() < 0.35 ? 1 : 0); // 7 or 8 max

  const canSelect = (idx) => {
    if (idx < minIdx || idx > maxIdx) return false;
    const p = pts[idx];
    for (const sIdx of selected) {
      const idxGap = Math.min(Math.abs(idx - sIdx), n - Math.abs(idx - sIdx));
      if (idxGap < minIdxSep) return false;
      if (dist(p.x, p.y, pts[sIdx].x, pts[sIdx].y) < minEuclidSep) return false;
    }
    return true;
  };

  for (const cand of candidates) {
    if (selected.length >= targetMax) break;
    if (canSelect(cand.idx)) {
      selected.push(cand.idx);
    }
  }

  // Ensure at least 5 buoys (prefer 6) by subdividing the largest parameter gaps
  const minBuoys = 5 + (rng() < 0.65 ? 1 : 0);
  let guard = 0;
  while (selected.length < minBuoys && guard < 24) {
    guard++;
    const sorted = [...selected].sort((a, b) => a - b);
    const stops = [0, ...sorted, n];
    let bestGapLen = -1;
    let bestRange = null;

    for (let g = 0; g < stops.length - 1; g++) {
      const a = Math.max(minIdx, stops[g] + minIdxSep);
      const b = Math.min(maxIdx, stops[g + 1] - minIdxSep);
      if (b >= a && (b - a) > bestGapLen) {
        bestGapLen = b - a;
        bestRange = [a, b];
      }
    }
    if (!bestRange) break;

    let bestIdx = Math.floor((bestRange[0] + bestRange[1]) * 0.5);
    let bestVal = -1;
    for (let i = bestRange[0]; i <= bestRange[1]; i++) {
      const val = Math.abs(smoothK[i]);
      if (val > bestVal && canSelect(i)) {
        bestVal = val;
        bestIdx = i;
      }
    }
    if (canSelect(bestIdx)) {
      selected.push(bestIdx);
    } else {
      break;
    }
  }

  selected.sort((a, b) => a - b);
  if (selected.length < 5 || selected.length > 8) {
    return null;
  }

  const apexOffset = corridorHalfWidth * 0.44;
  const outerOffset = corridorHalfWidth * 0.72;
  const buoyMargin = 14;

  const buoys = [];
  for (let i = 0; i < selected.length; i++) {
    const idx = selected[i];
    const p = pts[idx];
    const k = smoothK[idx];
    const isRightTurn = Math.abs(k) > 1e-5 ? k > 0 : direction > 0;
    const turnSide = isRightTurn ? 'right' : 'left';
    const insideSign = isRightTurn ? 1 : -1;

    // Unit vector pointing from the inside apex buoy outward across the valid racing corridor
    const outX = -insideSign * p.nx;
    const outY = -insideSign * p.ny;

    // Inside turn buoy (apex) and outer gate spar buoy
    const x = p.x - outX * apexOffset;
    const y = p.y - outY * apexOffset;
    const outerX = p.x + outX * outerOffset;
    const outerY = p.y + outY * outerOffset;

    // Verify buoy and outer marker are safely inside BAY_BOUNDS
    if (
      x < BAY_BOUNDS.minX + buoyMargin || x > BAY_BOUNDS.maxX - buoyMargin ||
      y < BAY_BOUNDS.minY + buoyMargin || y > BAY_BOUNDS.maxY - buoyMargin ||
      outerX < BAY_BOUNDS.minX + buoyMargin || outerX > BAY_BOUNDS.maxX - buoyMargin ||
      outerY < BAY_BOUNDS.minY + buoyMargin || outerY > BAY_BOUNDS.maxY - buoyMargin
    ) {
      return null;
    }

    // Authentic marine racing buoy color coding
    const isLast = i === selected.length - 1;
    const color = isLast ? '#FACC15' : (isRightTurn ? '#EF4444' : '#22C55E');

    buoys.push({
      index: i,
      splineT: p.t,
      x,
      y,
      outerX,
      outerY,
      gateCenter: {
        x: (x + outerX) * 0.5,
        y: (y + outerY) * 0.5,
      },
      dirX: p.tx,
      dirY: p.ty,
      outX,
      outY,
      turnSide,
      color,
      radius: PHYSICS.buoyRadius,
      outerRadius: PHYSICS.outerBuoyRadius,
      bobPhase: rng() * Math.PI * 2,
      hitTimer: 0,
      hitVelX: 0,
      hitVelY: 0,
      outerHitTimer: 0,
    });
  }

  return buoys;
}

function minDistanceToCourse(x, y, pts, buoys) {
  let minD = Infinity;
  // Check every 2nd spline point for speed (~120 pts)
  for (let i = 0; i < pts.length; i += 2) {
    const d = dist(x, y, pts[i].x, pts[i].y);
    if (d < minD) minD = d;
  }
  for (let i = 0; i < buoys.length; i++) {
    const b = buoys[i];
    const d1 = dist(x, y, b.x, b.y);
    const d2 = dist(x, y, b.outerX, b.outerY);
    if (d1 < minD) minD = d1;
    if (d2 < minD) minD = d2;
  }
  return minD;
}

function buildOrganicPolygon(cx, cy, radius, vertexCount, rng, irregularity = 0.22) {
  const pts = [];
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  for (let i = 0; i < vertexCount; i++) {
    const a = (i / vertexCount) * Math.PI * 2;
    const wave =
      Math.sin(a * 2 + phase1) * (irregularity * 0.45) +
      Math.cos(a * 3 + phase2) * (irregularity * 0.35) +
      (rng() - 0.5) * (irregularity * 0.35);
    const r = radius * clamp(0.88 + wave, 0.72, 1.0);
    pts.push({
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r,
    });
  }
  return pts;
}

function generateScenery(pts, buoys, startLine, corridorHalfWidth, rng) {
  // Bottom RC Yacht Club Pier & rocky shoreline (strictly y >= 908, outside BAY_BOUNDS maxY = 895)
  const pierWidth = 144;
  const pierHeight = 92;
  const pier = {
    x: Math.round(WORLD_WIDTH * 0.5 - pierWidth * 0.5 + (rng() - 0.5) * 80),
    y: SHORELINE_Y - 7,
    width: pierWidth,
    height: pierHeight,
  };

  // Gently undulating bottom shoreline contour (always y >= SHORELINE_Y)
  const shorelinePoints = [];
  const shoreSteps = 32;
  const pA = rng() * Math.PI * 2;
  const pB = rng() * Math.PI * 2;
  for (let i = 0; i <= shoreSteps; i++) {
    const x = (i / shoreSteps) * WORLD_WIDTH;
    const y = SHORELINE_Y + 12 + Math.sin(i * 0.55 + pA) * 8 + Math.cos(i * 1.15 + pB) * 5;
    shorelinePoints.push({ x, y: Math.max(SHORELINE_Y + 2, y) });
  }
  const shoreline = {
    y: SHORELINE_Y,
    points: shorelinePoints,
  };

  // Scan bay grid to find high-clearance zones for islands (guaranteed outside track corridor!)
  const candidates = [];
  const stepX = 64;
  const stepY = 56;
  for (let x = 76; x <= WORLD_WIDTH - 76; x += stepX) {
    for (let y = 68; y <= SHORELINE_Y - 58; y += stepY) {
      const dTrack = minDistanceToCourse(x, y, pts, buoys);
      const maxIslandRadius = dTrack - corridorHalfWidth - 36;
      if (maxIslandRadius >= 24) {
        candidates.push({
          x: x + (rng() - 0.5) * 18,
          y: y + (rng() - 0.5) * 16,
          clearance: maxIslandRadius,
        });
      }
    }
  }

  // Sort by highest clearance with slight randomness to get varied island layouts
  candidates.sort((a, b) => (b.clearance + (rng() - 0.5) * 28) - (a.clearance + (rng() - 0.5) * 28));

  const targetIslands = 3 + Math.floor(rng() * 3); // 3..5 islands
  const islands = [];

  for (const cand of candidates) {
    if (islands.length >= targetIslands) break;

    const dTrack = minDistanceToCourse(cand.x, cand.y, pts, buoys);
    const maxRadius = dTrack - corridorHalfWidth - 36;
    if (maxRadius < 24) continue;

    // Keep clear of pier & world borders
    const maxBottomRadius = SHORELINE_Y - 26 - cand.y;
    const maxEdgeRadius = Math.min(cand.x - 24, WORLD_WIDTH - 24 - cand.x, cand.y - 24, maxBottomRadius);
    const radius = clamp(Math.min(maxRadius, maxEdgeRadius, 36 + rng() * 44), 24, 78);
    if (radius < 24 || radius > maxRadius || radius > maxEdgeRadius) continue;

    // Ensure separation from already-placed islands
    let overlaps = false;
    for (const isl of islands) {
      if (dist(cand.x, cand.y, isl.x, isl.y) < radius + isl.radius + 48) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    const points = buildOrganicPolygon(cand.x, cand.y, radius, 14, rng, 0.24);
    const beachPoints = points.map((pt) => ({
      x: cand.x + (pt.x - cand.x) * 0.80,
      y: cand.y + (pt.y - cand.y) * 0.80,
    }));

    // Foliage clusters inside island interior
    const foliageCount = Math.max(3, Math.floor(radius / 10));
    const foliage = [];
    for (let f = 0; f < foliageCount; f++) {
      const a = (f / foliageCount) * Math.PI * 2 + rng() * 0.7;
      const fr = rng() * radius * 0.44;
      foliage.push({
        x: cand.x + Math.cos(a) * fr,
        y: cand.y + Math.sin(a) * fr,
        r: clamp(radius * (0.16 + rng() * 0.14), 6, 18),
        shade: rng(),
        type: rng() < 0.6 ? 'pine' : 'palm',
      });
    }

    islands.push({
      x: cand.x,
      y: cand.y,
      radius,
      points,
      beachPoints,
      foliage,
      hasLighthouse: false,
      lighthousePos: null,
    });
  }

  // Fallback corner islands if a very wide track left fewer than 2 islands
  if (islands.length < 2) {
    const cornerSpots = [
      { x: 66, y: 66 },
      { x: WORLD_WIDTH - 66, y: 66 },
      { x: 68, y: SHORELINE_Y - 56 },
      { x: WORLD_WIDTH - 68, y: SHORELINE_Y - 56 },
    ];
    for (const spot of cornerSpots) {
      if (islands.length >= 2) break;
      const dTrack = minDistanceToCourse(spot.x, spot.y, pts, buoys);
      const maxR = dTrack - corridorHalfWidth - 28;
      if (maxR < 20) continue;
      let tooClose = false;
      for (const isl of islands) {
        if (dist(spot.x, spot.y, isl.x, isl.y) < isl.radius + 54) tooClose = true;
      }
      if (tooClose) continue;
      const radius = clamp(maxR, 20, 40);
      const points = buildOrganicPolygon(spot.x, spot.y, radius, 12, rng, 0.2);
      islands.push({
        x: spot.x,
        y: spot.y,
        radius,
        points,
        beachPoints: points.map((pt) => ({
          x: spot.x + (pt.x - spot.x) * 0.8,
          y: spot.y + (pt.y - spot.y) * 0.8,
        })),
        foliage: [
          { x: spot.x - 4, y: spot.y - 3, r: radius * 0.25, shade: 0.4, type: 'pine' },
          { x: spot.x + 5, y: spot.y + 4, r: radius * 0.22, shade: 0.7, type: 'palm' },
        ],
        hasLighthouse: false,
        lighthousePos: null,
      });
    }
  }

  // Assign Lighthouse to the largest island
  if (islands.length > 0) {
    let lhIdx = 0;
    for (let i = 1; i < islands.length; i++) {
      if (islands[i].radius > islands[lhIdx].radius) lhIdx = i;
    }
    const lhIsland = islands[lhIdx];
    lhIsland.hasLighthouse = true;
    lhIsland.lighthousePos = {
      x: lhIsland.x + (rng() - 0.5) * lhIsland.radius * 0.2,
      y: lhIsland.y + (rng() - 0.5) * lhIsland.radius * 0.2,
    };
  }

  // Scattered coastal rocks guaranteed outside track corridor
  const rocks = [];
  const targetRocks = 7 + Math.floor(rng() * 5); // 7..11 rocks
  for (let attempt = 0; attempt < 180 && rocks.length < targetRocks; attempt++) {
    const rx = 42 + rng() * (WORLD_WIDTH - 84);
    const ry = 42 + rng() * (SHORELINE_Y - 78);
    const radius = 10 + rng() * 11;
    const dTrack = minDistanceToCourse(rx, ry, pts, buoys);
    if (dTrack < corridorHalfWidth + radius + 28) continue;

    let blocked = false;
    for (const isl of islands) {
      if (dist(rx, ry, isl.x, isl.y) < isl.radius + radius + 16) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const r of rocks) {
      if (dist(rx, ry, r.x, r.y) < r.radius + radius + 22) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    rocks.push({
      x: rx,
      y: ry,
      radius,
      points: buildOrganicPolygon(rx, ry, radius, 8, rng, 0.28),
      rotation: rng() * Math.PI * 2,
      shade: 0.35 + rng() * 0.4,
    });
  }

  // 2-3 moored spectator boats outside the navigable course
  const spectatorBoats = [];
  const targetSpectators = 2 + (rng() < 0.65 ? 1 : 0); // 2 or 3
  const specColors = [
    { hullColor: '#F8FAFC', cabinColor: '#0EA5E9', accentColor: '#0369A1' },
    { hullColor: '#FFFBEB', cabinColor: '#E11D48', accentColor: '#9F1239' },
    { hullColor: '#F1F5F9', cabinColor: '#14B8A6', accentColor: '#0F766E' },
  ];

  for (let attempt = 0; attempt < 220 && spectatorBoats.length < targetSpectators; attempt++) {
    const sx = 68 + rng() * (WORLD_WIDTH - 136);
    const sy = 64 + rng() * (SHORELINE_Y - 110);
    const dTrack = minDistanceToCourse(sx, sy, pts, buoys);
    if (dTrack < corridorHalfWidth + 46) continue;

    // Keep clear of islands, rocks, pier, and other spectator boats
    let blocked = false;
    for (const isl of islands) {
      if (dist(sx, sy, isl.x, isl.y) < isl.radius + 40) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const r of rocks) {
      if (dist(sx, sy, r.x, r.y) < r.radius + 32) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const sb of spectatorBoats) {
      if (dist(sx, sy, sb.x, sb.y) < 95) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    // Face loosely toward the nearest part of the race course
    let nearestPt = startLine;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i += 6) {
      const d = dist(sx, sy, pts[i].x, pts[i].y);
      if (d < bestD) {
        bestD = d;
        nearestPt = pts[i];
      }
    }
    const heading = Math.atan2(nearestPt.y - sy, nearestPt.x - sx) + (rng() - 0.5) * 0.45;
    const palette = specColors[spectatorBoats.length % specColors.length];

    spectatorBoats.push({
      x: sx,
      y: sy,
      heading,
      length: 34 + rng() * 10,
      width: 14 + rng() * 3,
      hullColor: palette.hullColor,
      cabinColor: palette.cabinColor,
      accentColor: palette.accentColor,
      bobPhase: rng() * Math.PI * 2,
    });
  }

  return {
    pier,
    shoreline,
    islands,
    rocks,
    spectatorBoats,
  };
}

function buildNauticalName(rng) {
  const prefix = NAME_PREFIXES[Math.floor(rng() * NAME_PREFIXES.length)];
  const noun = NAME_NOUNS[Math.floor(rng() * NAME_NOUNS.length)];
  const suffix = NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)];
  return `${prefix} ${noun} ${suffix}`;
}

/**
 * Generate a fresh, validated closed ocean racing course.
 * @param {number|string} [seed]
 */
export function generateCourse(seed) {
  const resolvedSeed = hashSeed(seed);
  const rng = createRng(resolvedSeed);
  const name = buildNauticalName(rng);

  const archetypeStart = Math.floor(rng() * ARCHETYPES.length);
  const direction = rng() < 0.5 ? 1 : -1; // 1 = CW, -1 = CCW

  const centerX = WORLD_WIDTH * 0.5;
  const centerY = (BAY_BOUNDS.minY + BAY_BOUNDS.maxY) * 0.5;
  const baseRx = 580;
  const baseRy = 295;

  for (let attempt = 0; attempt < 48; attempt++) {
    const arch = ARCHETYPES[(archetypeStart + Math.floor(attempt / 8)) % ARCHETYPES.length];
    const jitterScale = attempt < 24 ? 1.0 : (attempt < 40 ? 0.45 : 0.0);
    const flipX = rng() < 0.5 ? -1 : 1;
    const flipY = rng() < 0.3 ? -1 : 1;
    const scaleX = 0.94 + rng() * 0.08;
    const scaleY = 0.93 + rng() * 0.09;
    const corridorHalfWidth = Math.round(clamp(arch.corridorHalfWidth + (rng() - 0.5) * 10, 86, 102));

    let ctrl = arch.points.map(([u, v]) => {
      const ju = u * flipX * scaleX + (rng() - 0.5) * 0.12 * jitterScale;
      const jv = v * flipY * scaleY + (rng() - 0.5) * 0.12 * jitterScale;
      return {
        x: centerX + ju * baseRx,
        y: centerY + jv * baseRy,
      };
    });

    // Ensure polygon matches target direction (1 = CW signedArea > 0, -1 = CCW signedArea < 0)
    const area = computeSignedArea(ctrl);
    if ((direction > 0 && area < 0) || (direction < 0 && area > 0)) {
      ctrl.reverse();
    }

    const { points, totalLength } = buildClosedSpline(ctrl, SPLINE_SAMPLE_COUNT);
    if (!validateSplineGeometry(points, totalLength, corridorHalfWidth)) {
      continue;
    }

    const startIdx = findStartLineIndex(points);
    const splinePoints = rotateSplineToStart(points, startIdx, totalLength);

    const p0 = splinePoints[0];
    const startHalfWidth = corridorHalfWidth * 0.84;
    const startLine = {
      x: p0.x,
      y: p0.y,
      tx: p0.tx,
      ty: p0.ty,
      nx: p0.nx,
      ny: p0.ny,
      halfWidth: startHalfWidth,
      left: { x: p0.x - p0.nx * startHalfWidth, y: p0.y - p0.ny * startHalfWidth },
      right: { x: p0.x + p0.nx * startHalfWidth, y: p0.y + p0.ny * startHalfWidth },
    };

    // Ensure start line endpoints sit safely in BAY_BOUNDS
    if (
      startLine.left.x < BAY_BOUNDS.minX + 10 || startLine.left.x > BAY_BOUNDS.maxX - 10 ||
      startLine.left.y < BAY_BOUNDS.minY + 10 || startLine.left.y > BAY_BOUNDS.maxY - 10 ||
      startLine.right.x < BAY_BOUNDS.minX + 10 || startLine.right.x > BAY_BOUNDS.maxX - 10 ||
      startLine.right.y < BAY_BOUNDS.minY + 10 || startLine.right.y > BAY_BOUNDS.maxY - 10
    ) {
      continue;
    }

    const buoys = placeCourseBuoys(splinePoints, totalLength, corridorHalfWidth, direction, rng);
    if (!buoys) continue;

    const scenery = generateScenery(splinePoints, buoys, startLine, corridorHalfWidth, rng);

    return {
      seed: resolvedSeed,
      name,
      archetype: arch.name,
      direction,
      corridorHalfWidth,
      totalLength,
      splinePoints,
      buoys,
      startLine,
      scenery,
      bounds: BAY_BOUNDS,
    };
  }

  // Deterministic guaranteed-valid fallback (clean Tri-Oval Bay)
  const fallbackArch = ARCHETYPES[2];
  const fallbackCtrl = fallbackArch.points.map(([u, v]) => ({
    x: centerX + u * 550,
    y: centerY + v * 280,
  }));
  if (direction < 0) fallbackCtrl.reverse();
  const { points, totalLength } = buildClosedSpline(fallbackCtrl, SPLINE_SAMPLE_COUNT);
  const startIdx = findStartLineIndex(points);
  const splinePoints = rotateSplineToStart(points, startIdx, totalLength);
  const corridorHalfWidth = 94;
  const p0 = splinePoints[0];
  const startHalfWidth = corridorHalfWidth * 0.84;
  const startLine = {
    x: p0.x,
    y: p0.y,
    tx: p0.tx,
    ty: p0.ty,
    nx: p0.nx,
    ny: p0.ny,
    halfWidth: startHalfWidth,
    left: { x: p0.x - p0.nx * startHalfWidth, y: p0.y - p0.ny * startHalfWidth },
    right: { x: p0.x + p0.nx * startHalfWidth, y: p0.y + p0.ny * startHalfWidth },
  };
  const buoys = placeCourseBuoys(splinePoints, totalLength, corridorHalfWidth, direction, rng);
  const scenery = generateScenery(splinePoints, buoys, startLine, corridorHalfWidth, rng);

  return {
    seed: resolvedSeed,
    name,
    archetype: fallbackArch.name,
    direction,
    corridorHalfWidth,
    totalLength,
    splinePoints,
    buoys,
    startLine,
    scenery,
    bounds: BAY_BOUNDS,
  };
}

/**
 * Sample a point, unit tangent, unit right-hand normal, arc length, and curvature along the closed spline.
 * @param {object} course
 * @param {number} t
 */
export function sampleSpline(course, t) {
  const pts = course.splinePoints;
  const n = pts.length;
  const wt = wrapT(t);
  const scaled = wt * n;
  const i0 = Math.floor(scaled) % n;
  const i1 = (i0 + 1) % n;
  const f = scaled - Math.floor(scaled);

  const a = pts[i0];
  const b = pts[i1];

  const x = a.x + (b.x - a.x) * f;
  const y = a.y + (b.y - a.y) * f;
  let tx = a.tx + (b.tx - a.tx) * f;
  let ty = a.ty + (b.ty - a.ty) * f;
  const tLen = Math.hypot(tx, ty) || 1;
  tx /= tLen;
  ty /= tLen;

  return {
    x,
    y,
    tx,
    ty,
    nx: -ty,
    ny: tx,
    s: wt * course.totalLength,
    t: wt,
    curvature: a.curvature + (b.curvature - a.curvature) * f,
  };
}

/**
 * Project an arbitrary world point (x, y) onto the closest position on the course spline.
 * @param {object} course
 * @param {number} x
 * @param {number} y
 */
export function projectPointOnCourse(course, x, y) {
  const pts = course.splinePoints;
  const n = pts.length;
  let bestDistSq = Infinity;
  let bestIdx = 0;
  let bestFrac = 0;
  let bestPx = pts[0].x;
  let bestPy = pts[0].y;

  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLenSq = abx * abx + aby * aby || 1e-6;
    const frac = clamp(((x - a.x) * abx + (y - a.y) * aby) / abLenSq, 0, 1);
    const px = a.x + abx * frac;
    const py = a.y + aby * frac;
    const dx = x - px;
    const dy = y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
      bestFrac = frac;
      bestPx = px;
      bestPy = py;
    }
  }

  const a = pts[bestIdx];
  const b = pts[(bestIdx + 1) % n];
  let tx = a.tx + (b.tx - a.tx) * bestFrac;
  let ty = a.ty + (b.ty - a.ty) * bestFrac;
  const tLen = Math.hypot(tx, ty) || 1;
  tx /= tLen;
  ty /= tLen;
  const nx = -ty;
  const ny = tx;

  const t = wrapT((bestIdx + bestFrac) / n);
  const signedOffset = (x - bestPx) * nx + (y - bestPy) * ny;

  return {
    t,
    s: t * course.totalLength,
    x: bestPx,
    y: bestPy,
    tx,
    ty,
    nx,
    ny,
    distance: Math.sqrt(bestDistSq),
    signedOffset,
    curvature: a.curvature + (b.curvature - a.curvature) * bestFrac,
    segmentIndex: bestIdx,
  };
}
