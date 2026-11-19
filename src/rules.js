// Authentic water racing rules engine & persistent Win/Loss career tracker for AquaRacers

import {
  TOTAL_LAPS,
  COUNTDOWN_SECONDS,
  PENALTY_JUMP_START,
  PENALTY_BUOY_HIT,
  PENALTY_COURSE_CUT,
  BUOY_HIT_COOLDOWN,
  CAREER_STORAGE_KEY,
  PHYSICS,
} from './constants.js';
import { projectPointOnCourse } from './course.js';

const MAX_HISTORY_ENTRIES = 15;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function ensureBoatRuleFields(boat) {
  if (!(boat.passedBuoysThisLap instanceof Set)) {
    boat.passedBuoysThisLap = new Set(Array.isArray(boat.passedBuoysThisLap) ? boat.passedBuoysThisLap : []);
  }
  if (!(boat.penalizedBuoysThisLap instanceof Set)) {
    boat.penalizedBuoysThisLap = new Set();
  }
  if (!(boat.buoyHitCooldowns instanceof Map)) {
    boat.buoyHitCooldowns = new Map();
  }
  if (!Array.isArray(boat.penaltyLog)) {
    boat.penaltyLog = [];
  }
  if (!Array.isArray(boat.lapTimes)) {
    boat.lapTimes = [];
  }
  if (!boat.missedBuoyWarning || typeof boat.missedBuoyWarning !== 'object') {
    boat.missedBuoyWarning = { active: false, buoyIndex: -1, timer: 0 };
  }
  if (typeof boat.lap !== 'number' || boat.lap < 1) boat.lap = 1;
  if (typeof boat.nextBuoyIndex !== 'number' || boat.nextBuoyIndex < 0) boat.nextBuoyIndex = 0;
  if (typeof boat.penalties !== 'number') boat.penalties = 0;
  if (typeof boat.currentLapStart !== 'number') boat.currentLapStart = 0;
  if (boat.bestLap === undefined) boat.bestLap = null;
  if (boat.finishTime === undefined) boat.finishTime = null;
  if (typeof boat.finished !== 'boolean') boat.finished = false;
  if (typeof boat.jumpStarted !== 'boolean') boat.jumpStarted = false;
}

function applyPenalty(boat, type, seconds, reason, time) {
  boat.penalties = Math.round((boat.penalties + seconds) * 100) / 100;
  boat.penaltyLog.push({
    type,
    seconds,
    reason,
    time,
    lap: boat.lap,
  });
}

function computeBoatLapProgress(boat, course, proj) {
  if (boat.finished) {
    return { lapProgress: 1, totalProgress: TOTAL_LAPS };
  }

  const buoyCount = course.buoys.length;
  const resolvedCount = boat.passedBuoysThisLap.size + (boat.penalizedBuoysThisLap ? boat.penalizedBuoysThisLap.size : 0);
  let lp = proj.t;

  // Boats staged behind the start line at t ~ 0.94..0.99 have negative lapProgress until crossing t = 0
  if (resolvedCount === 0 && lp > 0.72) {
    lp -= 1;
  } else if (resolvedCount >= Math.max(1, buoyCount - 1) && lp < 0.14) {
    // Just crossed or sitting right at the finish line before wrap triggers
    lp += 1;
  }

  const totalProgress = (boat.lap - 1) + lp;
  return { lapProgress: lp, totalProgress };
}

function checkGateCrossing(prevX, prevY, currX, currY, buoy) {
  const prevAlong = (prevX - buoy.x) * buoy.dirX + (prevY - buoy.y) * buoy.dirY;
  const currAlong = (currX - buoy.x) * buoy.dirX + (currY - buoy.y) * buoy.dirY;

  if (prevAlong < 0 && currAlong >= 0) {
    const denom = currAlong - prevAlong;
    const frac = denom > 1e-6 ? clamp(-prevAlong / denom, 0, 1) : 1;
    const cx = prevX + (currX - prevX) * frac;
    const cy = prevY + (currY - prevY) * frac;
    const outDist = (cx - buoy.x) * buoy.outX + (cy - buoy.y) * buoy.outY;
    return { crossed: true, outDist, cx, cy };
  }

  return { crossed: false, outDist: 0, cx: currX, cy: currY };
}

/**
 * Create a fresh race state for a generated course.
 * @param {object} course
 */
export function createRaceState(course) {
  return {
    phase: 'countdown', // 'countdown' | 'racing' | 'finished'
    countdown: COUNTDOWN_SECONDS,
    countdownStep: COUNTDOWN_SECONDS,
    countdownStarted: false,
    raceTime: 0,
    totalLaps: TOTAL_LAPS,
    buoyCount: course.buoys.length,
    events: [],
    standings: [],
    finalStandings: null,
    playerFinishTime: null,
    finishGraceDuration: 2.2,
    lastPositions: new Map(),
    finishedOrder: [],
    courseName: course.name,
    courseSeed: course.seed,
  };
}

/**
 * Advance authentic water racing rules for one simulation tick.
 * Mutates `raceState`, `boats` rule fields, and buoy hit animation state.
 * Returns `raceState.events` emitted during this tick.
 */
export function updateRaceRules(raceState, boats, course, dt) {
  const safeDt = Math.max(0, Math.min(dt || 0, 0.25));
  raceState.events = [];

  // Decay buoy hit animations smoothly every frame
  for (let i = 0; i < course.buoys.length; i++) {
    const b = course.buoys[i];
    if (b.hitTimer > 0) {
      b.hitTimer = Math.max(0, b.hitTimer - safeDt * 1.35);
    }
    if (b.outerHitTimer > 0) {
      b.outerHitTimer = Math.max(0, b.outerHitTimer - safeDt * 1.35);
    }
    const damp = Math.exp(-5.5 * safeDt);
    b.hitVelX = (b.hitVelX || 0) * damp;
    b.hitVelY = (b.hitVelY || 0) * damp;
    if (Math.abs(b.hitVelX) < 0.1) b.hitVelX = 0;
    if (Math.abs(b.hitVelY) < 0.1) b.hitVelY = 0;
  }

  const sl = course.startLine;
  const buoys = course.buoys;
  const buoyCount = buoys.length;

  // Ensure all boats have rule fields & seed previous positions on first frame
  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    ensureBoatRuleFields(boat);
    if (!raceState.lastPositions.has(boat.id)) {
      const proj = projectPointOnCourse(course, boat.x, boat.y);
      const slDist = (boat.x - sl.x) * sl.tx + (boat.y - sl.y) * sl.ty;
      raceState.lastPositions.set(boat.id, {
        x: boat.x,
        y: boat.y,
        t: proj.t,
        slDist,
      });
    }
  }

  // --- PHASE 1: COUNTDOWN & JUMP START ---
  if (raceState.phase === 'countdown') {
    if (!raceState.countdownStarted) {
      raceState.countdownStarted = true;
      const initialStep = Math.max(1, Math.ceil(raceState.countdown));
      raceState.countdownStep = initialStep;
      raceState.events.push({
        type: 'countdown_tick',
        value: initialStep,
        time: 0,
      });
    }

    raceState.countdown -= safeDt;

    // Check jump starts before GO
    if (raceState.countdown > 0) {
      const nextStep = Math.ceil(raceState.countdown);
      if (nextStep < raceState.countdownStep && nextStep >= 1) {
        raceState.countdownStep = nextStep;
        raceState.events.push({
          type: 'countdown_tick',
          value: nextStep,
          time: 0,
        });
      }

      for (let i = 0; i < boats.length; i++) {
        const boat = boats[i];
        const prev = raceState.lastPositions.get(boat.id);
        const currSL = (boat.x - sl.x) * sl.tx + (boat.y - sl.y) * sl.ty;
        const currLat = Math.abs((boat.x - sl.x) * sl.nx + (boat.y - sl.y) * sl.ny);

        if (!boat.jumpStarted && currSL > 2 && currLat <= sl.halfWidth * 1.85) {
          boat.jumpStarted = true;
          applyPenalty(boat, 'jump_start', PENALTY_JUMP_START, 'Jump Start', 0);
          raceState.events.push({
            type: 'jump_start',
            boatId: boat.id,
            boatName: boat.name,
            isPlayer: boat.isPlayer,
            penalty: PENALTY_JUMP_START,
            time: 0,
            x: boat.x,
            y: boat.y,
          });
        }

        const proj = projectPointOnCourse(course, boat.x, boat.y);
        const prog = computeBoatLapProgress(boat, course, proj);
        boat.lapProgress = prog.lapProgress;
        boat.totalProgress = prog.totalProgress;

        prev.x = boat.x;
        prev.y = boat.y;
        prev.t = proj.t;
        prev.slDist = currSL;
      }

      raceState.standings = computeStandings(boats, course, raceState);
      return raceState.events;
    }

    // Countdown reached 0 -> GO!
    raceState.countdown = 0;
    raceState.countdownStep = 0;
    raceState.phase = 'racing';
    raceState.raceTime = 0;
    for (let i = 0; i < boats.length; i++) {
      boats[i].currentLapStart = 0;
    }
    raceState.events.push({
      type: 'race_start',
      time: 0,
    });
  }

  // --- PHASE 3: ALREADY FINISHED ---
  if (raceState.phase === 'finished') {
    if (!raceState.finalStandings) {
      raceState.finalStandings = computeStandings(boats, course, raceState);
    }
    raceState.standings = raceState.finalStandings;
    return raceState.events;
  }

  // --- PHASE 2: ACTIVE RACING ---
  raceState.raceTime += safeDt;
  const boatRadius = PHYSICS.boatRadius || 15;
  const requiredBuoysForLap = Math.ceil(buoyCount * 0.8);

  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    const prev = raceState.lastPositions.get(boat.id);
    const prevX = prev.x;
    const prevY = prev.y;
    const prevT = prev.t;
    const prevSL = prev.slDist;

    const proj = projectPointOnCourse(course, boat.x, boat.y);
    const currSL = (boat.x - sl.x) * sl.tx + (boat.y - sl.y) * sl.ty;

    if (!boat.finished) {
      // 1. Update buoy collision cooldowns & detect Buoy Whacks
      for (const [key, remaining] of boat.buoyHitCooldowns.entries()) {
        const nextRem = remaining - safeDt;
        if (nextRem <= 0) {
          boat.buoyHitCooldowns.delete(key);
        } else {
          boat.buoyHitCooldowns.set(key, nextRem);
        }
      }

      for (let bIdx = 0; bIdx < buoyCount; bIdx++) {
        const b = buoys[bIdx];
        if (boat.buoyHitCooldowns.has(bIdx)) continue;

        const apexHitDist = boatRadius + (b.radius || PHYSICS.buoyRadius);
        const dxA = boat.x - b.x;
        const dyA = boat.y - b.y;
        const distASq = dxA * dxA + dyA * dyA;

        const outerHitDist = boatRadius + (b.outerRadius || PHYSICS.outerBuoyRadius);
        const dxO = boat.x - b.outerX;
        const dyO = boat.y - b.outerY;
        const distOSq = dxO * dxO + dyO * dyO;

        const hitApex = distASq < apexHitDist * apexHitDist;
        const hitOuter = !hitApex && distOSq < outerHitDist * outerHitDist;

        if (hitApex || hitOuter) {
          boat.buoyHitCooldowns.set(bIdx, BUOY_HIT_COOLDOWN);
          const bx = hitApex ? b.x : b.outerX;
          const by = hitApex ? b.y : b.outerY;
          const hitR = hitApex ? apexHitDist : outerHitDist;
          const dx = hitApex ? dxA : dxO;
          const dy = hitApex ? dyA : dyO;
          const d = Math.hypot(dx, dy) || 1;
          const nx = dx / d;
          const ny = dy / d;

          // Knock the floating buoy away from the hull
          if (hitApex) {
            b.hitTimer = 1.0;
            const impulse = Math.max(85, (boat.speed || 120) * 0.65);
            b.hitVelX = -nx * impulse + (boat.vx || 0) * 0.25;
            b.hitVelY = -ny * impulse + (boat.vy || 0) * 0.25;
          } else {
            b.outerHitTimer = 1.0;
          }

          // Gentle physical deflection so boat never snags on the buoy
          const overlap = Math.max(0, hitR - d);
          boat.x += nx * (overlap + 1.5);
          boat.y += ny * (overlap + 1.5);
          if (typeof boat.vx === 'number' && typeof boat.vy === 'number') {
            boat.vx = boat.vx * 0.88 + nx * 28;
            boat.vy = boat.vy * 0.88 + ny * 28;
          }

          applyPenalty(boat, 'buoy_hit', PENALTY_BUOY_HIT, `Buoy #${bIdx + 1} Hit`, raceState.raceTime);
          raceState.events.push({
            type: 'buoy_hit',
            boatId: boat.id,
            boatName: boat.name,
            isPlayer: boat.isPlayer,
            buoyIndex: bIdx,
            isOuter: hitOuter,
            penalty: PENALTY_BUOY_HIT,
            time: raceState.raceTime,
            x: bx,
            y: by,
          });
        }
      }

      // 2. Buoy Rounding, Missed Buoy Warning, and Course Cut Penalty
      const expectedIdx = boat.nextBuoyIndex % buoyCount;
      const expectedBuoy = buoys[expectedIdx];
      const gateSpan = Math.hypot(expectedBuoy.outerX - expectedBuoy.x, expectedBuoy.outerY - expectedBuoy.y);
      const outerMax = Math.max(gateSpan + course.corridorHalfWidth * 0.95, course.corridorHalfWidth * 2.05);
      const insideMax = course.corridorHalfWidth * 1.45;

      const expectedCross = checkGateCrossing(prevX, prevY, boat.x, boat.y, expectedBuoy);
      let advancedExpected = false;

      if (expectedCross.crossed) {
        if (expectedCross.outDist >= -6 && expectedCross.outDist <= outerMax) {
          // Valid outside rounding!
          boat.passedBuoysThisLap.add(expectedIdx);
          boat.nextBuoyIndex = (expectedIdx + 1) % buoyCount;
          boat.missedBuoyWarning = { active: false, buoyIndex: -1, timer: 0 };
          advancedExpected = true;

          raceState.events.push({
            type: 'buoy_rounded',
            boatId: boat.id,
            boatName: boat.name,
            isPlayer: boat.isPlayer,
            buoyIndex: expectedIdx,
            time: raceState.raceTime,
            x: expectedBuoy.x,
            y: expectedBuoy.y,
          });
        } else if (expectedCross.outDist < -6 && expectedCross.outDist > -insideMax) {
          // Passed on the wrong (inside) side of the turn buoy!
          const alreadyWarned = boat.missedBuoyWarning.active && boat.missedBuoyWarning.buoyIndex === expectedIdx;
          boat.missedBuoyWarning = {
            active: true,
            buoyIndex: expectedIdx,
            timer: 4.5,
          };
          if (!alreadyWarned) {
            raceState.events.push({
              type: 'missed_buoy',
              boatId: boat.id,
              boatName: boat.name,
              isPlayer: boat.isPlayer,
              buoyIndex: expectedIdx,
              time: raceState.raceTime,
              x: expectedBuoy.x,
              y: expectedBuoy.y,
            });
          }
        }
      }

      // Check skip-ahead (course cut) if boat rounded a subsequent buoy without correcting
      if (!advancedExpected && expectedIdx + 1 < buoyCount) {
        const lookaheadMax = Math.min(buoyCount - 1, expectedIdx + 2);
        for (let skipIdx = expectedIdx + 1; skipIdx <= lookaheadMax; skipIdx++) {
          const nextBuoy = buoys[skipIdx];
          const nextSpan = Math.hypot(nextBuoy.outerX - nextBuoy.x, nextBuoy.outerY - nextBuoy.y);
          const nextOuterMax = Math.max(nextSpan + course.corridorHalfWidth * 0.95, course.corridorHalfWidth * 2.05);
          const skipCross = checkGateCrossing(prevX, prevY, boat.x, boat.y, nextBuoy);

          if (skipCross.crossed && skipCross.outDist >= -6 && skipCross.outDist <= nextOuterMax) {
            // Assess course-cut penalty for each skipped buoy so racing never softlocks
            for (let missedIdx = expectedIdx; missedIdx < skipIdx; missedIdx++) {
              if (!boat.passedBuoysThisLap.has(missedIdx) && !boat.penalizedBuoysThisLap.has(missedIdx)) {
                boat.penalizedBuoysThisLap.add(missedIdx);
                applyPenalty(
                  boat,
                  'course_cut',
                  PENALTY_COURSE_CUT,
                  `Course Cut (Buoy #${missedIdx + 1})`,
                  raceState.raceTime
                );
                raceState.events.push({
                  type: 'course_cut_penalty',
                  boatId: boat.id,
                  boatName: boat.name,
                  isPlayer: boat.isPlayer,
                  buoyIndex: missedIdx,
                  penalty: PENALTY_COURSE_CUT,
                  time: raceState.raceTime,
                  x: buoys[missedIdx].x,
                  y: buoys[missedIdx].y,
                });
              }
            }

            boat.passedBuoysThisLap.add(skipIdx);
            boat.nextBuoyIndex = (skipIdx + 1) % buoyCount;
            boat.missedBuoyWarning = { active: false, buoyIndex: -1, timer: 0 };

            raceState.events.push({
              type: 'buoy_rounded',
              boatId: boat.id,
              boatName: boat.name,
              isPlayer: boat.isPlayer,
              buoyIndex: skipIdx,
              time: raceState.raceTime,
              x: nextBuoy.x,
              y: nextBuoy.y,
            });
            break;
          }
        }
      }

      if (boat.missedBuoyWarning.active) {
        boat.missedBuoyWarning.timer = Math.max(0.1, boat.missedBuoyWarning.timer - safeDt);
      }

      // 3. Start/Finish Line Crossing -> Lap Completion & Finish
      let crossedStartForward = false;
      if (prevSL < 0 && currSL >= 0) {
        const denom = currSL - prevSL;
        const frac = denom > 1e-6 ? clamp(-prevSL / denom, 0, 1) : 1;
        const cx = prevX + (boat.x - prevX) * frac;
        const cy = prevY + (boat.y - prevY) * frac;
        const slLat = Math.abs((cx - sl.x) * sl.nx + (cy - sl.y) * sl.ny);
        if (slLat <= sl.halfWidth * 1.75) {
          crossedStartForward = true;
        }
      } else if (prevT > 0.78 && proj.t < 0.22) {
        crossedStartForward = true;
      }

      if (crossedStartForward) {
        const preResolved = boat.passedBuoysThisLap.size + boat.penalizedBuoysThisLap.size;

        // If the boat skipped only the final buoy right before the finish line, penalize and advance cleanly
        if (boat.nextBuoyIndex === buoyCount - 1 && preResolved >= Math.max(1, requiredBuoysForLap - 1)) {
          const lastIdx = buoyCount - 1;
          if (!boat.passedBuoysThisLap.has(lastIdx) && !boat.penalizedBuoysThisLap.has(lastIdx)) {
            boat.penalizedBuoysThisLap.add(lastIdx);
            applyPenalty(
              boat,
              'course_cut',
              PENALTY_COURSE_CUT,
              `Course Cut (Buoy #${lastIdx + 1})`,
              raceState.raceTime
            );
            raceState.events.push({
              type: 'course_cut_penalty',
              boatId: boat.id,
              boatName: boat.name,
              isPlayer: boat.isPlayer,
              buoyIndex: lastIdx,
              penalty: PENALTY_COURSE_CUT,
              time: raceState.raceTime,
              x: buoys[lastIdx].x,
              y: buoys[lastIdx].y,
            });
          }
          boat.nextBuoyIndex = 0;
          boat.missedBuoyWarning = { active: false, buoyIndex: -1, timer: 0 };
        }

        const resolvedCount = boat.passedBuoysThisLap.size + boat.penalizedBuoysThisLap.size;
        if (resolvedCount >= requiredBuoysForLap) {
          const completedLap = boat.lap;
          const lapTime = Math.max(0.01, raceState.raceTime - boat.currentLapStart);
          boat.lapTimes.push(lapTime);
          if (boat.bestLap === null || lapTime < boat.bestLap) {
            boat.bestLap = lapTime;
          }
          boat.currentLapStart = raceState.raceTime;
          boat.passedBuoysThisLap.clear();
          boat.penalizedBuoysThisLap.clear();
          boat.nextBuoyIndex = 0;
          boat.missedBuoyWarning = { active: false, buoyIndex: -1, timer: 0 };

          if (completedLap >= raceState.totalLaps) {
            boat.finished = true;
            boat.finishTime = raceState.raceTime;
            boat.lapProgress = 1;
            boat.totalProgress = raceState.totalLaps;
            raceState.finishedOrder.push(boat.id);

            raceState.events.push({
              type: 'lap_complete',
              boatId: boat.id,
              boatName: boat.name,
              isPlayer: boat.isPlayer,
              completedLap,
              lap: completedLap,
              lapTime,
              bestLap: boat.bestLap,
              time: raceState.raceTime,
            });

            raceState.events.push({
              type: 'boat_finish',
              boatId: boat.id,
              boatName: boat.name,
              isPlayer: boat.isPlayer,
              finishTime: boat.finishTime,
              penalties: boat.penalties,
              adjustedTime: boat.finishTime + boat.penalties,
              time: raceState.raceTime,
            });

            if (boat.isPlayer && raceState.playerFinishTime === null) {
              raceState.playerFinishTime = raceState.raceTime;
            }
          } else {
            boat.lap = completedLap + 1;
            raceState.events.push({
              type: 'lap_complete',
              boatId: boat.id,
              boatName: boat.name,
              isPlayer: boat.isPlayer,
              completedLap,
              lap: boat.lap,
              lapTime,
              bestLap: boat.bestLap,
              time: raceState.raceTime,
            });

            if (boat.lap === raceState.totalLaps) {
              raceState.events.push({
                type: 'final_lap',
                boatId: boat.id,
                boatName: boat.name,
                isPlayer: boat.isPlayer,
                lap: boat.lap,
                time: raceState.raceTime,
              });
            }
          }
        }
      }
    }

    // Update lap/total progress cleanly
    const prog = computeBoatLapProgress(boat, course, proj);
    boat.lapProgress = prog.lapProgress;
    boat.totalProgress = prog.totalProgress;

    prev.x = boat.x;
    prev.y = boat.y;
    prev.t = proj.t;
    prev.slDist = currSL;
  }

  // 4. Check Race Finish condition
  const allFinished = boats.length > 0 && boats.every((b) => b.finished);
  const playerGraceExpired =
    raceState.playerFinishTime !== null &&
    (raceState.raceTime - raceState.playerFinishTime) >= raceState.finishGraceDuration;

  if (allFinished || playerGraceExpired) {
    // Extrapolate remaining unfinished AI boats fairly
    for (let i = 0; i < boats.length; i++) {
      const boat = boats[i];
      if (!boat.finished) {
        const remainingLaps = Math.max(0.015, raceState.totalLaps - Math.max(0, boat.totalProgress || 0));
        const distanceCovered = Math.max(course.totalLength * 0.25, Math.max(0, boat.totalProgress || 0) * course.totalLength);
        const avgSpeed = clamp(distanceCovered / Math.max(1, raceState.raceTime), 155, 285);
        const remainingTime = (remainingLaps * course.totalLength) / avgSpeed;

        boat.finished = true;
        boat.finishTime = raceState.raceTime + remainingTime;
        boat.lapProgress = 1;
        boat.totalProgress = raceState.totalLaps;
      }
    }

    raceState.phase = 'finished';
    const finalStandings = computeStandings(boats, course, raceState);
    raceState.finalStandings = finalStandings;
    raceState.standings = finalStandings;
    const playerStanding = finalStandings.find((s) => s.isPlayer) || finalStandings[0] || null;

    raceState.events.push({
      type: 'race_finish',
      standings: finalStandings,
      playerStanding,
      time: raceState.raceTime,
    });

    return raceState.events;
  }

  raceState.standings = computeStandings(boats, course, raceState);
  return raceState.events;
}

/**
 * Compute sorted live or final penalty-adjusted race standings.
 */
export function computeStandings(boats, course, raceState) {
  const totalLaps = raceState?.totalLaps || TOTAL_LAPS;
  const entries = boats.map((boat, idx) => {
    const penalties = boat.penalties || 0;
    const finished = Boolean(boat.finished && typeof boat.finishTime === 'number');
    const adjustedTime = finished ? boat.finishTime + penalties : null;

    let totalProgress = typeof boat.totalProgress === 'number' ? boat.totalProgress : 0;
    if (finished) {
      totalProgress = totalLaps;
    } else if (course && typeof boat.x === 'number' && typeof boat.y === 'number' && totalProgress === 0 && boat.lap === 1) {
      const proj = projectPointOnCourse(course, boat.x, boat.y);
      const prog = computeBoatLapProgress(boat, course, proj);
      totalProgress = prog.totalProgress;
    }

    return {
      rank: 0,
      boatId: boat.id,
      id: boat.id,
      name: boat.name,
      number: boat.number,
      isPlayer: Boolean(boat.isPlayer),
      primaryColor: boat.primaryColor,
      accentColor: boat.accentColor,
      lap: Math.min(totalLaps, boat.lap || 1),
      totalProgress,
      finished,
      finishTime: finished ? boat.finishTime : null,
      penalties,
      penaltyLog: Array.isArray(boat.penaltyLog) ? [...boat.penaltyLog] : [],
      adjustedTime,
      bestLap: boat.bestLap ?? null,
      lapTimes: Array.isArray(boat.lapTimes) ? [...boat.lapTimes] : [],
      gapToLeader: 0,
      _idx: idx,
    };
  });

  entries.sort((a, b) => {
    if (a.finished && b.finished) {
      if (Math.abs(a.adjustedTime - b.adjustedTime) > 1e-6) {
        return a.adjustedTime - b.adjustedTime;
      }
      if (Math.abs(a.finishTime - b.finishTime) > 1e-6) {
        return a.finishTime - b.finishTime;
      }
      return a._idx - b._idx;
    }
    if (a.finished !== b.finished) {
      return a.finished ? -1 : 1;
    }
    if (Math.abs(b.totalProgress - a.totalProgress) > 1e-6) {
      return b.totalProgress - a.totalProgress;
    }
    if (a.penalties !== b.penalties) {
      return a.penalties - b.penalties;
    }
    return a._idx - b._idx;
  });

  const leader = entries[0];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e.rank = i + 1;
    if (i === 0) {
      e.gapToLeader = 0;
    } else if (e.finished && leader.finished) {
      e.gapToLeader = Math.max(0, e.adjustedTime - leader.adjustedTime);
    } else {
      const progressDiff = Math.max(0, leader.totalProgress - e.totalProgress);
      const estLapSec = course ? course.totalLength / 235 : 14;
      e.gapToLeader = progressDiff * estLapSec;
    }
    delete e._idx;
  }

  return entries;
}

// --- PERSISTENT WIN/LOSS CAREER TRACKER ---

function createEmptyCareerRecord() {
  return {
    wins: 0,
    losses: 0,
    podiums: 0,
    races: 0,
    currentStreak: 0,
    bestStreak: 0,
    bestLapTime: null,
    history: [],
  };
}

function normalizeCareerRecord(raw) {
  const base = createEmptyCareerRecord();
  if (!raw || typeof raw !== 'object') return base;

  const nonNegInt = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const wins = nonNegInt(raw.wins);
  const losses = nonNegInt(raw.losses);
  const podiums = nonNegInt(raw.podiums);
  const races = Math.max(wins + losses, nonNegInt(raw.races));
  const currentStreak = nonNegInt(raw.currentStreak);
  const bestStreak = Math.max(currentStreak, nonNegInt(raw.bestStreak));
  const bestLapTime =
    typeof raw.bestLapTime === 'number' && Number.isFinite(raw.bestLapTime) && raw.bestLapTime > 0
      ? raw.bestLapTime
      : null;

  const history = Array.isArray(raw.history)
    ? raw.history.slice(0, MAX_HISTORY_ENTRIES).map((h) => ({
        date: typeof h?.date === 'string' ? h.date : new Date().toISOString(),
        courseName: typeof h?.courseName === 'string' ? h.courseName : 'Coastal Circuit',
        archetype: typeof h?.archetype === 'string' ? h.archetype : '',
        seed: h?.seed ?? null,
        rank: nonNegInt(h?.rank) || 1,
        won: Boolean(h?.won ?? h?.rank === 1),
        finishTime: typeof h?.finishTime === 'number' && Number.isFinite(h.finishTime) ? h.finishTime : null,
        penalties: typeof h?.penalties === 'number' && Number.isFinite(h.penalties) ? h.penalties : 0,
        adjustedTime: typeof h?.adjustedTime === 'number' && Number.isFinite(h.adjustedTime) ? h.adjustedTime : null,
        bestLap: typeof h?.bestLap === 'number' && Number.isFinite(h.bestLap) ? h.bestLap : null,
      }))
    : [];

  return {
    wins,
    losses,
    podiums,
    races,
    currentStreak,
    bestStreak,
    bestLapTime,
    history,
  };
}

function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    return storage;
  }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function loadCareerRecord(storage) {
  const store = resolveStorage(storage);
  if (!store) return createEmptyCareerRecord();
  try {
    const raw = store.getItem(CAREER_STORAGE_KEY);
    if (!raw) return createEmptyCareerRecord();
    return normalizeCareerRecord(JSON.parse(raw));
  } catch {
    return createEmptyCareerRecord();
  }
}

export function saveCareerRecord(record, storage) {
  const normalized = normalizeCareerRecord(record);
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(CAREER_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function recordRaceResult(record, playerStanding, course, storage) {
  const current = normalizeCareerRecord(record);
  const rank = Math.max(1, Math.floor(playerStanding?.rank || 5));
  const isWin = rank === 1;
  const isPodium = rank >= 1 && rank <= 3;

  const wins = current.wins + (isWin ? 1 : 0);
  const losses = current.losses + (isWin ? 0 : 1);
  const podiums = current.podiums + (isPodium ? 1 : 0);
  const races = current.races + 1;
  const currentStreak = isWin ? current.currentStreak + 1 : 0;
  const bestStreak = Math.max(current.bestStreak, currentStreak);

  const raceBestLap =
    typeof playerStanding?.bestLap === 'number' &&
    Number.isFinite(playerStanding.bestLap) &&
    playerStanding.bestLap > 0
      ? playerStanding.bestLap
      : null;

  const bestLapTime =
    raceBestLap !== null
      ? (current.bestLapTime === null ? raceBestLap : Math.min(current.bestLapTime, raceBestLap))
      : current.bestLapTime;

  const entry = {
    date: new Date().toISOString(),
    courseName: course?.name || 'Coastal Circuit',
    archetype: course?.archetype || '',
    seed: course?.seed ?? null,
    rank,
    won: isWin,
    finishTime: typeof playerStanding?.finishTime === 'number' ? playerStanding.finishTime : null,
    penalties: typeof playerStanding?.penalties === 'number' ? playerStanding.penalties : 0,
    adjustedTime: typeof playerStanding?.adjustedTime === 'number' ? playerStanding.adjustedTime : null,
    bestLap: raceBestLap,
  };

  const history = [entry, ...current.history].slice(0, MAX_HISTORY_ENTRIES);

  const updated = {
    wins,
    losses,
    podiums,
    races,
    currentStreak,
    bestStreak,
    bestLapTime,
    history,
  };

  saveCareerRecord(updated, storage);
  return updated;
}

export function resetCareerRecord(storage) {
  const fresh = createEmptyCareerRecord();
  const store = resolveStorage(storage);
  if (store) {
    try {
      if (typeof store.removeItem === 'function') {
        store.removeItem(CAREER_STORAGE_KEY);
      } else {
        store.setItem(CAREER_STORAGE_KEY, JSON.stringify(fresh));
      }
    } catch {
      // Ignore storage errors in restricted environments
    }
  }
  return fresh;
}
