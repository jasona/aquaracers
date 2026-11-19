// RC offshore boat hydrodynamics, wake turbulence, collisions, and AI racers.

import {
  BAY_BOUNDS,
  BOAT_PRESETS,
  PHYSICS,
  SHORELINE_Y,
  TOTAL_LAPS,
} from './constants.js';
import {
  projectPointOnCourse,
  sampleSpline,
  wrapT,
} from './course.js';

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function wrapAngle(a) {
  let out = a;
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

function hypot(dx, dy) {
  return Math.sqrt(dx * dx + dy * dy);
}

export function getBoatCollisionRadius() {
  return PHYSICS.boatRadius;
}

// Style personality tuning for the 4 AI opponents (and fallback for autopilot)
const AI_STYLE_CONFIG = {
  apex: {
    buoyClearance: 39,
    lookAheadBase: 145,
    cornerBrakeBias: 1.0,
    topSpeedBias: 1.00,
    driftTolerance: 0.92,
    overtakeOffset: 16,
  },
  aggressive: {
    buoyClearance: 37,
    lookAheadBase: 132,
    cornerBrakeBias: 0.84,
    topSpeedBias: 1.015,
    driftTolerance: 1.05,
    overtakeOffset: 22,
  },
  steady: {
    buoyClearance: 47,
    lookAheadBase: 158,
    cornerBrakeBias: 1.12,
    topSpeedBias: 0.995,
    driftTolerance: 0.82,
    overtakeOffset: 18,
  },
  wild: {
    buoyClearance: 50,
    lookAheadBase: 138,
    cornerBrakeBias: 0.78,
    topSpeedBias: 1.03,
    driftTolerance: 1.22,
    overtakeOffset: 26,
  },
};

function getStartLineSplineT(course) {
  if (course && course.startLine && Number.isFinite(course.startLine.t)) {
    return wrapT(course.startLine.t);
  }
  if (course && course.startLine) {
    const proj = projectPointOnCourse(course, course.startLine.x, course.startLine.y);
    return proj ? wrapT(proj.t) : 0;
  }
  return 0;
}

/**
 * Create the 5 RC offshore racing boats arranged on a clean staggered starting grid
 * behind course.startLine, with the player positioned in the fair center lane (lane 3 of 5).
 */
export function createBoats(course) {
  const sl = course.startLine;
  const tx = sl.tx;
  const ty = sl.ty;
  const nx = sl.nx;
  const ny = sl.ny;
  const heading = Math.atan2(ty, tx);
  const halfW = sl.halfWidth || course.corridorHalfWidth || 88;
  const maxLat = Math.min(58, Math.max(46, halfW - PHYSICS.boatRadius - 8));

  // 5 lanes across start corridor in a clean 2-row staggered offshore grid;
  // player (preset index 0) takes center lane (lane 3 of 5), with >= 37px pairwise separation
  // (well above boat collision diameter of 30px) so boats never jostle on the grid.
  const slotLayout = [
    { lat: 0, back: 46 },                // index 0 -> Player (lane 3 of 5, center front)
    { lat: -maxLat * 0.5, back: 76 },    // index 1 -> Cobalt Viper (lane 2, second row left)
    { lat: maxLat * 0.5, back: 76 },     // index 2 -> Solar Flare (lane 4, second row right)
    { lat: -maxLat, back: 46 },          // index 3 -> Emerald Wake (lane 1, outer-left front)
    { lat: maxLat, back: 46 },           // index 4 -> Riptide Rebel (lane 5, outer-right front)
  ];

  const startT = getStartLineSplineT(course);
  const minX = BAY_BOUNDS.minX + PHYSICS.boatRadius + 4;
  const maxX = BAY_BOUNDS.maxX - PHYSICS.boatRadius - 4;
  const minY = BAY_BOUNDS.minY + PHYSICS.boatRadius + 4;
  const maxY = Math.min(BAY_BOUNDS.maxY, SHORELINE_Y - 12) - PHYSICS.boatRadius - 4;

  return BOAT_PRESETS.map((preset, idx) => {
    const slot = slotLayout[idx] || { lat: 0, back: 54 + idx * 14 };
    const x = clamp(sl.x - tx * slot.back + nx * slot.lat, minX, maxX);
    const y = clamp(sl.y - ty * slot.back + ny * slot.lat, minY, maxY);

    const styleCfg = AI_STYLE_CONFIG[preset.aiStyle] || AI_STYLE_CONFIG.steady;
    const boat = {
      id: preset.id,
      name: preset.name,
      number: preset.number,
      isPlayer: preset.isPlayer,
      primaryColor: preset.primaryColor,
      accentColor: preset.accentColor,
      hullColor: preset.hullColor,
      deckColor: preset.deckColor,
      aiStyle: preset.aiStyle,
      skill: preset.skill,

      // Kinematics & pose
      x,
      y,
      prevX: x,
      prevY: y,
      vx: 0,
      vy: 0,
      speed: 0,
      heading,
      angularVel: 0,

      // Smoothed control & visual articulation state
      throttle: 0,
      steer: 0,
      rudderAngle: 0,
      rollAngle: 0,
      pitchBounce: 0,
      wakeTurbulence: 0,
      antennaFlex: 0,

      // Race progression & rules state
      lap: 1,
      nextBuoyIndex: 0,
      passedBuoysThisLap: new Set(),
      lapProgress: 0,
      totalProgress: 0,
      finished: false,
      finishTime: null,
      penalties: 0,
      penaltyLog: [],
      jumpStarted: false,
      missedBuoyWarning: { active: false, buoyIndex: -1, timer: 0 },
      buoyHitCooldowns: new Map(),
      lapTimes: [],
      currentLapStart: 0,
      bestLap: null,

      // Wake trail & subtle animation helpers
      wakeTrail: [],
      wakeTimer: 0,
      bobPhase: idx * 1.43,
      simTime: 0,

      // AI controller memory
      aiState: {
        homeX: x,
        homeY: y,
        preferredLane: clamp(slot.lat * 0.35, -24, 24),
        buoyClearance: styleCfg.buoyClearance,
        stuckTimer: 0,
        recoveryTimer: 0,
        recoveryDir: idx % 2 === 0 ? 1 : -1,
        wanderPhase: idx * 1.9 + 0.4,
        lastSplineT: startT,
        targetX: sl.x,
        targetY: sl.y,
      },
    };

    updateBoatProgress(boat, course, startT);
    return boat;
  });
}

function getSplineLength(course) {
  if (Number.isFinite(course.totalLength) && course.totalLength > 10) {
    return course.totalLength;
  }
  const pts = course.splinePoints;
  if (pts && pts.length > 1) {
    const last = pts[pts.length - 1];
    if (Number.isFinite(last.s) && last.s > 10) {
      return last.s + hypot(pts[0].x - last.x, pts[0].y - last.y);
    }
  }
  return 2600;
}

function computeForwardDeltaT(fromT, toT) {
  let d = wrapT(toT) - wrapT(fromT);
  if (d < 0) d += 1;
  return d;
}

function getObstacleRadius(obs, fallback = 28) {
  if (Number.isFinite(obs.collisionRadius)) return obs.collisionRadius;
  if (Number.isFinite(obs.radius)) return obs.radius;
  if (Number.isFinite(obs.rx) && Number.isFinite(obs.ry)) return Math.max(obs.rx, obs.ry);
  if (Number.isFinite(obs.length) && Number.isFinite(obs.width)) {
    return Math.max(obs.length * 0.44, obs.width * 0.75);
  }
  return fallback;
}

/**
 * Compute AI steering and throttle commands for an AI racer (or post-finish cruise autopilot).
 */
function computeAIControl(boat, boats, course, raceState, dt, splineLen, playerProgress) {
  const phase = raceState ? raceState.phase : 'racing';
  const styleCfg = AI_STYLE_CONFIG[boat.aiStyle] || AI_STYLE_CONFIG.steady;
  const ai = boat.aiState;

  // During countdown, AI holds disciplined behind the start line bobbing on the water
  if (phase === 'countdown' || phase === 'title' || phase === 'pre_race') {
    const dx = ai.homeX - boat.x;
    const dy = ai.homeY - boat.y;
    const dist = hypot(dx, dy);
    const sl = course.startLine;
    const targetHeading = Math.atan2(sl.ty, sl.tx);
    const headingErr = wrapAngle(targetHeading - boat.heading);
    const forwardErr = dx * Math.cos(boat.heading) + dy * Math.sin(boat.heading);
    return {
      throttle: dist > 4 ? clamp(forwardErr * 0.02, -0.15, 0.15) : 0,
      steer: clamp(headingErr * 1.4, -0.4, 0.4),
      speedMultiplier: 1.0,
    };
  }

  // Anti-stuck recovery for active racing AI
  if (!boat.finished) {
    if (ai.recoveryTimer > 0) {
      ai.recoveryTimer = Math.max(0, ai.recoveryTimer - dt);
      return {
        throttle: -0.68,
        steer: ai.recoveryDir * 0.95,
        speedMultiplier: 1.0,
      };
    }

    if (boat.speed < 26) {
      ai.stuckTimer += dt;
      if (ai.stuckTimer > 1.15) {
        ai.stuckTimer = 0;
        ai.recoveryTimer = 0.55;
        ai.recoveryDir = -ai.recoveryDir;
        return {
          throttle: -0.68,
          steer: ai.recoveryDir * 0.95,
          speedMultiplier: 1.0,
        };
      }
    } else {
      ai.stuckTimer = Math.max(0, ai.stuckTimer - dt * 2.5);
    }
  }

  const proj = projectPointOnCourse(course, boat.x, boat.y);
  const boatT = proj ? wrapT(proj.t) : ai.lastSplineT;
  ai.lastSplineT = boatT;

  const buoys = course.buoys || [];
  const buoyCount = buoys.length;

  // Decide navigation target point
  let targetX;
  let targetY;
  let upcomingCurvature = 0;

  // Finished boats gracefully cruise along the spline at relaxed pace
  if (boat.finished || phase === 'finished' || buoyCount === 0) {
    const lookT = wrapT(boatT + 140 / splineLen);
    const sp = sampleSpline(course, lookT);
    targetX = sp.x + sp.nx * ai.preferredLane * 0.6;
    targetY = sp.y + sp.ny * ai.preferredLane * 0.6;
    upcomingCurvature = Math.abs(sp.curvature || 0);
  } else if (boat.nextBuoyIndex >= buoyCount) {
    // All buoys rounded for this lap: drive cleanly across the start/finish line!
    const sl = course.startLine;
    const distToStart = hypot(sl.x - boat.x, sl.y - boat.y);
    if (distToStart > 220) {
      const lookDist = clamp(styleCfg.lookAheadBase + boat.speed * 0.2, 115, 210);
      const lookT = wrapT(boatT + lookDist / splineLen);
      const sp = sampleSpline(course, lookT);
      targetX = sp.x + sp.nx * clamp(ai.preferredLane * 0.55, -22, 22);
      targetY = sp.y + sp.ny * clamp(ai.preferredLane * 0.55, -22, 22);
      upcomingCurvature = Math.abs(sp.curvature || 0);
    } else {
      const laneOff = clamp(ai.preferredLane * 0.5, -(sl.halfWidth * 0.55), sl.halfWidth * 0.55);
      targetX = sl.x + sl.nx * laneOff + sl.tx * 55;
      targetY = sl.y + sl.ny * laneOff + sl.ty * 55;
      upcomingCurvature = 0;
    }
  } else {
    const nextIdx = clamp(boat.nextBuoyIndex, 0, buoyCount - 1);
    const buoy = buoys[nextIdx];
    const buoyT = Number.isFinite(buoy.splineT)
      ? wrapT(buoy.splineT)
      : wrapT(projectPointOnCourse(course, buoy.x, buoy.y).t);

    // Distance along spline to next buoy (wrapping around loop)
    let deltaT = computeForwardDeltaT(boatT, buoyT);
    // If boat just overshot the buoy slightly (e.g. missedBuoyWarning or < 12% past)
    const pastBuoy = deltaT > 0.82;
    const distAlongSpline = pastBuoy ? -(1 - deltaT) * splineLen : deltaT * splineLen;

    // Gate geometry at the next buoy
    const outX = buoy.outX;
    const outY = buoy.outY;
    const dirX = buoy.dirX;
    const dirY = buoy.dirY;
    const gateSpan =
      Number.isFinite(buoy.outerX) && Number.isFinite(buoy.outerY)
        ? hypot(buoy.outerX - buoy.x, buoy.outerY - buoy.y)
        : (course.corridorHalfWidth || 90) * 1.45;

    // Safe outside clearance between inside apex buoy and outer gate buoy
    const minSafeOffset = (buoy.radius || PHYSICS.buoyRadius) + PHYSICS.boatRadius + 10; // ~36px
    const maxSafeOffset = Math.max(
      minSafeOffset + 6,
      Math.min(gateSpan - PHYSICS.outerBuoyRadius - PHYSICS.boatRadius - 18, gateSpan * 0.56)
    );
    const dynamicOffset =
      styleCfg.buoyClearance + Math.sin(boat.simTime * 0.55 + ai.wanderPhase) * 2.5;
    const targetOffset = clamp(dynamicOffset, minSafeOffset, maxSafeOffset);

    // Boat position relative to the next apex buoy in (dir, out) frame
    const relX = boat.x - buoy.x;
    const relY = boat.y - buoy.y;
    const along = relX * dirX + relY * dirY;
    const side = relX * outX + relY * outY;
    const directDist = hypot(relX, relY);

    // Ideal passing point cleanly outside the apex buoy
    const passX = buoy.x + outX * targetOffset;
    const passY = buoy.y + outY * targetOffset;

    const needsRecoveryOutside =
      (boat.missedBuoyWarning && boat.missedBuoyWarning.active) ||
      (along > 14 && side < minSafeOffset * 0.65 && directDist < 185);

    if (needsRecoveryOutside) {
      // Loop back cleanly outside the missed buoy so AI corrects rather than getting penalized
      if (side < targetOffset * 0.85) {
        targetX = buoy.x + outX * (targetOffset + 22) - dirX * 36;
        targetY = buoy.y + outY * (targetOffset + 22) - dirY * 36;
      } else {
        targetX = passX + dirX * 26;
        targetY = passY + dirY * 26;
      }
    } else if (distAlongSpline > 215 && directDist > 215) {
      // Far from next buoy: follow smooth racing line along spline so we stay inside corridor
      const lookDist = clamp(styleCfg.lookAheadBase + boat.speed * 0.2, 115, 210);
      const lookT = wrapT(boatT + lookDist / splineLen);
      const sp = sampleSpline(course, lookT);
      const spFar = sampleSpline(course, wrapT(boatT + (lookDist + 110) / splineLen));
      upcomingCurvature = Math.max(Math.abs(sp.curvature || 0), Math.abs(spFar.curvature || 0));

      const laneShift = clamp(ai.preferredLane * 0.65, -24, 24);
      targetX = sp.x + sp.nx * laneShift;
      targetY = sp.y + sp.ny * laneShift;
    } else {
      // Approaching or rounding the buoy!
      const spAhead = sampleSpline(course, wrapT(buoyT + 110 / splineLen));
      upcomingCurvature = Math.max(
        Math.abs(sampleSpline(course, buoyT).curvature || 0),
        Math.abs(spAhead.curvature || 0)
      );

      if (along < -22) {
        // Entry phase: if on the inside side of the buoy line, swing slightly wider & earlier
        // so the bow arcs cleanly around the OUTSIDE of the buoy without clipping it!
        if (side < targetOffset * 0.72 && along > -150) {
          targetX = buoy.x + outX * (targetOffset + 18) - dirX * 22;
          targetY = buoy.y + outY * (targetOffset + 18) - dirY * 22;
        } else {
          // Smoothly blend entry approach toward passPoint
          const blend = clamp((-along - 22) / 150, 0, 1);
          targetX = passX - dirX * (blend * 26);
          targetY = passY - dirY * (blend * 26);
        }
      } else {
        // Right at or slightly past the buoy plane: drive through the outside gate exit!
        const nextAfter = buoys[(nextIdx + 1) % buoyCount];
        const exitX = passX + dirX * 56;
        const exitY = passY + dirY * 56;
        if (side >= minSafeOffset * 0.65 && nextAfter) {
          // Gently blend toward exit direction while staying safely outside
          targetX = exitX;
          targetY = exitY;
        } else {
          targetX = buoy.x + outX * (targetOffset + 16) + dirX * 22;
          targetY = buoy.y + outY * (targetOffset + 16) + dirY * 22;
        }
      }
    }
  }

  ai.targetX = targetX;
  ai.targetY = targetY;

  // Base desired direction toward target
  let dirToTargetX = targetX - boat.x;
  let dirToTargetY = targetY - boat.y;
  const distToTarget = hypot(dirToTargetX, dirToTargetY) || 1;
  dirToTargetX /= distToTarget;
  dirToTargetY /= distToTarget;

  // --- Repulsion vectors (buoys, other boats, islands/rocks, bay boundaries) ---
  let avoidX = 0;
  let avoidY = 0;

  // 1. Keep clean clearance around all buoys (both inside apex and outer gate marker)
  for (let i = 0; i < buoyCount; i++) {
    const b = buoys[i];
    const apexSafe = (b.radius || PHYSICS.buoyRadius) + PHYSICS.boatRadius + 16;
    const dx = boat.x - b.x;
    const dy = boat.y - b.y;
    const d = hypot(dx, dy);
    if (d > 0.001 && d < apexSafe) {
      const strength = ((apexSafe - d) / apexSafe) * 2.4;
      avoidX += (dx / d) * strength;
      avoidY += (dy / d) * strength;
    }

    if (Number.isFinite(b.outerX) && Number.isFinite(b.outerY)) {
      const outerSafe = PHYSICS.outerBuoyRadius + PHYSICS.boatRadius + 24;
      const odx = boat.x - b.outerX;
      const ody = boat.y - b.outerY;
      const od = hypot(odx, ody);
      if (od > 0.001 && od < outerSafe) {
        const strength = ((outerSafe - od) / outerSafe) * 2.5;
        avoidX += (odx / od) * strength;
        avoidY += (ody / od) * strength;
      }
    }
  }

  // 2. Dynamic boat-to-boat avoidance so packs race cleanly side-by-side
  for (let i = 0; i < boats.length; i++) {
    const other = boats[i];
    if (other === boat) continue;
    const dx = boat.x - other.x;
    const dy = boat.y - other.y;
    const d = hypot(dx, dy);
    const safeBoatDist = PHYSICS.boatRadius * 3.4; // ~51px
    if (d > 0.001 && d < safeBoatDist) {
      const weight = ((safeBoatDist - d) / safeBoatDist) * 1.15;
      avoidX += (dx / d) * weight;
      avoidY += (dy / d) * weight;
    }
  }

  // 3. Coastal obstacles (islands, rocks, spectator boats)
  const scenery = course.scenery || {};
  const obstacleLists = [scenery.islands, scenery.rocks, scenery.spectatorBoats];
  for (let l = 0; l < obstacleLists.length; l++) {
    const list = obstacleLists[l];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const obs = list[i];
      if (!obs || !Number.isFinite(obs.x) || !Number.isFinite(obs.y)) continue;
      const obsR = getObstacleRadius(obs, 26);
      const safeR = obsR + PHYSICS.boatRadius + 28;
      const dx = boat.x - obs.x;
      const dy = boat.y - obs.y;
      const d = hypot(dx, dy);
      if (d > 0.001 && d < safeR) {
        const strength = ((safeR - d) / safeR) * 2.5;
        avoidX += (dx / d) * strength;
        avoidY += (dy / d) * strength;
      }
    }
  }

  // 4. Bay boundary cushion
  const margin = 52;
  const maxY = Math.min(BAY_BOUNDS.maxY, SHORELINE_Y - 14);
  if (boat.x < BAY_BOUNDS.minX + margin) {
    avoidX += ((BAY_BOUNDS.minX + margin - boat.x) / margin) * 2.0;
  } else if (boat.x > BAY_BOUNDS.maxX - margin) {
    avoidX -= ((boat.x - (BAY_BOUNDS.maxX - margin)) / margin) * 2.0;
  }
  if (boat.y < BAY_BOUNDS.minY + margin) {
    avoidY += ((BAY_BOUNDS.minY + margin - boat.y) / margin) * 2.0;
  } else if (boat.y > maxY - margin) {
    avoidY -= ((boat.y - (maxY - margin)) / margin) * 2.0;
  }

  // Combine desired heading with avoidance vector
  const desiredX = dirToTargetX + avoidX;
  const desiredY = dirToTargetY + avoidY;
  const desiredHeading = Math.atan2(desiredY, desiredX);

  // Lead-compensated heading error (damps oscillation & accounts for boat angular momentum)
  const predictedHeading = wrapAngle(boat.heading + boat.angularVel * 0.14);
  const headingErr = wrapAngle(desiredHeading - predictedHeading);
  const rawHeadingErr = wrapAngle(desiredHeading - boat.heading);

  const steerGain = 2.05 / styleCfg.driftTolerance;
  const steer = clamp(headingErr * steerGain, -1, 1);

  // Cornering & curvature throttle modulation
  let throttle = 1.0;
  if (boat.finished || phase === 'finished') {
    throttle = 0.36;
  } else {
    const absErr = Math.abs(rawHeadingErr);
    // Modulate for tight turns
    if (absErr > 0.45) {
      throttle -= clamp((absErr - 0.45) * 0.52 * styleCfg.cornerBrakeBias, 0, 0.62);
    }
    // Gentle braking if pointing far off-target at high speed
    if (absErr > 1.75 && boat.speed > 125) {
      throttle = -0.25;
    }
    // Anticipate upcoming sharp curvature so boats carve cleanly inside the gate
    if (upcomingCurvature > 0.0042) {
      const curveSlow = clamp((upcomingCurvature - 0.0042) * 58 * styleCfg.cornerBrakeBias, 0, 0.42);
      throttle = Math.max(0.34, throttle - curveSlow);
    }
  }

  // Subtle competitive pacing (keeps packs lively without blatant rubber-banding)
  let pacingMult = 1.0;
  if (!boat.isPlayer && !boat.finished && phase === 'racing' && Number.isFinite(playerProgress)) {
    const gap = playerProgress - boat.totalProgress; // positive => player is ahead of AI
    // Very gentle ±4.2% max adjustment across ~0.35 lap gap
    pacingMult = 1.0 + clamp(gap * 0.12, -0.042, 0.042);
  }

  const speedMultiplier = clamp(boat.skill * styleCfg.topSpeedBias * pacingMult, 0.86, 1.08);

  return {
    throttle: clamp(throttle, -1, 1),
    steer,
    speedMultiplier,
  };
}

/**
 * Resolve circle-vs-circle elastic water bounce between two boats.
 */
function resolveBoatCollisions(boats) {
  const minDist = PHYSICS.boatRadius * 2;
  const minDistSq = minDist * minDist;

  for (let i = 0; i < boats.length; i++) {
    const a = boats[i];
    for (let j = i + 1; j < boats.length; j++) {
      const b = boats[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;

      if (distSq >= minDistSq) continue;

      let dist = Math.sqrt(distSq);
      if (dist < 0.0001) {
        dx = 1;
        dy = 0;
        dist = 1;
      }

      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minDist - dist;

      // Push hulls cleanly apart
      const push = overlap * 0.52;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;

      // Relative velocity along collision normal
      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const relNormal = rvx * nx + rvy * ny;

      if (relNormal < 0) {
        const impulse = -(1 + PHYSICS.collisionRestitution) * relNormal * 0.5;
        a.vx -= nx * impulse;
        a.vy -= ny * impulse;
        b.vx += nx * impulse;
        b.vy += ny * impulse;

        // Scrub a touch of splash energy
        a.vx *= 0.94;
        a.vy *= 0.94;
        b.vx *= 0.94;
        b.vy *= 0.94;

        // Slight wake chop jolt on contact
        const impact = clamp(-relNormal / 180, 0.12, 0.65);
        a.wakeTurbulence = clamp(a.wakeTurbulence + impact, 0, 1);
        b.wakeTurbulence = clamp(b.wakeTurbulence + impact, 0, 1);
      }
    }
  }
}

/**
 * Closest point on segment AB to point P.
 */
function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-6) return { x: ax, y: ay };
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / lenSq, 0, 1);
  return { x: ax + abx * t, y: ay + aby * t };
}

function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pushBoatOutOfCircle(boat, cx, cy, obsRadius) {
  const minDist = obsRadius + PHYSICS.boatRadius;
  let dx = boat.x - cx;
  let dy = boat.y - cy;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return;

  let dist = Math.sqrt(distSq);
  if (dist < 0.0001) {
    dx = 1;
    dy = 0;
    dist = 1;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  boat.x += nx * (overlap + 0.5);
  boat.y += ny * (overlap + 0.5);

  const vn = boat.vx * nx + boat.vy * ny;
  if (vn < 0) {
    boat.vx -= (1 + PHYSICS.collisionRestitution * 0.85) * vn * nx;
    boat.vy -= (1 + PHYSICS.collisionRestitution * 0.85) * vn * ny;
    boat.vx *= 0.88;
    boat.vy *= 0.88;
  }
}

function pushBoatOutOfPolygon(boat, pts, fallbackX, fallbackY) {
  let bestDistSq = Infinity;
  let bestX = fallbackX;
  let bestY = fallbackY;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cp = closestPointOnSegment(boat.x, boat.y, a.x, a.y, b.x, b.y);
    const dx = boat.x - cp.x;
    const dy = boat.y - cp.y;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestX = cp.x;
      bestY = cp.y;
    }
  }

  const inside = pointInPolygon(boat.x, boat.y, pts);
  const minDist = PHYSICS.boatRadius + 3;
  if (!inside && bestDistSq >= minDist * minDist) return;

  let dx = boat.x - bestX;
  let dy = boat.y - bestY;
  let dist = Math.sqrt(bestDistSq);

  if (inside) {
    // Push outward toward nearest edge, or away from polygon center
    if (dist > 0.001) {
      dx = -dx / dist;
      dy = -dy / dist;
    } else {
      const cdx = boat.x - fallbackX;
      const cdy = boat.y - fallbackY;
      const cd = hypot(cdx, cdy) || 1;
      dx = cdx / cd;
      dy = cdy / cd;
    }
    boat.x = bestX + dx * (minDist + 1);
    boat.y = bestY + dy * (minDist + 1);
  } else {
    if (dist < 0.001) {
      const cdx = boat.x - fallbackX;
      const cdy = boat.y - fallbackY;
      const cd = hypot(cdx, cdy) || 1;
      dx = cdx / cd;
      dy = cdy / cd;
    } else {
      dx /= dist;
      dy /= dist;
    }
    const overlap = minDist - dist;
    boat.x += dx * (overlap + 0.5);
    boat.y += dy * (overlap + 0.5);
  }

  const vn = boat.vx * dx + boat.vy * dy;
  if (vn < 0) {
    boat.vx -= (1 + PHYSICS.collisionRestitution * 0.8) * vn * dx;
    boat.vy -= (1 + PHYSICS.collisionRestitution * 0.8) * vn * dy;
    boat.vx *= 0.86;
    boat.vy *= 0.86;
  }
}

function resolvePierCollision(boat, pier) {
  if (!pier || !Number.isFinite(pier.x) || !Number.isFinite(pier.y)) return;
  const px1 = pier.x;
  const py1 = pier.y;
  const px2 = pier.x + (pier.width || 0);
  const py2 = pier.y + (pier.height || 0);

  const closestX = clamp(boat.x, px1, px2);
  const closestY = clamp(boat.y, py1, py2);
  const dx = boat.x - closestX;
  const dy = boat.y - closestY;
  const distSq = dx * dx + dy * dy;
  const r = PHYSICS.boatRadius + 2;

  if (distSq >= r * r) return;

  let nx = 0;
  let ny = -1;
  let overlap = r;

  if (distSq > 1e-6) {
    const dist = Math.sqrt(distSq);
    nx = dx / dist;
    ny = dy / dist;
    overlap = r - dist;
  } else {
    // Boat center inside pier AABB: push cleanly upward into the bay
    nx = 0;
    ny = -1;
    overlap = boat.y - py1 + r;
  }

  boat.x += nx * (overlap + 0.5);
  boat.y += ny * (overlap + 0.5);

  const vn = boat.vx * nx + boat.vy * ny;
  if (vn < 0) {
    boat.vx -= (1 + 0.35) * vn * nx;
    boat.vy -= (1 + 0.35) * vn * ny;
    boat.vx *= 0.88;
    boat.vy *= 0.88;
  }
}

/**
 * Resolve soft water bounces against bay walls, bottom shoreline/pier, islands, rocks, and moored boats.
 */
function resolveEnvironmentCollisions(boats, course, dt) {
  const r = PHYSICS.boatRadius;
  const minX = BAY_BOUNDS.minX + r;
  const maxX = BAY_BOUNDS.maxX - r;
  const minY = BAY_BOUNDS.minY + r;
  const maxY = Math.min(BAY_BOUNDS.maxY, SHORELINE_Y - 12) - r;
  const scenery = course.scenery || {};
  const islands = Array.isArray(scenery.islands) ? scenery.islands : [];
  const rocks = Array.isArray(scenery.rocks) ? scenery.rocks : [];
  const spectators = Array.isArray(scenery.spectatorBoats) ? scenery.spectatorBoats : [];

  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];

    // Islands (support polygonal coastlines if provided, else radial)
    for (let k = 0; k < islands.length; k++) {
      const isl = islands[k];
      if (!isl) continue;
      if (Array.isArray(isl.points) && isl.points.length >= 3) {
        // Quick bounding circle reject
        const boundR = getObstacleRadius(isl, 65) + r + 24;
        const bdx = boat.x - isl.x;
        const bdy = boat.y - isl.y;
        if (bdx * bdx + bdy * bdy < boundR * boundR) {
          pushBoatOutOfPolygon(boat, isl.points, isl.x, isl.y);
        }
      } else if (Number.isFinite(isl.x) && Number.isFinite(isl.y)) {
        pushBoatOutOfCircle(boat, isl.x, isl.y, getObstacleRadius(isl, 40));
      }
    }

    // Coastal rocks
    for (let k = 0; k < rocks.length; k++) {
      const rock = rocks[k];
      if (!rock || !Number.isFinite(rock.x) || !Number.isFinite(rock.y)) continue;
      pushBoatOutOfCircle(boat, rock.x, rock.y, getObstacleRadius(rock, 16));
    }

    // Moored spectator boats
    for (let k = 0; k < spectators.length; k++) {
      const sb = spectators[k];
      if (!sb || !Number.isFinite(sb.x) || !Number.isFinite(sb.y)) continue;
      pushBoatOutOfCircle(boat, sb.x, sb.y, getObstacleRadius(sb, 18));
    }

    // Wooden RC Pier
    if (scenery.pier) {
      resolvePierCollision(boat, scenery.pier);
    }

    // Soft bay boundary push & clamp
    if (boat.x < minX) {
      boat.x = minX;
      if (boat.vx < 0) boat.vx = -boat.vx * 0.35;
      boat.vx += PHYSICS.boundaryPush * dt * 0.2;
    } else if (boat.x > maxX) {
      boat.x = maxX;
      if (boat.vx > 0) boat.vx = -boat.vx * 0.35;
      boat.vx -= PHYSICS.boundaryPush * dt * 0.2;
    }

    if (boat.y < minY) {
      boat.y = minY;
      if (boat.vy < 0) boat.vy = -boat.vy * 0.35;
      boat.vy += PHYSICS.boundaryPush * dt * 0.2;
    } else if (boat.y > maxY) {
      boat.y = maxY;
      if (boat.vy > 0) boat.vy = -boat.vy * 0.35;
      boat.vy -= PHYSICS.boundaryPush * dt * 0.2;
    }

    boat.speed = hypot(boat.vx, boat.vy);
  }
}

/**
 * Update wake trail ribbons and compute wake turbulence experienced by boats crossing other wakes.
 */
function updateWakesAndTurbulence(boats, dt) {
  const maxAge = PHYSICS.wakeMaxAge;
  const sampleInterval = PHYSICS.wakeSampleInterval;
  const chopRadius = PHYSICS.wakeChopRadius;

  // 1. Age & emit wake points for each boat
  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    const trail = boat.wakeTrail;

    // Age existing samples and prune expired ones in place
    let writeIdx = 0;
    for (let k = 0; k < trail.length; k++) {
      const pt = trail[k];
      pt.age += dt;
      if (pt.age <= maxAge) {
        trail[writeIdx++] = pt;
      }
    }
    trail.length = writeIdx;

    // Emit new wake sample from the stern when moving
    boat.wakeTimer = (boat.wakeTimer || 0) + dt;
    if (boat.wakeTimer >= sampleInterval) {
      boat.wakeTimer = 0;
      if (boat.speed > 18) {
        const sternOffset = PHYSICS.boatLength * 0.46;
        const speedRatio = clamp(boat.speed / PHYSICS.maxSpeed, 0, 1.2);
        trail.push({
          x: boat.x - Math.cos(boat.heading) * sternOffset,
          y: boat.y - Math.sin(boat.heading) * sternOffset,
          heading: boat.heading,
          speed: boat.speed,
          speedRatio,
          width: PHYSICS.boatWidth * (0.55 + 0.55 * speedRatio),
          age: 0,
        });
        // Hard cap for 60fps predictability
        if (trail.length > 56) {
          trail.shift();
        }
      }
    }
  }

  // 2. Measure wake turbulence from other boats' active wakes
  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    let chopSum = 0;

    for (let j = 0; j < boats.length; j++) {
      if (i === j) continue;
      const otherTrail = boats[j].wakeTrail;
      // Step by 2 for performance (samples are ~8-10px apart)
      for (let k = 0; k < otherTrail.length; k += 2) {
        const pt = otherTrail[k];
        if (pt.speed < 65) continue;
        const lifeFrac = 1 - pt.age / maxAge;
        if (lifeFrac <= 0.05) continue;

        const effectiveR = chopRadius + pt.age * 14;
        const dx = boat.x - pt.x;
        const dy = boat.y - pt.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < effectiveR * effectiveR) {
          const dist = Math.sqrt(distSq);
          const radial = 1 - dist / effectiveR;
          const speedWeight = clamp(pt.speed / PHYSICS.maxSpeed, 0.2, 1.0);
          chopSum += radial * lifeFrac * speedWeight * 0.72;
          if (chopSum >= 1.15) break;
        }
      }
      if (chopSum >= 1.15) break;
    }

    const targetChop = clamp(chopSum, 0, 1);
    const blendRate = targetChop > boat.wakeTurbulence ? 9.5 : 3.8;
    boat.wakeTurbulence += (targetChop - boat.wakeTurbulence) * Math.min(1, blendRate * dt);
  }
}

/**
 * Project boat onto course spline and update lapProgress & totalProgress cleanly
 * (handling wrap-around behind the start line so standings never glitch).
 */
function updateBoatProgress(boat, course, startT) {
  const proj = projectPointOnCourse(course, boat.x, boat.y);
  if (!proj) return;

  const rawT = wrapT(proj.t - startT);
  const buoyCount = (course.buoys && course.buoys.length) || 1;
  const passedCount = boat.passedBuoysThisLap ? boat.passedBuoysThisLap.size : 0;

  let signedLapProgress = rawT;

  // Before rounding any buoys on a lap, sitting behind the start line maps to slight negative progress
  if (rawT > 0.76 && passedCount === 0) {
    signedLapProgress = rawT - 1; // e.g., -0.02 behind start line
  } else if (rawT < 0.16 && passedCount >= Math.max(1, Math.ceil(buoyCount * 0.75))) {
    // Just crossed finish/start line after rounding most buoys, before lap increment ticks
    signedLapProgress = 1 + rawT;
  }

  boat.lapProgress = clamp(signedLapProgress, 0, 1);
  if (boat.finished) {
    boat.totalProgress = Math.max(boat.totalProgress, TOTAL_LAPS);
  } else {
    boat.totalProgress = (boat.lap - 1) + signedLapProgress;
  }
}

/**
 * Main physics & AI step for all 5 RC offshore boats.
 * @param {Array} boats
 * @param {Object} course
 * @param {{ throttle?: number, steer?: number }} playerInput
 * @param {Object} raceState
 * @param {number} dt
 */
export function updatePhysics(boats, course, playerInput, raceState, dt) {
  if (!Array.isArray(boats) || boats.length === 0 || !course) return;
  const safeDt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0.0001, 0.05);
  const phase = raceState ? raceState.phase : 'racing';
  const splineLen = getSplineLength(course);
  const startT = getStartLineSplineT(course);

  // Locate player progress for gentle competitive pacing
  let playerProgress = null;
  for (let i = 0; i < boats.length; i++) {
    if (boats[i].isPlayer) {
      playerProgress = boats[i].totalProgress;
      break;
    }
  }

  const rawPlayerThrottle = clamp(
    playerInput && Number.isFinite(playerInput.throttle) ? playerInput.throttle : 0,
    -1,
    1
  );
  const rawPlayerSteer = clamp(
    playerInput && Number.isFinite(playerInput.steer) ? playerInput.steer : 0,
    -1,
    1
  );

  // Step 1: Hydrodynamics for every boat
  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    boat.prevX = boat.x;
    boat.prevY = boat.y;
    boat.simTime = (boat.simTime || 0) + safeDt;

    let targetThrottle = 0;
    let targetSteer = 0;
    let speedMult = 1.0;

    if (boat.isPlayer && !boat.finished && phase !== 'finished') {
      if (phase === 'title' || phase === 'pre_race') {
        targetThrottle = 0;
        targetSteer = 0;
      } else {
        targetThrottle = rawPlayerThrottle;
        targetSteer = rawPlayerSteer;
      }
    } else {
      const cmd = computeAIControl(boat, boats, course, raceState, safeDt, splineLen, playerProgress);
      targetThrottle = cmd.throttle;
      targetSteer = cmd.steer;
      speedMult = cmd.speedMultiplier;
    }

    // Smooth throttle and rudder/steering servo response
    boat.throttle += (targetThrottle - boat.throttle) * Math.min(1, PHYSICS.throttleResponse * safeDt);
    boat.steer += (targetSteer - boat.steer) * Math.min(1, PHYSICS.steerResponse * safeDt);

    // Local boat frame
    const hx = Math.cos(boat.heading);
    const hy = Math.sin(boat.heading);
    const rx = -hy;
    const ry = hx;

    let vForward = boat.vx * hx + boat.vy * hy;
    let vLateral = boat.vx * rx + boat.vy * ry;

    // Effective speed cap & thrust scaling
    const isCountdown = phase === 'countdown';
    const isIdleOverlay = phase === 'title' || phase === 'pre_race';
    const creepScale = isCountdown ? PHYSICS.countdownCreepFactor : isIdleOverlay ? 0.15 : 1.0;

    const maxFwd = PHYSICS.maxSpeed * speedMult * creepScale;
    const maxRev = PHYSICS.reverseMaxSpeed * creepScale;

    let thrust = 0;
    if (boat.throttle >= 0) {
      // Crisp planing punch off the line + smooth top-end pull
      const lowSpeedBoost = 1 + 0.14 * (1 - clamp(Math.max(0, vForward) / PHYSICS.maxSpeed, 0, 1));
      thrust = boat.throttle * PHYSICS.thrustAccel * speedMult * creepScale * lowSpeedBoost;
    } else {
      // Responsive water braking when moving forward, gentle reverse when slow/stopped
      const brakeBoost = vForward > 12 ? 1.45 : 1.0;
      thrust = boat.throttle * PHYSICS.reverseAccel * creepScale * brakeBoost;
    }

    // Forward water drag (linear + quadratic + wake chop drag + carving drag)
    const wakeDrag = boat.wakeTurbulence * PHYSICS.wakeTurbulenceDrag * 1.45;
    const carveDrag = Math.abs(boat.steer) * 0.12;
    const fwdDrag =
      (PHYSICS.forwardDrag + wakeDrag + carveDrag + PHYSICS.forwardQuadDrag * Math.abs(vForward)) *
      vForward;

    // Lateral keel/chine drag (allows sweeping tail drift without feeling slippery like ice)
    const latDrag =
      (PHYSICS.lateralDrag + 0.0055 * Math.abs(vLateral)) * vLateral;

    vForward += (thrust - fwdDrag) * safeDt;
    vLateral -= latDrag * safeDt;

    // Soft-clamp top forward and reverse speeds
    if (vForward > maxFwd) {
      vForward += (maxFwd - vForward) * Math.min(1, 5.0 * safeDt);
    } else if (vForward < -maxRev) {
      vForward += (-maxRev - vForward) * Math.min(1, 6.0 * safeDt);
    }

    // Steering authority: rudder effectiveness at speed + prop thrust vectoring at low speed
    const speedRatio = clamp(Math.abs(vForward) / PHYSICS.maxSpeed, 0, 1.15);
    const propVector = Math.abs(boat.throttle) * 0.36;
    const turnAuthority =
      PHYSICS.minTurnFactor +
      (1 - PHYSICS.minTurnFactor) * clamp(speedRatio * 1.3 + propVector, 0, 1);
    const reverseSign = vForward < -14 ? -0.78 : 1.0;
    const countdownTurnScale = isCountdown ? 0.65 : 1.0;

    const targetAngVel =
      boat.steer * PHYSICS.turnRate * turnAuthority * reverseSign * countdownTurnScale;
    boat.angularVel += (targetAngVel - boat.angularVel) * Math.min(1, PHYSICS.angularDrag * safeDt);

    const prevHeading = boat.heading;
    boat.heading = wrapAngle(boat.heading + boat.angularVel * safeDt);

    // Subtle chine-carve redirection: turning partially redirects forward flow along new hull axis
    // while leaving a juicy ~12-16 degree tail drift
    const newHx = Math.cos(boat.heading);
    const newHy = Math.sin(boat.heading);
    const newRx = -newHy;
    const newRy = newHx;

    // World velocity before chine carving vs aligned after chine carving
    const rawVx = hx * vForward + rx * vLateral;
    const rawVy = hy * vForward + ry * vLateral;

    const alignedVx = newHx * vForward + newRx * vLateral;
    const alignedVy = newHy * vForward + newRy * vLateral;

    // Blend ~68% chine-aligned + ~32% momentum-drifting for tactile sweeping arcs
    const chineGrip = clamp(0.68 - boat.wakeTurbulence * 0.14, 0.45, 0.75);
    boat.vx = rawVx * (1 - chineGrip) + alignedVx * chineGrip;
    boat.vy = rawVy * (1 - chineGrip) + alignedVy * chineGrip;

    // Tiny idle water current damping during title/countdown when off throttle
    if ((isCountdown || isIdleOverlay) && Math.abs(boat.throttle) < 0.03) {
      boat.vx *= Math.max(0, 1 - 3.5 * safeDt);
      boat.vy *= Math.max(0, 1 - 3.5 * safeDt);
    }

    // Integrate position
    boat.x += boat.vx * safeDt;
    boat.y += boat.vy * safeDt;
    boat.speed = hypot(boat.vx, boat.vy);

    // Dynamic visual articulation state
    boat.rudderAngle = clamp(boat.steer * PHYSICS.maxRudderAngle, -PHYSICS.maxRudderAngle, PHYSICS.maxRudderAngle);

    const latAfter = boat.vx * newRx + boat.vy * newRy;
    const targetRoll = clamp(
      boat.angularVel * (0.12 + 0.09 * speedRatio) + (latAfter / PHYSICS.maxSpeed) * 0.24,
      -PHYSICS.maxRollAngle,
      PHYSICS.maxRollAngle
    );
    boat.rollAngle += (targetRoll - boat.rollAngle) * Math.min(1, 9.5 * safeDt);

    // Ocean swell bobbing + planing skip + wake chop bounce
    const swell = Math.sin(boat.simTime * 3.0 + boat.bobPhase + boat.x * 0.011) * 0.32;
    const planeSkip = speedRatio * Math.sin(boat.simTime * 9.8 + boat.bobPhase * 1.7) * 0.34;
    const chopJolt = boat.wakeTurbulence * Math.sin(boat.simTime * 19.5 + boat.bobPhase) * 0.65;
    const planeLift = speedRatio * 0.25;
    boat.pitchBounce = swell + planeSkip + chopJolt + planeLift;

    // Whip antenna flexes smoothly with turn G-force & forward airflow
    const headingDelta = wrapAngle(boat.heading - prevHeading) / safeDt;
    const targetFlex = clamp(-headingDelta * 0.28 + speedRatio * 0.18 * Math.sin(boat.simTime * 14 + boat.bobPhase), -1.1, 1.1);
    boat.antennaFlex += (targetFlex - boat.antennaFlex) * Math.min(1, 12.0 * safeDt);
  }

  // Step 2: Boat-to-boat and coastal environment collisions
  resolveBoatCollisions(boats);
  resolveEnvironmentCollisions(boats, course, safeDt);

  // Step 3: Wake ribbons & cross-wake turbulence
  updateWakesAndTurbulence(boats, safeDt);

  // Step 4: Course progress projection
  for (let i = 0; i < boats.length; i++) {
    updateBoatProgress(boats[i], course, startT);
  }
}
