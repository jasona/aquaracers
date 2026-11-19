import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SHORELINE_Y,
  BAY_BOUNDS,
  TOTAL_LAPS,
  COUNTDOWN_SECONDS,
  BOAT_COUNT,
  PENALTY_JUMP_START,
  PENALTY_BUOY_HIT,
  PENALTY_COURSE_CUT,
  BUOY_HIT_COOLDOWN,
  CAREER_STORAGE_KEY,
  BOAT_PRESETS,
  PHYSICS,
} from '../src/constants.js';

import {
  generateCourse,
  sampleSpline,
  projectPointOnCourse,
  wrapT,
} from '../src/course.js';

import {
  createBoats,
  updatePhysics,
  getBoatCollisionRadius,
} from '../src/physics.js';

import {
  createRaceState,
  updateRaceRules,
  computeStandings,
  loadCareerRecord,
  saveCareerRecord,
  recordRaceResult,
  resetCareerRecord,
} from '../src/rules.js';

import { createAudioEngine } from '../src/audio.js';

// Geometry helper: strict segment intersection test
function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function minDistanceToSpline(x, y, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = pointToSegmentDist(x, y, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

function createMockStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

function assertAllBoatFieldsFinite(boat) {
  const numericFields = [
    'x', 'y', 'vx', 'vy', 'speed', 'heading', 'angularVel',
    'throttle', 'steer', 'rudderAngle', 'rollAngle', 'pitchBounce',
    'wakeTurbulence', 'antennaFlex', 'lapProgress', 'totalProgress', 'penalties',
  ];
  for (const field of numericFields) {
    assert.ok(
      Number.isFinite(boat[field]),
      `Boat ${boat.id} has non-finite field ${field}=${boat[field]}`
    );
  }
}

// ============================================================================
// 1. CONSTANTS & SHARED CONFIGURATION
// ============================================================================
test('Constants define valid world, penalties, and 5 distinctive RC boat presets', () => {
  assert.equal(WORLD_WIDTH, 1600);
  assert.equal(WORLD_HEIGHT, 1000);
  assert.equal(SHORELINE_Y, 915);
  assert.equal(TOTAL_LAPS, 3);
  assert.equal(COUNTDOWN_SECONDS, 3);
  assert.equal(BOAT_COUNT, 5);
  assert.equal(PENALTY_JUMP_START, 2.0);
  assert.equal(PENALTY_BUOY_HIT, 1.5);
  assert.equal(PENALTY_COURSE_CUT, 3.0);
  assert.equal(CAREER_STORAGE_KEY, 'aquaracers_career_v1');

  assert.equal(BOAT_PRESETS.length, 5);
  assert.equal(BOAT_PRESETS[0].isPlayer, true);
  assert.equal(BOAT_PRESETS[0].number, '01');
  const ids = new Set(BOAT_PRESETS.map((b) => b.id));
  const names = new Set(BOAT_PRESETS.map((b) => b.name));
  const aiStyles = new Set(BOAT_PRESETS.slice(1).map((b) => b.aiStyle));
  assert.equal(ids.size, 5);
  assert.equal(names.size, 5);
  assert.ok(aiStyles.size >= 4, 'AI opponents should have 4 distinct racing styles');
  for (const ai of BOAT_PRESETS.slice(1)) {
    assert.equal(ai.isPlayer, false);
    assert.ok(ai.skill >= 0.90 && ai.skill <= 1.05, `AI skill out of range: ${ai.skill}`);
  }
});

// ============================================================================
// 2. PROCEDURAL COURSE GENERATOR (src/course.js)
// ============================================================================
test('Procedural Course Generator: 40 seeds have zero self-intersections, valid bounds, clearance, buoys & scenery', () => {
  const archetypesSeen = new Set();
  const directionsSeen = new Set();
  const namesSeen = new Set();
  const startSignatures = new Set();

  const seeds = [];
  for (let i = 1; i <= 35; i++) seeds.push(i * 7919 + 13);
  seeds.push('emerald-shoals', 'pelican-point', 'sunset-gp', 'aqua-2026', 'mariner-cup');

  for (const seed of seeds) {
    const course = generateCourse(seed);

    assert.ok(course.name && typeof course.name === 'string');
    assert.ok(course.archetype && typeof course.archetype === 'string');
    assert.ok(course.direction === 1 || course.direction === -1);
    assert.ok(course.corridorHalfWidth >= 86 && course.corridorHalfWidth <= 102,
      `corridorHalfWidth out of range: ${course.corridorHalfWidth}`);
    assert.ok(course.splinePoints.length >= 200, 'Spline should be densely sampled');
    assert.ok(course.totalLength > 1200, 'Course totalLength should be substantial');

    archetypesSeen.add(course.archetype);
    directionsSeen.add(course.direction);
    namesSeen.add(course.name);
    startSignatures.add(`${Math.round(course.startLine.x / 40)},${Math.round(course.startLine.y / 40)},${course.archetype},${course.direction}`);

    const pts = course.splinePoints;
    const n = pts.length;

    // 1. All spline points safely inside bay bounds and above bottom pier/shoreline
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(
        p.x >= BAY_BOUNDS.minX && p.x <= BAY_BOUNDS.maxX &&
        p.y >= BAY_BOUNDS.minY && p.y <= BAY_BOUNDS.maxY,
        `Seed ${seed}: spline point ${i} (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) outside BAY_BOUNDS`
      );
      assert.ok(p.y < SHORELINE_Y - 15, `Seed ${seed}: spline point too close to shoreline`);
    }

    // 2. Zero self-intersections between non-adjacent segments
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j];
        const d = pts[(j + 1) % n];
        assert.equal(
          segmentsIntersect(a, b, c, d),
          false,
          `Seed ${seed}: spline self-intersection between segments ${i} and ${j}`
        );
      }
    }

    // 3. Minimum clearance between non-adjacent spline points (>= corridorHalfWidth * 2.35)
    const minNonAdjArc = Math.max(course.corridorHalfWidth * 3.8, course.totalLength * 0.14);
    const minClearance = course.corridorHalfWidth * 2.35;
    for (let i = 0; i < n; i += 2) {
      for (let j = i + 2; j < n; j += 2) {
        const rawArc = Math.abs(pts[j].s - pts[i].s);
        const arcDist = Math.min(rawArc, course.totalLength - rawArc);
        if (arcDist < minNonAdjArc) continue;
        const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
        assert.ok(
          d >= minClearance - 2,
          `Seed ${seed}: non-adjacent segments ${i} & ${j} too close (${d.toFixed(1)} < ${minClearance.toFixed(1)})`
        );
      }
    }

    // 4. Start line validity
    const sl = course.startLine;
    assert.ok(sl && Number.isFinite(sl.x) && Number.isFinite(sl.y));
    assert.ok(Math.abs(Math.hypot(sl.tx, sl.ty) - 1) < 1e-4);
    assert.ok(Math.abs(Math.hypot(sl.nx, sl.ny) - 1) < 1e-4);
    assert.ok(sl.left.y < SHORELINE_Y && sl.right.y < SHORELINE_Y);

    // 5. Buoys: 5 to 8 ordered buoys safely inside bay bounds and above shoreline
    assert.ok(
      course.buoys.length >= 5 && course.buoys.length <= 8,
      `Seed ${seed}: expected 5-8 buoys, got ${course.buoys.length}`
    );
    let prevT = -1;
    for (let bIdx = 0; bIdx < course.buoys.length; bIdx++) {
      const b = course.buoys[bIdx];
      assert.equal(b.index, bIdx);
      assert.ok(b.splineT > prevT && b.splineT < 1, `Seed ${seed}: buoys not strictly ordered by splineT`);
      prevT = b.splineT;
      assert.equal(b.radius, 11);
      assert.ok(Math.abs(Math.hypot(b.dirX, b.dirY) - 1) < 1e-3);
      assert.ok(Math.abs(Math.hypot(b.outX, b.outY) - 1) < 1e-3);
      assert.ok(b.turnSide === 'left' || b.turnSide === 'right');

      // Apex buoy & outer marker inside bay and well above pier/shoreline
      assert.ok(
        b.x >= BAY_BOUNDS.minX && b.x <= BAY_BOUNDS.maxX &&
        b.y >= BAY_BOUNDS.minY && b.y <= BAY_BOUNDS.maxY,
        `Seed ${seed}: buoy ${bIdx} (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) outside BAY_BOUNDS`
      );
      assert.ok(b.y < SHORELINE_Y - 18, `Seed ${seed}: buoy ${bIdx} intrudes on bottom shoreline/pier`);
      assert.ok(
        b.outerX >= 20 && b.outerX <= WORLD_WIDTH - 20 &&
        b.outerY >= 20 && b.outerY < SHORELINE_Y - 8,
        `Seed ${seed}: outer buoy ${bIdx} (${b.outerX.toFixed(1)}, ${b.outerY.toFixed(1)}) out of water`
      );
    }

    // 6. Scenery: pier, shoreline, 2-5 islands (1 lighthouse), rocks, 2-3 spectator boats — none overlapping corridor
    const sc = course.scenery;
    assert.ok(sc.pier && sc.pier.y >= SHORELINE_Y - 45);
    assert.ok(Array.isArray(sc.islands) && sc.islands.length >= 2 && sc.islands.length <= 5,
      `Seed ${seed}: expected 2-5 islands, got ${sc.islands?.length}`);
    assert.ok(sc.islands.some((isl) => isl.hasLighthouse === true),
      `Seed ${seed}: expected at least one island with a lighthouse`);

    for (const isl of sc.islands) {
      const dTrack = minDistanceToSpline(isl.x, isl.y, pts);
      assert.ok(
        dTrack >= course.corridorHalfWidth + isl.radius - 2,
        `Seed ${seed}: island overlaps navigable corridor (d=${dTrack.toFixed(1)}, need >= ${(course.corridorHalfWidth + isl.radius).toFixed(1)})`
      );
    }

    assert.ok(Array.isArray(sc.rocks));
    for (const rock of sc.rocks) {
      const dTrack = minDistanceToSpline(rock.x, rock.y, pts);
      assert.ok(
        dTrack >= course.corridorHalfWidth + rock.radius - 2,
        `Seed ${seed}: rock overlaps navigable corridor (d=${dTrack.toFixed(1)}, need >= ${(course.corridorHalfWidth + rock.radius).toFixed(1)})`
      );
    }

    assert.ok(Array.isArray(sc.spectatorBoats) && sc.spectatorBoats.length >= 1 && sc.spectatorBoats.length <= 3);
    for (const sb of sc.spectatorBoats) {
      const dTrack = minDistanceToSpline(sb.x, sb.y, pts);
      assert.ok(
        dTrack >= course.corridorHalfWidth + 20,
        `Seed ${seed}: spectator boat overlaps corridor (d=${dTrack.toFixed(1)})`
      );
    }
  }

  // Distinct course variety across seeds
  assert.ok(archetypesSeen.size >= 4, `Expected varied archetypes, saw only: ${[...archetypesSeen].join(', ')}`);
  assert.equal(directionsSeen.size, 2, 'Expected both CW (1) and CCW (-1) courses');
  assert.ok(namesSeen.size >= 25, `Expected distinct procedural names, saw ${namesSeen.size}`);
  assert.ok(startSignatures.size >= 12, `Expected varied course layouts, saw ${startSignatures.size}`);

  // Determinism check: same seed generates identical course
  const cA = generateCourse(123456);
  const cB = generateCourse(123456);
  assert.equal(cA.name, cB.name);
  assert.equal(cA.archetype, cB.archetype);
  assert.equal(cA.direction, cB.direction);
  assert.equal(cA.buoys.length, cB.buoys.length);
  assert.equal(cA.splinePoints[0].x, cB.splinePoints[0].x);
});

test('Course spline utilities: wrapT, sampleSpline, projectPointOnCourse', () => {
  assert.equal(wrapT(0), 0);
  assert.ok(Math.abs(wrapT(-0.25) - 0.75) < 1e-9);
  assert.ok(Math.abs(wrapT(1.35) - 0.35) < 1e-9);

  const course = generateCourse(4242);
  for (const t of [0, 0.17, 0.5, 0.83]) {
    const pt = sampleSpline(course, t);
    const proj = projectPointOnCourse(course, pt.x + pt.nx * 20, pt.y + pt.ny * 20);
    assert.ok(Math.abs(proj.distance - 20) < 2.5, `Projection distance mismatch: ${proj.distance}`);
    assert.ok(Math.abs(proj.signedOffset - 20) < 2.5, `Projection signedOffset mismatch: ${proj.signedOffset}`);
    const dt = Math.min(Math.abs(proj.t - t), 1 - Math.abs(proj.t - t));
    assert.ok(dt < 0.02, `Projection t mismatch: expected ~${t}, got ${proj.t}`);
  }
});

// ============================================================================
// 3. PHYSICS & AI (src/physics.js) + AUDIO SAFETY (src/audio.js)
// ============================================================================
test('Physics: player acceleration, reverse/braking, steering, roll/rudder/wake trail', () => {
  const course = generateCourse(1001);
  const boats = createBoats(course);
  const raceState = createRaceState(course);
  raceState.phase = 'racing';
  raceState.countdown = 0;

  assert.equal(boats.length, BOAT_COUNT);
  assert.equal(getBoatCollisionRadius(), PHYSICS.boatRadius);
  const player = boats[0];
  assert.equal(player.isPlayer, true);

  // Starting grid check across multiple seeds: no boats spawn overlapping (< 2 * boatRadius)
  // and countdown ticks keep wakeTurbulence clean (0) without grid jostling
  for (const gridSeed of [1001, 2025, 3030, 4040, 5050, 6060]) {
    const gc = generateCourse(gridSeed);
    const gBoats = createBoats(gc);
    const minSep = PHYSICS.boatRadius * 2;
    for (let i = 0; i < gBoats.length; i++) {
      for (let j = i + 1; j < gBoats.length; j++) {
        const sep = Math.hypot(gBoats[i].x - gBoats[j].x, gBoats[i].y - gBoats[j].y);
        assert.ok(
          sep >= minSep,
          `Seed ${gridSeed}: starting grid boats ${i} & ${j} overlap (sep=${sep.toFixed(1)} < ${minSep})`
        );
      }
    }
    const gRace = createRaceState(gc);
    for (let k = 0; k < 30; k++) {
      updatePhysics(gBoats, gc, { throttle: 0, steer: 0 }, gRace, 1 / 60);
    }
    assert.ok(
      gBoats[0].wakeTurbulence < 0.05,
      `Seed ${gridSeed}: player had unexpected wakeTurbulence=${gBoats[0].wakeTurbulence} during idle countdown`
    );
  }

  // Place player on the clean startLine straightaway to test pure open-water hydrodynamics
  const sl = course.startLine;
  player.x = sl.x - sl.tx * 50;
  player.y = sl.y - sl.ty * 50;
  player.heading = Math.atan2(sl.ty, sl.tx);
  player.vx = 0;
  player.vy = 0;
  player.speed = 0;
  player.wakeTrail = [];

  const dt = 1 / 60;
  // 1. Accelerate straight ahead for 1.5s along the open start straight
  for (let i = 0; i < 90; i++) {
    updatePhysics([player], course, { throttle: 1, steer: 0 }, raceState, dt);
  }
  const speedAfterAccel = player.speed;
  assert.ok(speedAfterAccel > 220 && speedAfterAccel < 340,
    `Expected planing speed ~250-310 px/s, got ${speedAfterAccel.toFixed(1)}`);
  assert.ok(player.wakeTrail.length >= 10, `Expected wakeTrail samples, got ${player.wakeTrail.length}`);
  assertAllBoatFieldsFinite(player);

  // 2. Steer right while maintaining throttle for 0.6s
  const headingBeforeSteer = player.heading;
  for (let i = 0; i < 36; i++) {
    updatePhysics([player], course, { throttle: 1, steer: 1 }, raceState, dt);
  }
  let headingDelta = player.heading - headingBeforeSteer;
  while (headingDelta > Math.PI) headingDelta -= Math.PI * 2;
  while (headingDelta < -Math.PI) headingDelta += Math.PI * 2;
  assert.ok(headingDelta > 0.35, `Expected positive heading change on right steer, got ${headingDelta}`);
  assert.ok(Math.abs(player.rudderAngle) > 0.2, `Expected non-zero rudderAngle, got ${player.rudderAngle}`);
  assert.ok(Math.abs(player.rollAngle) > 0.08, `Expected hull banking rollAngle, got ${player.rollAngle}`);
  assert.ok(Math.abs(player.antennaFlex) > 0.01, `Expected flexing antennaFlex, got ${player.antennaFlex}`);

  // 3. Brake / reverse for 1.5s -> speed drops cleanly and reverses
  for (let i = 0; i < 90; i++) {
    updatePhysics([player], course, { throttle: -1, steer: 0 }, raceState, dt);
  }
  const forwardVel = player.vx * Math.cos(player.heading) + player.vy * Math.sin(player.heading);
  assert.ok(forwardVel < speedAfterAccel * 0.35,
    `Expected brake/reverse to slow boat significantly (was ${speedAfterAccel.toFixed(1)}, now forwardVel=${forwardVel.toFixed(1)})`);
  assertAllBoatFieldsFinite(player);
});

test('Physics: boat-to-boat, boundary, shoreline, and island collisions keep boats safe & finite', () => {
  const course = generateCourse(2025);
  const boats = createBoats(course);
  const raceState = createRaceState(course);
  raceState.phase = 'racing';
  raceState.countdown = 0;
  const dt = 1 / 60;

  // 1. Head-on boat-to-boat collision
  const b0 = boats[0];
  const b1 = boats[1];
  b0.x = 770; b0.y = 500; b0.heading = 0; b0.vx = 220; b0.vy = 0; b0.speed = 220;
  b1.x = 805; b1.y = 500; b1.heading = Math.PI; b1.vx = -220; b1.vy = 0; b1.speed = 220;
  for (let i = 0; i < 30; i++) {
    updatePhysics([b0, b1], course, { throttle: 1, steer: 0 }, raceState, dt);
  }
  const sep = Math.hypot(b0.x - b1.x, b0.y - b1.y);
  assert.ok(sep >= PHYSICS.boatRadius * 1.8, `Boats should not remain deeply overlapped (sep=${sep.toFixed(1)})`);
  assertAllBoatFieldsFinite(b0);
  assertAllBoatFieldsFinite(b1);

  // 2. Drive boat straight into bottom shoreline/pier
  b0.x = 800; b0.y = SHORELINE_Y - 25; b0.heading = Math.PI / 2; b0.vx = 0; b0.vy = 260; b0.speed = 260;
  for (let i = 0; i < 60; i++) {
    updatePhysics([b0], course, { throttle: 1, steer: 0 }, raceState, dt);
    assert.ok(b0.y < SHORELINE_Y + 2, `Boat crossed bottom shoreline: y=${b0.y}`);
    assertAllBoatFieldsFinite(b0);
  }

  // 3. Drive boat straight into left/top boundaries
  b0.x = BAY_BOUNDS.minX + 10; b0.y = 400; b0.heading = Math.PI; b0.vx = -260; b0.vy = 0;
  for (let i = 0; i < 60; i++) {
    updatePhysics([b0], course, { throttle: 1, steer: 0 }, raceState, dt);
    assert.ok(b0.x >= 0 && b0.x <= WORLD_WIDTH && b0.y >= 0 && b0.y <= WORLD_HEIGHT);
    assertAllBoatFieldsFinite(b0);
  }

  // 4. Drive boat straight into an interior island from inside the bay
  const interiorIsland = course.scenery.islands.find(
    (isl) => isl.x > BAY_BOUNDS.minX + 120 && isl.x < BAY_BOUNDS.maxX - 120 &&
             isl.y > BAY_BOUNDS.minY + 120 && isl.y < BAY_BOUNDS.maxY - 120
  ) || course.scenery.islands[0];
  const approachDirX = interiorIsland.x < WORLD_WIDTH / 2 ? 1 : -1;
  const approachDirY = interiorIsland.y < WORLD_HEIGHT / 2 ? 1 : -1;
  const norm = Math.hypot(approachDirX, approachDirY);
  const ax = approachDirX / norm;
  const ay = approachDirY / norm;
  b0.x = interiorIsland.x + ax * (interiorIsland.radius + PHYSICS.boatRadius + 18);
  b0.y = interiorIsland.y + ay * (interiorIsland.radius + PHYSICS.boatRadius + 18);
  b0.heading = Math.atan2(-ay, -ax);
  b0.vx = -ax * 240;
  b0.vy = -ay * 240;
  for (let i = 0; i < 60; i++) {
    updatePhysics([b0], course, { throttle: 1, steer: 0 }, raceState, dt);
    const dIsl = Math.hypot(b0.x - interiorIsland.x, b0.y - interiorIsland.y);
    assert.ok(dIsl >= interiorIsland.radius * 0.72, `Boat penetrated deep into island (d=${dIsl.toFixed(1)}, r=${interiorIsland.radius.toFixed(1)})`);
    assertAllBoatFieldsFinite(b0);
  }
});

test('Physics + AI + Rules headless integration: all 4 AI boats complete 3-lap races cleanly across 8 seeds', () => {
  const testSeeds = [101, 202, 303, 404, 505, 606, 707, 808];
  const dt = 1 / 60;

  for (const seed of testSeeds) {
    const course = generateCourse(seed);
    const allBoats = createBoats(course);
    // Run the 4 AI boats (exclude idle player so grace timer doesn't prematurely end simulation)
    const aiBoats = allBoats.filter((b) => !b.isPlayer);
    assert.equal(aiBoats.length, 4);

    const raceState = createRaceState(course);
    let maxSteps = 60 * 110; // up to 110 simulated seconds for 3 laps
    let step = 0;
    let totalCourseCuts = 0;
    let totalJumpStarts = 0;

    while (step < maxSteps && raceState.phase !== 'finished') {
      updatePhysics(aiBoats, course, { throttle: 0, steer: 0 }, raceState, dt);
      const events = updateRaceRules(raceState, aiBoats, course, dt);
      for (const ev of events) {
        if (ev.type === 'course_cut_penalty') totalCourseCuts++;
        if (ev.type === 'jump_start') totalJumpStarts++;
      }
      step++;
    }

    assert.equal(raceState.phase, 'finished', `Seed ${seed}: AI race did not finish within 110s`);
    assert.equal(totalJumpStarts, 0, `Seed ${seed}: AI should never jump start`);
    assert.ok(totalCourseCuts <= 2, `Seed ${seed}: excessive AI course cuts (${totalCourseCuts})`);

    for (const ai of aiBoats) {
      assert.equal(ai.finished, true, `Seed ${seed}: AI ${ai.name} did not finish`);
      assert.equal(ai.lapTimes.length, TOTAL_LAPS, `Seed ${seed}: AI ${ai.name} lapTimes=${ai.lapTimes.length}`);
      assert.ok(ai.finishTime > 15 && ai.finishTime < 105, `Seed ${seed}: AI ${ai.name} finishTime=${ai.finishTime}`);
      assertAllBoatFieldsFinite(ai);
    }
  }
});

test('Audio engine is safe no-op in headless Node environment', () => {
  const audio = createAudioEngine();
  assert.doesNotThrow(() => {
    audio.unlock();
    assert.equal(audio.isMuted(), false);
    audio.setMuted(true);
    assert.equal(audio.isMuted(), true);
    audio.setMuted(false);
    audio.updateEngine(0.8, 1.0, 0.4, 0.2, true);
    audio.playCountdown(3);
    audio.playGo();
    audio.playLap(false);
    audio.playLap(true);
    audio.playBuoyHit();
    audio.playPenalty();
    audio.playFinish(1);
    audio.destroy();
  });
});

// ============================================================================
// 4. WATER RACE RULES & CAREER PERSISTENCE (src/rules.js)
// ============================================================================
test('Rules: 3-2-1 countdown & GO transition', () => {
  const course = generateCourse(555);
  const boats = createBoats(course);
  const raceState = createRaceState(course);

  assert.equal(raceState.phase, 'countdown');
  assert.equal(raceState.countdown, COUNTDOWN_SECONDS);

  const ticks = [];
  let goEmitted = false;
  const dt = 0.05;

  for (let i = 0; i < 80; i++) {
    const events = updateRaceRules(raceState, boats, course, dt);
    for (const ev of events) {
      if (ev.type === 'countdown_tick') ticks.push(ev.value);
      if (ev.type === 'race_start') goEmitted = true;
    }
    if (raceState.phase === 'racing') break;
  }

  assert.deepEqual(ticks, [3, 2, 1]);
  assert.equal(goEmitted, true);
  assert.equal(raceState.phase, 'racing');
});

test('Rules: jump start triggers one-time +2.0s penalty before GO', () => {
  const course = generateCourse(777);
  const boats = createBoats(course);
  const raceState = createRaceState(course);
  const player = boats[0];
  const sl = course.startLine;

  // Prime initial position behind start line
  updateRaceRules(raceState, boats, course, 1 / 60);
  assert.equal(player.penalties, 0);

  // Move player across the start line during countdown
  player.x = sl.x + sl.tx * 12;
  player.y = sl.y + sl.ty * 12;
  const ev1 = updateRaceRules(raceState, boats, course, 1 / 60);
  assert.ok(ev1.some((e) => e.type === 'jump_start' && e.boatId === player.id && e.penalty === PENALTY_JUMP_START));
  assert.equal(player.jumpStarted, true);
  assert.equal(player.penalties, PENALTY_JUMP_START);

  // Moving further ahead during countdown should NOT double-penalize
  player.x = sl.x + sl.tx * 24;
  player.y = sl.y + sl.ty * 24;
  const ev2 = updateRaceRules(raceState, boats, course, 1 / 60);
  assert.equal(ev2.some((e) => e.type === 'jump_start'), false);
  assert.equal(player.penalties, PENALTY_JUMP_START);
});

test('Rules: clean buoy rounding advances nextBuoyIndex; wrong side warns; skipping triggers +3.0s course cut', () => {
  const course = generateCourse(888);
  const boats = createBoats(course);
  const raceState = createRaceState(course);
  raceState.phase = 'racing';
  raceState.countdown = 0;

  const player = boats[0];
  const b0 = course.buoys[0];
  const b1 = course.buoys[1];
  const b2 = course.buoys[2];

  // 1. Clean outside rounding of buoy 0
  player.x = b0.x - b0.dirX * 25 + b0.outX * 45;
  player.y = b0.y - b0.dirY * 25 + b0.outY * 45;
  updateRaceRules(raceState, [player], course, 1 / 60);

  player.x = b0.x + b0.dirX * 25 + b0.outX * 45;
  player.y = b0.y + b0.dirY * 25 + b0.outY * 45;
  const evRound0 = updateRaceRules(raceState, [player], course, 1 / 60);
  assert.ok(evRound0.some((e) => e.type === 'buoy_rounded' && e.buoyIndex === 0));
  assert.equal(player.nextBuoyIndex, 1);
  assert.equal(player.penalties, 0);

  // 2. Pass buoy 1 on the WRONG (inside) side -> missed_buoy warning, no penalty yet
  player.x = b1.x - b1.dirX * 25 - b1.outX * 35;
  player.y = b1.y - b1.dirY * 25 - b1.outY * 35;
  updateRaceRules(raceState, [player], course, 1 / 60);

  player.x = b1.x + b1.dirX * 25 - b1.outX * 35;
  player.y = b1.y + b1.dirY * 25 - b1.outY * 35;
  const evMissed = updateRaceRules(raceState, [player], course, 1 / 60);
  assert.ok(evMissed.some((e) => e.type === 'missed_buoy' && e.buoyIndex === 1));
  assert.equal(player.missedBuoyWarning.active, true);
  assert.equal(player.missedBuoyWarning.buoyIndex, 1);
  assert.equal(player.nextBuoyIndex, 1);
  assert.equal(player.penalties, 0);

  // 3. Skip buoy 1 and round buoy 2 cleanly -> +3.0s course_cut_penalty and advances to buoy 3
  player.x = b2.x - b2.dirX * 25 + b2.outX * 45;
  player.y = b2.y - b2.dirY * 25 + b2.outY * 45;
  updateRaceRules(raceState, [player], course, 1 / 60);

  player.x = b2.x + b2.dirX * 25 + b2.outX * 45;
  player.y = b2.y + b2.dirY * 25 + b2.outY * 45;
  const evCut = updateRaceRules(raceState, [player], course, 1 / 60);
  assert.ok(evCut.some((e) => e.type === 'course_cut_penalty' && e.buoyIndex === 1 && e.penalty === PENALTY_COURSE_CUT));
  assert.equal(player.penalties, PENALTY_COURSE_CUT);
  assert.equal(player.missedBuoyWarning.active, false);
  assert.equal(player.nextBuoyIndex, 3 % course.buoys.length);
});

test('Rules: buoy collision ("Buoy Whack") triggers +1.5s penalty and respects 2.0s cooldown', () => {
  const course = generateCourse(999);
  const boats = createBoats(course);
  const raceState = createRaceState(course);
  raceState.phase = 'racing';
  raceState.countdown = 0;

  const player = boats[0];
  const b0 = course.buoys[0];

  // Move away first to init lastPositions
  player.x = b0.x + 120;
  player.y = b0.y + 120;
  updateRaceRules(raceState, [player], course, 1 / 60);

  // Direct hit on buoy 0
  player.x = b0.x + 4;
  player.y = b0.y + 4;
  player.vx = 140;
  player.vy = 0;
  player.speed = 140;
  const evHit1 = updateRaceRules(raceState, [player], course, 1 / 60);
  assert.ok(evHit1.some((e) => e.type === 'buoy_hit' && e.buoyIndex === 0 && e.penalty === PENALTY_BUOY_HIT));
  assert.equal(player.penalties, PENALTY_BUOY_HIT);
  assert.equal(b0.hitTimer, 1.0);

  // Immediate re-overlap within cooldown -> must NOT penalize again
  player.x = b0.x + 3;
  player.y = b0.y + 3;
  const evCooldown = updateRaceRules(raceState, [player], course, 0.1);
  assert.equal(evCooldown.some((e) => e.type === 'buoy_hit'), false);
  assert.equal(player.penalties, PENALTY_BUOY_HIT);

  // Advance past 2.0s cooldown while clear, then hit again -> penalizes again
  player.x = b0.x + 120;
  player.y = b0.y + 120;
  for (let t = 0; t < 25; t++) {
    updateRaceRules(raceState, [player], course, 0.1);
  }
  player.x = b0.x + 2;
  player.y = b0.y + 2;
  const evHit2 = updateRaceRules(raceState, [player], course, 1 / 60);
  assert.ok(evHit2.some((e) => e.type === 'buoy_hit' && e.buoyIndex === 0));
  assert.equal(player.penalties, PENALTY_BUOY_HIT * 2);
});

test('Rules: 3-lap completion produces penalty-adjusted standings and accurate Win/Loss career persistence', () => {
  const course = generateCourse(1337);
  const boats = createBoats(course);
  const raceState = createRaceState(course);
  raceState.phase = 'racing';
  raceState.countdown = 0;

  // Simulate player (boat 0) and AI (boat 1) finishing 3 laps;
  // Give boat 1 a faster raw finish time (40.0s) but +3.0s penalty -> adjusted 43.0s
  // Give player raw finish time 41.5s with 0.0s penalty -> adjusted 41.5s -> Player wins 1st!
  const bPlayer = boats[0];
  const bAi1 = boats[1];
  const bAi2 = boats[2];
  const sl = course.startLine;

  // Helper to complete one full clean lap for a boat by teleporting through each buoy gate then start line
  function driveCleanLap(boat, dtPerStep) {
    for (const buoy of course.buoys) {
      boat.x = buoy.x - buoy.dirX * 22 + buoy.outX * 45;
      boat.y = buoy.y - buoy.dirY * 22 + buoy.outY * 45;
      updateRaceRules(raceState, boats, course, dtPerStep);
      boat.x = buoy.x + buoy.dirX * 22 + buoy.outX * 45;
      boat.y = buoy.y + buoy.dirY * 22 + buoy.outY * 45;
      updateRaceRules(raceState, boats, course, dtPerStep);
    }
    boat.x = sl.x - sl.tx * 22;
    boat.y = sl.y - sl.ty * 22;
    updateRaceRules(raceState, boats, course, dtPerStep);
    boat.x = sl.x + sl.tx * 22;
    boat.y = sl.y + sl.ty * 22;
    return updateRaceRules(raceState, boats, course, dtPerStep);
  }

  let sawFinalLap = false;
  let sawBoatFinish = false;

  // Complete 3 laps for player
  for (let lap = 1; lap <= TOTAL_LAPS; lap++) {
    const evs = driveCleanLap(bPlayer, 0.25);
    if (evs.some((e) => e.type === 'final_lap' && e.isPlayer)) sawFinalLap = true;
    if (evs.some((e) => e.type === 'boat_finish' && e.isPlayer)) sawBoatFinish = true;
  }

  assert.equal(sawFinalLap, true, 'Expected final_lap event on entering lap 3');
  assert.equal(sawBoatFinish, true, 'Expected boat_finish event after lap 3');
  assert.equal(bPlayer.finished, true);
  assert.equal(bPlayer.lapTimes.length, TOTAL_LAPS);
  assert.ok(bPlayer.bestLap > 0);

  // Set explicit finishTimes & penalties to verify penalty-adjusted standings order
  bAi1.finished = true;
  bAi1.finishTime = bPlayer.finishTime - 1.5; // raw faster by 1.5s
  bAi1.penalties = 3.0;                       // but +3.0s penalty -> adjusted slower by 1.5s!

  bAi2.finished = true;
  bAi2.finishTime = bPlayer.finishTime + 2.0;
  bAi2.penalties = 0;

  // Trigger grace expiration so remaining AI finish and race transitions to 'finished'
  let raceFinishEvent = null;
  for (let i = 0; i < 30; i++) {
    const evs = updateRaceRules(raceState, boats, course, 0.15);
    const fin = evs.find((e) => e.type === 'race_finish');
    if (fin) {
      raceFinishEvent = fin;
      break;
    }
  }

  assert.equal(raceState.phase, 'finished');
  assert.ok(raceFinishEvent, 'Expected race_finish event');

  const standings = raceFinishEvent.standings;
  assert.equal(standings.length, BOAT_COUNT);
  assert.equal(standings[0].isPlayer, true, 'Player with clean time should beat penalized boat');
  assert.equal(standings[0].rank, 1);
  assert.equal(standings[1].boatId, bAi1.id);
  assert.equal(standings[1].rank, 2);
  assert.ok(standings[0].adjustedTime < standings[1].adjustedTime);

  // Career Win/Loss Persistence with mock storage
  const storage = createMockStorage();
  let career = loadCareerRecord(storage);
  assert.equal(career.wins, 0);
  assert.equal(career.losses, 0);
  assert.equal(career.races, 0);

  // Record 1st place Win
  career = recordRaceResult(career, standings[0], course, storage);
  assert.equal(career.wins, 1);
  assert.equal(career.losses, 0);
  assert.equal(career.podiums, 1);
  assert.equal(career.races, 1);
  assert.equal(career.currentStreak, 1);
  assert.equal(career.bestStreak, 1);
  assert.equal(career.bestLapTime, standings[0].bestLap);
  assert.equal(career.history.length, 1);
  assert.equal(career.history[0].won, true);

  // Record another Win -> streak 2
  career = recordRaceResult(career, { rank: 1, finishTime: 40, penalties: 0, adjustedTime: 40, bestLap: 11.2 }, course, storage);
  assert.equal(career.wins, 2);
  assert.equal(career.currentStreak, 2);
  assert.equal(career.bestStreak, 2);

  // Record a 2nd place (Loss + Podium) -> resets currentStreak, keeps bestStreak=2
  career = recordRaceResult(career, { rank: 2, finishTime: 41, penalties: 1.5, adjustedTime: 42.5, bestLap: 12.8 }, course, storage);
  assert.equal(career.wins, 2);
  assert.equal(career.losses, 1);
  assert.equal(career.podiums, 3);
  assert.equal(career.races, 3);
  assert.equal(career.currentStreak, 0);
  assert.equal(career.bestStreak, 2);

  // Record a 4th place (Loss, no Podium)
  career = recordRaceResult(career, { rank: 4, finishTime: 45, penalties: 0, adjustedTime: 45, bestLap: 14.0 }, course, storage);
  assert.equal(career.wins, 2);
  assert.equal(career.losses, 2);
  assert.equal(career.podiums, 3);
  assert.equal(career.races, 4);

  // Reload from storage to confirm serialization fidelity
  const reloaded = loadCareerRecord(storage);
  assert.deepEqual(reloaded, career);

  // Reset clears storage
  const wiped = resetCareerRecord(storage);
  assert.equal(wiped.wins, 0);
  assert.equal(wiped.losses, 0);
  assert.equal(wiped.races, 0);
  assert.equal(loadCareerRecord(storage).races, 0);
  assert.equal(storage.getItem(CAREER_STORAGE_KEY), null);
});
