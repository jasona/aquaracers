// AquaRacers — Main Entry Point, Game Loop, Input & Nautical UI Controller

import {
  TOTAL_LAPS,
  BOAT_COUNT,
  PHYSICS,
  PENALTY_JUMP_START,
  PENALTY_BUOY_HIT,
  PENALTY_COURSE_CUT,
} from './constants.js';
import { generateCourse } from './course.js';
import { createBoats, updatePhysics } from './physics.js';
import {
  createRaceState,
  updateRaceRules,
  computeStandings,
  loadCareerRecord,
  recordRaceResult,
  resetCareerRecord,
} from './rules.js';
import { createRenderer } from './renderer.js';
import { createAudioEngine } from './audio.js';

const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.1;

// ==========================================================================
// Formatting Helpers
// ==========================================================================

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function formatOrdinal(rank) {
  const n = Math.max(1, Math.round(rank || 1));
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--.-';
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const minStr = String(mins).padStart(2, '0');
  const secStr = secs.toFixed(1).padStart(4, '0');
  return `${minStr}:${secStr}`;
}

function formatDeltaPenalty(penalties) {
  if (!penalties || penalties <= 0.001) return '—';
  return `+${penalties.toFixed(1)}s`;
}

function formatDirectionShort(dir) {
  return dir === -1 ? 'CCW' : 'CW';
}

function formatDirectionLong(dir) {
  return dir === -1 ? 'Counter-Clockwise (CCW)' : 'Clockwise (CW)';
}

function computeWinPct(record) {
  const races = record?.races || 0;
  if (races <= 0) return '0%';
  return `${Math.round(((record.wins || 0) / races) * 100)}%`;
}

function speedToKnots(pxPerSec) {
  const maxSpd = PHYSICS?.maxSpeed || 295;
  // Scale realistic RC offshore scale top speed (~48 knots)
  return Math.max(0, Math.round((Math.abs(pxPerSec || 0) / maxSpd) * 48));
}

function resetCourseBuoyVisuals(course) {
  if (!course || !Array.isArray(course.buoys)) return;
  for (const buoy of course.buoys) {
    buoy.hitTimer = 0;
    buoy.outerHitTimer = 0;
    buoy.hitVelX = 0;
    buoy.hitVelY = 0;
  }
}

// ==========================================================================
// DOM Element References
// ==========================================================================

function queryDom() {
  return {
    app: document.getElementById('app'),
    canvas: document.getElementById('game-canvas'),

    // Top HUD
    hudPosition: document.getElementById('hud-position'),
    hudPosNum: document.getElementById('hud-pos-num'),
    hudPosTotal: document.getElementById('hud-pos-total'),
    hudLapValue: document.getElementById('hud-lap-value'),
    hudTimerValue: document.getElementById('hud-timer-value'),
    hudPenaltyBadge: document.getElementById('hud-penalty-badge'),
    hudCourseName: document.getElementById('hud-course-name'),
    hudCourseDir: document.getElementById('hud-course-dir'),
    hudCareerWins: document.getElementById('hud-career-wins'),
    hudCareerLosses: document.getElementById('hud-career-losses'),
    hudCareerPct: document.getElementById('hud-career-pct'),

    btnMute: document.getElementById('btn-mute'),
    btnRulesHud: document.getElementById('btn-rules-hud'),
    btnRestartHud: document.getElementById('btn-restart-hud'),
    btnNewCourseHud: document.getElementById('btn-new-course-hud'),

    // Missed buoy banner, countdown, toasts
    missedBuoyBanner: document.getElementById('missed-buoy-banner'),
    missedBuoyText: document.getElementById('missed-buoy-text'),
    countdownOverlay: document.getElementById('countdown-overlay'),
    countdownValue: document.getElementById('countdown-value'),
    countdownSub: document.getElementById('countdown-sub'),
    toastContainer: document.getElementById('toast-container'),

    // RC Transmitter Widget
    rcSignalLed: document.getElementById('rc-signal-led'),
    rcBuoyReadout: document.getElementById('rc-buoy-readout'),
    rcSpeedValue: document.getElementById('rc-speed-value'),
    rcThrottlePct: document.getElementById('rc-throttle-pct'),
    rcWakeTag: document.getElementById('rc-wake-tag'),
    rcThrottlePad: document.getElementById('rc-throttle-pad'),
    rcThrottleFill: document.getElementById('rc-throttle-fill'),
    rcThrottleThumb: document.getElementById('rc-throttle-thumb'),
    rcWheelPad: document.getElementById('rc-wheel-pad'),
    rcWheelRotor: document.getElementById('rc-wheel-rotor'),

    // Title Overlay
    titleOverlay: document.getElementById('title-overlay'),
    previewCourseName: document.getElementById('preview-course-name'),
    previewCourseArchetype: document.getElementById('preview-course-archetype'),
    previewCourseDirection: document.getElementById('preview-course-direction'),
    previewCourseBuoys: document.getElementById('preview-course-buoys'),
    previewCourseLaps: document.getElementById('preview-course-laps'),
    btnShuffleCourse: document.getElementById('btn-shuffle-course'),
    btnRulesTitle: document.getElementById('btn-rules-title'),
    btnStartRace: document.getElementById('btn-start-race'),

    titleCareerRaces: document.getElementById('title-career-races'),
    titleStatWins: document.getElementById('title-stat-wins'),
    titleStatLosses: document.getElementById('title-stat-losses'),
    titleStatWinPct: document.getElementById('title-stat-winpct'),
    titleStatPodiums: document.getElementById('title-stat-podiums'),
    titleStatStreak: document.getElementById('title-stat-streak'),
    titleStatBestLap: document.getElementById('title-stat-bestlap'),

    // Results Overlay
    resultsOverlay: document.getElementById('results-overlay'),
    resultsBadge: document.getElementById('results-badge'),
    resultsHeadline: document.getElementById('results-headline'),
    resultsSubtitle: document.getElementById('results-subtitle'),
    resultsOutcomePill: document.getElementById('results-outcome-pill'),
    resultsTableBody: document.getElementById('results-table-body'),

    resStatWins: document.getElementById('res-stat-wins'),
    resStatLosses: document.getElementById('res-stat-losses'),
    resStatWinPct: document.getElementById('res-stat-winpct'),
    resStatPodiums: document.getElementById('res-stat-podiums'),
    resStatStreak: document.getElementById('res-stat-streak'),
    resStatBestLap: document.getElementById('res-stat-bestlap'),

    btnResetCareer: document.getElementById('btn-reset-career'),
    resetConfirmGroup: document.getElementById('reset-confirm-group'),
    btnResetConfirm: document.getElementById('btn-reset-confirm'),
    btnResetCancel: document.getElementById('btn-reset-cancel'),

    btnBackTitle: document.getElementById('btn-back-title'),
    btnReplayCourse: document.getElementById('btn-replay-course'),
    btnNextRace: document.getElementById('btn-next-race'),

    // Rules Modal
    rulesModal: document.getElementById('rules-modal'),
    btnCloseRules: document.getElementById('btn-close-rules'),
    btnRulesOk: document.getElementById('btn-rules-ok'),
  };
}

// ==========================================================================
// Application Bootstrap
// ==========================================================================

function initApp() {
  const dom = queryDom();
  if (!dom.canvas) return;

  const renderer = createRenderer(dom.canvas);
  const audio = createAudioEngine();

  let careerRecord = loadCareerRecord();
  let course = null;
  let boats = [];
  let raceState = null;

  // 'title' | 'racing' | 'results'
  let appMode = 'title';
  let rulesOpen = false;
  let careerRecordedForRace = false;

  // Timing & animation state
  let simTime = 0;
  let accumulator = 0;
  let lastFrameMs = 0;
  let goBannerHideTimer = 0;
  let lastShownPenalty = 0;

  // Input state
  const pressedKeys = new Set();
  const pointerControl = {
    throttleActive: false,
    throttlePointerId: null,
    throttleValue: 0,
    steerActive: false,
    steerPointerId: null,
    steerValue: 0,
  };
  let smoothedWheelAngle = 0;

  // ========================================================================
  // Audio Unlock & Mute UI
  // ========================================================================

  function unlockAudio() {
    audio.unlock();
  }

  function syncMuteUI() {
    const muted = audio.isMuted();
    dom.btnMute.setAttribute('aria-pressed', String(muted));
    const onIcon = dom.btnMute.querySelector('.icon-sound-on');
    const offIcon = dom.btnMute.querySelector('.icon-sound-off');
    if (onIcon) onIcon.classList.toggle('hidden', muted);
    if (offIcon) offIcon.classList.toggle('hidden', !muted);
  }

  function toggleMute() {
    unlockAudio();
    audio.setMuted(!audio.isMuted());
    syncMuteUI();
  }

  // ========================================================================
  // Toasts & Countdown Overlay
  // ========================================================================

  function showToast(message, variant = 'info', durationMs = 2400) {
    const toast = document.createElement('div');
    toast.className = `race-toast toast-${variant}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);

    // Keep toast stack neat (max 3 simultaneous)
    while (dom.toastContainer.children.length > 3) {
      dom.toastContainer.removeChild(dom.toastContainer.firstChild);
    }

    window.setTimeout(() => {
      toast.classList.add('leaving');
      window.setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 260);
    }, durationMs);
  }

  function clearToasts() {
    dom.toastContainer.innerHTML = '';
  }

  function showCountdownNumber(text, isGo = false) {
    dom.countdownOverlay.classList.remove('hidden');
    dom.countdownValue.textContent = text;
    dom.countdownValue.classList.toggle('is-go', isGo);
    // Restart pop animation cleanly
    dom.countdownValue.style.animation = 'none';
    void dom.countdownValue.offsetWidth;
    dom.countdownValue.style.animation = '';

    dom.countdownSub.textContent = isGo
      ? 'FULL THROTTLE — ROUND BUOYS OUTSIDE!'
      : 'HOLD BEHIND START LINE';
  }

  function hideCountdown() {
    dom.countdownOverlay.classList.add('hidden');
    goBannerHideTimer = 0;
  }

  // ========================================================================
  // Career & Course UI Sync
  // ========================================================================

  function syncCareerUI() {
    const wins = careerRecord.wins || 0;
    const losses = careerRecord.losses || 0;
    const races = careerRecord.races || 0;
    const podiums = careerRecord.podiums || 0;
    const streak = careerRecord.currentStreak || 0;
    const bestLap = formatTime(careerRecord.bestLapTime);
    const pct = computeWinPct(careerRecord);

    // Top HUD pill
    dom.hudCareerWins.textContent = String(wins);
    dom.hudCareerLosses.textContent = String(losses);
    dom.hudCareerPct.textContent = pct;

    // Title screen card
    dom.titleCareerRaces.textContent = `${races} ${races === 1 ? 'Race' : 'Races'}`;
    dom.titleStatWins.textContent = String(wins);
    dom.titleStatLosses.textContent = String(losses);
    dom.titleStatWinPct.textContent = pct;
    dom.titleStatPodiums.textContent = String(podiums);
    dom.titleStatStreak.textContent = streak > 0 ? `${streak}W` : '0';
    dom.titleStatBestLap.textContent = bestLap;

    // Results screen card
    dom.resStatWins.textContent = String(wins);
    dom.resStatLosses.textContent = String(losses);
    dom.resStatWinPct.textContent = pct;
    dom.resStatPodiums.textContent = String(podiums);
    dom.resStatStreak.textContent = streak > 0 ? `${streak}W` : '0';
    dom.resStatBestLap.textContent = bestLap;
  }

  function syncCourseUI() {
    if (!course) return;
    const name = course.name || 'Harbor Bay Circuit';
    const archetype = course.archetype || 'Coastal Circuit';
    const dirShort = formatDirectionShort(course.direction);
    const dirLong = formatDirectionLong(course.direction);
    const buoyCount = Array.isArray(course.buoys) ? course.buoys.length : 0;

    dom.hudCourseName.textContent = name;
    dom.hudCourseDir.textContent = dirShort;

    dom.previewCourseName.textContent = name;
    dom.previewCourseArchetype.textContent = archetype;
    dom.previewCourseDirection.textContent = dirLong;
    dom.previewCourseBuoys.textContent = `${buoyCount} Buoys`;
    dom.previewCourseLaps.textContent = `${TOTAL_LAPS} Laps • ${BOAT_COUNT} Boats`;
  }

  // ========================================================================
  // Mode Transitions & Race Lifecycle
  // ========================================================================

  function setAppMode(mode) {
    appMode = mode;
    dom.app.setAttribute('data-mode', mode);
    dom.titleOverlay.classList.toggle('hidden', mode !== 'title');
    dom.resultsOverlay.classList.toggle('hidden', mode !== 'results');
    if (mode !== 'racing') {
      hideCountdown();
      dom.missedBuoyBanner.classList.add('hidden');
    }
    if (mode !== 'results') {
      closeResetConfirm();
    }
  }

  function prepareCourse(newCourse) {
    course = newCourse;
    resetCourseBuoyVisuals(course);
    boats = createBoats(course);
    raceState = createRaceState(course);
    careerRecordedForRace = false;
    lastShownPenalty = 0;
    goBannerHideTimer = 0;
    syncCourseUI();
  }

  function shufflePreviewCourse() {
    prepareCourse(generateCourse());
  }

  function startRaceOnCurrentCourse() {
    unlockAudio();
    clearToasts();
    resetCourseBuoyVisuals(course);
    boats = createBoats(course);
    raceState = createRaceState(course);
    careerRecordedForRace = false;
    lastShownPenalty = 0;
    goBannerHideTimer = 0;
    hideCountdown();
    setAppMode('racing');
  }

  function startNewCourseRace() {
    unlockAudio();
    prepareCourse(generateCourse());
    startRaceOnCurrentCourse();
  }

  function returnToTitle() {
    clearToasts();
    resetCourseBuoyVisuals(course);
    boats = createBoats(course);
    raceState = createRaceState(course);
    careerRecordedForRace = false;
    audio.updateEngine(0, 0, 0, 0, false);
    setAppMode('title');
  }

  // ========================================================================
  // Rules Modal & Reset Career Inline Confirm
  // ========================================================================

  function openRulesModal() {
    rulesOpen = true;
    dom.rulesModal.classList.remove('hidden');
    dom.btnCloseRules.focus();
  }

  function closeRulesModal() {
    rulesOpen = false;
    dom.rulesModal.classList.add('hidden');
  }

  function openResetConfirm() {
    dom.btnResetCareer.classList.add('hidden');
    dom.resetConfirmGroup.classList.remove('hidden');
  }

  function closeResetConfirm() {
    dom.resetConfirmGroup.classList.add('hidden');
    dom.btnResetCareer.classList.remove('hidden');
  }

  // ========================================================================
  // Results Overlay Rendering
  // ========================================================================

  function populateResultsOverlay(standings, playerStanding) {
    const rank = playerStanding ? playerStanding.rank : 5;
    const isWin = rank === 1;
    const isPodium = rank <= 3;

    // Rank badge styling
    dom.resultsBadge.textContent = formatOrdinal(rank).toUpperCase();
    dom.resultsBadge.className = 'results-rank-badge';
    if (rank === 1) dom.resultsBadge.classList.add('rank-1');
    else if (rank === 2) dom.resultsBadge.classList.add('rank-2');
    else if (rank === 3) dom.resultsBadge.classList.add('rank-3');
    else dom.resultsBadge.classList.add('rank-other');

    // Headline
    if (isWin) {
      dom.resultsHeadline.textContent = 'VICTORY! 1ST PLACE';
    } else if (isPodium) {
      dom.resultsHeadline.textContent = `${formatOrdinal(rank).toUpperCase()} PLACE — PODIUM`;
    } else {
      dom.resultsHeadline.textContent = `${formatOrdinal(rank).toUpperCase()} PLACE`;
    }

    const dirShort = formatDirectionShort(course?.direction);
    dom.resultsSubtitle.textContent = `${course?.name || 'Bay Circuit'} • ${dirShort} • ${TOTAL_LAPS} Laps`;

    // Outcome pill
    dom.resultsOutcomePill.textContent = isWin ? '+1 WIN' : '+1 LOSS';
    dom.resultsOutcomePill.className = `outcome-pill ${isWin ? 'outcome-win' : 'outcome-loss'}`;

    // Build classification rows
    const tbody = dom.resultsTableBody;
    tbody.innerHTML = '';

    for (const entry of standings) {
      const boat = boats.find((b) => b.id === entry.boatId) || entry.boat || {};
      const tr = document.createElement('tr');
      if (entry.isPlayer || boat.isPlayer) {
        tr.classList.add('is-player');
      }

      const rawTime = entry.finishTime ?? boat.finishTime ?? raceState.raceTime;
      const pen = entry.penalties ?? boat.penalties ?? 0;
      const adjTime = entry.adjustedTime ?? (rawTime + pen);
      const bestLap = entry.bestLap ?? boat.bestLap ?? null;
      const primaryColor = entry.primaryColor || boat.primaryColor || '#3ce6f5';
      const accentColor = entry.accentColor || boat.accentColor || '#ffd166';
      const boatNum = entry.number || boat.number || '--';
      const boatName = entry.name || boat.name || 'RC Racer';

      // POS cell
      const tdPos = document.createElement('td');
      tdPos.className = 'tabular';
      tdPos.textContent = formatOrdinal(entry.rank);
      tr.appendChild(tdPos);

      // BOAT cell
      const tdBoat = document.createElement('td');
      const boatCell = document.createElement('div');
      boatCell.className = 'boat-cell';

      const swatch = document.createElement('span');
      swatch.className = 'livery-swatch';
      swatch.style.background = primaryColor;
      const stripe = document.createElement('span');
      stripe.className = 'livery-swatch-stripe';
      stripe.style.background = accentColor;
      swatch.appendChild(stripe);

      const numSpan = document.createElement('span');
      numSpan.className = 'boat-num';
      numSpan.textContent = `#${boatNum}`;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = boatName;

      boatCell.appendChild(swatch);
      boatCell.appendChild(numSpan);
      boatCell.appendChild(nameSpan);

      if (entry.isPlayer || boat.isPlayer) {
        const youTag = document.createElement('span');
        youTag.className = 'you-tag';
        youTag.textContent = 'YOU';
        boatCell.appendChild(youTag);
      }

      tdBoat.appendChild(boatCell);
      tr.appendChild(tdBoat);

      // RAW TIME
      const tdRaw = document.createElement('td');
      tdRaw.className = 'num-col tabular';
      tdRaw.textContent = formatTime(rawTime);
      tr.appendChild(tdRaw);

      // PENALTY
      const tdPen = document.createElement('td');
      tdPen.className = `num-col tabular ${pen > 0.001 ? 'pen-cell-nonzero' : 'pen-cell-zero'}`;
      tdPen.textContent = formatDeltaPenalty(pen);
      tr.appendChild(tdPen);

      // ADJUSTED TIME
      const tdAdj = document.createElement('td');
      tdAdj.className = 'num-col tabular adj-cell';
      tdAdj.textContent = formatTime(adjTime);
      tr.appendChild(tdAdj);

      // BEST LAP
      const tdBest = document.createElement('td');
      tdBest.className = 'num-col tabular';
      tdBest.textContent = formatTime(bestLap);
      tr.appendChild(tdBest);

      tbody.appendChild(tr);
    }
  }

  function handleRaceFinish() {
    if (careerRecordedForRace) return;
    careerRecordedForRace = true;

    const standings =
      Array.isArray(raceState.standings) && raceState.standings.length > 0
        ? raceState.standings
        : computeStandings(boats, course, raceState);

    const playerStanding =
      standings.find((s) => s.isPlayer) || standings[0] || null;

    if (playerStanding) {
      careerRecord = recordRaceResult(careerRecord, playerStanding, course);
      audio.playFinish(playerStanding.rank);
    }

    syncCareerUI();
    populateResultsOverlay(standings, playerStanding);
    setAppMode('results');
  }

  // ========================================================================
  // Race Event Processing (Audio + Renderer Effects + Toasts)
  // ========================================================================

  function getPlayerBoat() {
    return boats.find((b) => b.isPlayer) || boats[0] || null;
  }

  function isPlayerEvent(ev, player) {
    if (!ev || !player) return false;
    if (ev.isPlayer === true) return true;
    if (ev.boatId && ev.boatId === player.id) return true;
    if (ev.boat && ev.boat.id === player.id) return true;
    return false;
  }

  function flashPenaltyBadge() {
    dom.hudPenaltyBadge.classList.remove('flash');
    void dom.hudPenaltyBadge.offsetWidth;
    dom.hudPenaltyBadge.classList.add('flash');
  }

  function processRaceEvents() {
    if (!raceState || !Array.isArray(raceState.events) || raceState.events.length === 0) {
      return;
    }

    const player = getPlayerBoat();
    const events = raceState.events.splice(0, raceState.events.length);

    for (const ev of events) {
      const mine = isPlayerEvent(ev, player);

      // Enrich events with world coordinates & rank for renderer visual effects
      if (typeof renderer.triggerEffect === 'function') {
        const fxEvent = { ...ev };
        if (ev.type === 'race_start' && course?.startLine) {
          fxEvent.x = course.startLine.x;
          fxEvent.y = course.startLine.y;
        } else if ((ev.type === 'lap_complete' || ev.type === 'final_lap') && mine && player) {
          fxEvent.x = player.x;
          fxEvent.y = player.y;
        } else if (ev.type === 'race_finish') {
          fxEvent.rank = ev.playerStanding?.rank ?? 5;
          if (player) {
            fxEvent.x = player.x;
            fxEvent.y = player.y;
          }
        }
        renderer.triggerEffect(fxEvent);
      }

      switch (ev.type) {
        case 'countdown_tick': {
          const n = ev.value ?? ev.count ?? ev.number ?? 3;
          showCountdownNumber(String(n), false);
          audio.playCountdown(n);
          break;
        }
        case 'race_start': {
          showCountdownNumber('GO!', true);
          goBannerHideTimer = 0.85;
          audio.playGo();
          break;
        }
        case 'jump_start': {
          if (mine) {
            const pen = ev.penalty ?? PENALTY_JUMP_START;
            showToast(`JUMP START +${pen.toFixed(1)}s`, 'danger', 2800);
            audio.playPenalty();
            flashPenaltyBadge();
          }
          break;
        }
        case 'buoy_hit': {
          if (mine) {
            const pen = ev.penalty ?? PENALTY_BUOY_HIT;
            showToast(`BUOY HIT +${pen.toFixed(1)}s`, 'warn', 2400);
            audio.playBuoyHit();
            flashPenaltyBadge();
          }
          break;
        }
        case 'missed_buoy': {
          if (mine) {
            showToast('MISSED BUOY — LOOP BACK!', 'warn', 2600);
            audio.playPenalty();
          }
          break;
        }
        case 'course_cut':
        case 'course_cut_penalty': {
          if (mine) {
            const pen = ev.penalty ?? PENALTY_COURSE_CUT;
            showToast(`COURSE CUT +${pen.toFixed(1)}s`, 'danger', 2800);
            audio.playPenalty();
            flashPenaltyBadge();
          }
          break;
        }
        case 'lap_complete': {
          if (mine && (ev.completedLap ?? 0) < TOTAL_LAPS) {
            const lapNum = ev.lap ?? player?.lap ?? 2;
            if (lapNum < TOTAL_LAPS) {
              showToast(`LAP ${lapNum} / ${TOTAL_LAPS}`, 'info', 1900);
              audio.playLap(false);
            }
          }
          break;
        }
        case 'final_lap': {
          if (mine) {
            showToast('FINAL LAP!', 'gold', 2600);
            audio.playLap(true);
          }
          break;
        }
        case 'boat_finish': {
          if (mine) {
            showToast('CHECKERED FLAG!', 'gold', 2000);
          }
          break;
        }
        case 'race_finish': {
          handleRaceFinish();
          break;
        }
        default:
          break;
      }
    }
  }

  // ========================================================================
  // Input Computation (Keyboard + Tactile RC Transmitter)
  // ========================================================================

  function readPlayerInput() {
    let kbThrottle = 0;
    if (pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp')) kbThrottle += 1;
    if (pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown')) kbThrottle -= 1;

    let kbSteer = 0;
    if (pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')) kbSteer -= 1;
    if (pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')) kbSteer += 1;

    const throttle = pointerControl.throttleActive
      ? pointerControl.throttleValue
      : kbThrottle;

    const steer = pointerControl.steerActive
      ? pointerControl.steerValue
      : kbSteer;

    return {
      throttle: clamp(throttle, -1, 1),
      steer: clamp(steer, -1, 1),
    };
  }

  // ========================================================================
  // Live HUD & RC Transmitter Telemetry Update
  // ========================================================================

  function updateHudAndTransmitter(input, dt) {
    const player = getPlayerBoat();
    if (!player || !raceState || !course) return;

    // Standings & position
    const standings = computeStandings(boats, course, raceState);
    const myStanding = standings.find((s) => s.isPlayer) || standings[0];
    const rank = myStanding ? myStanding.rank : 1;

    dom.hudPosNum.textContent = formatOrdinal(rank);
    dom.hudPosTotal.textContent = `/ ${boats.length}`;
    dom.hudPosition.classList.remove('rank-1', 'rank-2', 'rank-3', 'rank-other');
    if (rank === 1) dom.hudPosition.classList.add('rank-1');
    else if (rank === 2) dom.hudPosition.classList.add('rank-2');
    else if (rank === 3) dom.hudPosition.classList.add('rank-3');
    else dom.hudPosition.classList.add('rank-other');

    // Lap counter
    const displayLap = Math.min(player.lap || 1, TOTAL_LAPS);
    dom.hudLapValue.textContent = `${displayLap} / ${TOTAL_LAPS}`;

    // Timer & penalty badge
    dom.hudTimerValue.textContent = formatTime(raceState.raceTime || 0);
    const pen = player.penalties || 0;
    if (pen > 0.001) {
      dom.hudPenaltyBadge.classList.remove('hidden');
      dom.hudPenaltyBadge.textContent = `+${pen.toFixed(1)}s`;
      if (pen > lastShownPenalty + 0.01) {
        flashPenaltyBadge();
        lastShownPenalty = pen;
      }
    } else {
      dom.hudPenaltyBadge.classList.add('hidden');
      lastShownPenalty = 0;
    }

    // Missed buoy warning banner
    const missedActive =
      appMode === 'racing' &&
      player.missedBuoyWarning &&
      player.missedBuoyWarning.active;
    dom.missedBuoyBanner.classList.toggle('hidden', !missedActive);
    if (missedActive) {
      const bNum = (player.missedBuoyWarning.buoyIndex ?? player.nextBuoyIndex ?? 0) + 1;
      dom.missedBuoyText.textContent = `MISSED BUOY #${bNum} — LOOP AROUND OUTSIDE!`;
    }

    // RC Transmitter Telemetry
    const knots = speedToKnots(player.speed);
    dom.rcSpeedValue.textContent = String(knots);

    const activeThrottle = clamp(
      Math.abs(input.throttle) > 0.01 ? input.throttle : player.throttle || 0,
      -1,
      1
    );
    const activeSteer = clamp(
      Math.abs(input.steer) > 0.01 ? input.steer : player.steer || 0,
      -1,
      1
    );

    const thrPct = Math.round(activeThrottle * 100);
    dom.rcThrottlePct.textContent =
      thrPct >= 0 ? `THR ${thrPct}%` : `REV ${Math.abs(thrPct)}%`;

    // Buoy counter on transmitter
    const totalBuoys = course.buoys ? course.buoys.length : 0;
    const nextIdx = player.nextBuoyIndex ?? 0;
    const resolvedBuoys =
      (player.passedBuoysThisLap ? player.passedBuoysThisLap.size : 0) +
      (player.penalizedBuoysThisLap ? player.penalizedBuoysThisLap.size : 0);
    if (totalBuoys > 0) {
      if (resolvedBuoys >= totalBuoys) {
        dom.rcBuoyReadout.textContent = displayLap >= TOTAL_LAPS ? 'FINISH LINE' : 'LAP LINE';
      } else {
        dom.rcBuoyReadout.textContent = `BUOY ${(nextIdx % totalBuoys) + 1}/${totalBuoys}`;
      }
    }

    // Wake chop / signal indicator
    const wakeChop = player.wakeTurbulence || 0;
    const isChoppy = wakeChop > 0.18;
    dom.rcWakeTag.textContent = isChoppy ? 'WAKE CHOP' : 'CLEAN H2O';
    dom.rcWakeTag.classList.toggle('choppy', isChoppy);
    dom.rcSignalLed.classList.toggle('warn', missedActive);

    // Smooth RC steering wheel rotation (-68deg .. +68deg)
    const targetWheelDeg = activeSteer * 68;
    const wheelLerp = 1 - Math.exp(-18 * dt);
    smoothedWheelAngle += (targetWheelDeg - smoothedWheelAngle) * wheelLerp;
    dom.rcWheelRotor.style.transform = `rotate(${smoothedWheelAngle.toFixed(1)}deg)`;
    dom.rcWheelPad.setAttribute('aria-valuenow', String(Math.round(activeSteer * 100)));

    // Throttle trigger fill & thumb position
    const thumbTopPct = 50 - activeThrottle * 44;
    dom.rcThrottleThumb.style.top = `${thumbTopPct.toFixed(1)}%`;
    dom.rcThrottlePad.setAttribute('aria-valuenow', String(thrPct));

    if (activeThrottle >= 0) {
      const hPct = activeThrottle * 50;
      dom.rcThrottleFill.classList.remove('is-reverse');
      dom.rcThrottleFill.style.top = `${(50 - hPct).toFixed(1)}%`;
      dom.rcThrottleFill.style.height = `${hPct.toFixed(1)}%`;
    } else {
      const hPct = Math.abs(activeThrottle) * 50;
      dom.rcThrottleFill.classList.add('is-reverse');
      dom.rcThrottleFill.style.top = '50%';
      dom.rcThrottleFill.style.height = `${hPct.toFixed(1)}%`;
    }
  }

  // ========================================================================
  // Interactive Tactile RC Controls (Mouse & Touch Pointer Events)
  // ========================================================================

  function updateThrottleFromPointer(clientY) {
    const rect = dom.rcThrottlePad.getBoundingClientRect();
    if (rect.height <= 0) return;
    const norm = (clientY - rect.top) / rect.height; // 0 (top/FWD) .. 1 (bottom/REV)
    const val = clamp(1 - norm * 2, -1, 1);
    pointerControl.throttleValue = Math.abs(val) < 0.08 ? 0 : val;
  }

  function updateSteerFromPointer(clientX) {
    const rect = dom.rcWheelPad.getBoundingClientRect();
    if (rect.width <= 0) return;
    const norm = (clientX - rect.left) / rect.width; // 0 (left) .. 1 (right)
    const val = clamp(norm * 2 - 1, -1, 1);
    pointerControl.steerValue = Math.abs(val) < 0.06 ? 0 : val;
  }

  function bindRcControls() {
    // Throttle pad
    dom.rcThrottlePad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      unlockAudio();
      pointerControl.throttleActive = true;
      pointerControl.throttlePointerId = e.pointerId;
      dom.rcThrottlePad.classList.add('active');
      if (dom.rcThrottlePad.setPointerCapture) {
        try {
          dom.rcThrottlePad.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if synthetic event
        }
      }
      updateThrottleFromPointer(e.clientY);
    });

    dom.rcThrottlePad.addEventListener('pointermove', (e) => {
      if (!pointerControl.throttleActive || e.pointerId !== pointerControl.throttlePointerId) {
        return;
      }
      updateThrottleFromPointer(e.clientY);
    });

    const releaseThrottle = (e) => {
      if (e.pointerId !== pointerControl.throttlePointerId) return;
      pointerControl.throttleActive = false;
      pointerControl.throttlePointerId = null;
      pointerControl.throttleValue = 0;
      dom.rcThrottlePad.classList.remove('active');
    };
    dom.rcThrottlePad.addEventListener('pointerup', releaseThrottle);
    dom.rcThrottlePad.addEventListener('pointercancel', releaseThrottle);

    // Steering wheel pad
    dom.rcWheelPad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      unlockAudio();
      pointerControl.steerActive = true;
      pointerControl.steerPointerId = e.pointerId;
      dom.rcWheelPad.classList.add('active');
      if (dom.rcWheelPad.setPointerCapture) {
        try {
          dom.rcWheelPad.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if synthetic event
        }
      }
      updateSteerFromPointer(e.clientX);
    });

    dom.rcWheelPad.addEventListener('pointermove', (e) => {
      if (!pointerControl.steerActive || e.pointerId !== pointerControl.steerPointerId) {
        return;
      }
      updateSteerFromPointer(e.clientX);
    });

    const releaseSteer = (e) => {
      if (e.pointerId !== pointerControl.steerPointerId) return;
      pointerControl.steerActive = false;
      pointerControl.steerPointerId = null;
      pointerControl.steerValue = 0;
      dom.rcWheelPad.classList.remove('active');
    };
    dom.rcWheelPad.addEventListener('pointerup', releaseSteer);
    dom.rcWheelPad.addEventListener('pointercancel', releaseSteer);
  }

  // ========================================================================
  // Keyboard & Button Bindings
  // ========================================================================

  function bindEvents() {
    window.addEventListener('resize', () => {
      renderer.resize();
    });

    window.addEventListener('blur', () => {
      pressedKeys.clear();
      pointerControl.throttleActive = false;
      pointerControl.throttleValue = 0;
      pointerControl.steerActive = false;
      pointerControl.steerValue = 0;
      dom.rcThrottlePad.classList.remove('active');
      dom.rcWheelPad.classList.remove('active');
    });

    // Unlock audio on first pointer or key gesture
    window.addEventListener('pointerdown', unlockAudio, { passive: true });

    window.addEventListener('keydown', (e) => {
      unlockAudio();

      // Prevent arrow/space page scrolling
      if (
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'Space'
      ) {
        if (document.activeElement?.tagName !== 'BUTTON') {
          e.preventDefault();
        }
      }

      pressedKeys.add(e.code);

      if (e.repeat) return;

      if (e.code === 'Escape' && rulesOpen) {
        closeRulesModal();
        return;
      }

      if (e.code === 'KeyM') {
        toggleMute();
        return;
      }

      if (rulesOpen) return;

      if (appMode === 'title') {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault();
          startRaceOnCurrentCourse();
        } else if (e.code === 'KeyN') {
          shufflePreviewCourse();
        }
        return;
      }

      if (appMode === 'racing' || appMode === 'results') {
        if (e.code === 'KeyR') {
          startRaceOnCurrentCourse();
        } else if (e.code === 'KeyN') {
          startNewCourseRace();
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      pressedKeys.delete(e.code);
    });

    // HUD buttons
    dom.btnMute.addEventListener('click', toggleMute);
    dom.btnRulesHud.addEventListener('click', openRulesModal);
    dom.btnRestartHud.addEventListener('click', () => {
      startRaceOnCurrentCourse();
    });
    dom.btnNewCourseHud.addEventListener('click', () => {
      startNewCourseRace();
    });

    // Title buttons
    dom.btnShuffleCourse.addEventListener('click', () => {
      unlockAudio();
      shufflePreviewCourse();
    });
    dom.btnRulesTitle.addEventListener('click', openRulesModal);
    dom.btnStartRace.addEventListener('click', () => {
      startRaceOnCurrentCourse();
    });

    // Results buttons
    dom.btnNextRace.addEventListener('click', () => {
      startNewCourseRace();
    });
    dom.btnReplayCourse.addEventListener('click', () => {
      startRaceOnCurrentCourse();
    });
    dom.btnBackTitle.addEventListener('click', () => {
      returnToTitle();
    });

    // Inline career reset confirmation
    dom.btnResetCareer.addEventListener('click', openResetConfirm);
    dom.btnResetCancel.addEventListener('click', closeResetConfirm);
    dom.btnResetConfirm.addEventListener('click', () => {
      careerRecord = resetCareerRecord();
      syncCareerUI();
      closeResetConfirm();
      showToast('CAREER RECORD RESET', 'info', 2000);
    });

    // Rules modal close handlers
    dom.btnCloseRules.addEventListener('click', closeRulesModal);
    dom.btnRulesOk.addEventListener('click', closeRulesModal);
    dom.rulesModal.addEventListener('click', (e) => {
      if (e.target === dom.rulesModal) {
        closeRulesModal();
      }
    });

    bindRcControls();
  }

  // ========================================================================
  // Main Fixed-Timestep Game Loop
  // ========================================================================

  function stepSimulation(dt, playerInput) {
    simTime += dt;

    if (appMode === 'racing' && !rulesOpen) {
      updatePhysics(boats, course, playerInput, raceState, dt);
      updateRaceRules(raceState, boats, course, dt);
      processRaceEvents();

      // Safety check: if raceState reached 'finished' without emitting event
      if (raceState.phase === 'finished' && !careerRecordedForRace) {
        handleRaceFinish();
      }

      if (goBannerHideTimer > 0) {
        goBannerHideTimer -= dt;
        if (goBannerHideTimer <= 0) {
          hideCountdown();
        }
      }
    } else if (appMode === 'results' && !rulesOpen) {
      // Let boats gently coast on autopilot behind the results overlay
      updatePhysics(boats, course, { throttle: 0, steer: 0 }, raceState, dt);
    }
  }

  function frame(nowMs) {
    if (!lastFrameMs) lastFrameMs = nowMs;
    const rawDt = Math.max(0, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;
    const clampedDt = Math.min(rawDt, MAX_FRAME_DT);

    const playerInput = readPlayerInput();

    accumulator += clampedDt;
    while (accumulator >= FIXED_DT) {
      stepSimulation(FIXED_DT, playerInput);
      accumulator -= FIXED_DT;
    }

    // Update live engine audio
    const player = getPlayerBoat();
    const audioActive = appMode === 'racing' && !rulesOpen;
    if (player && audioActive) {
      const speedRatio = clamp(Math.abs(player.speed || 0) / (PHYSICS?.maxSpeed || 295), 0, 1.15);
      audio.updateEngine(
        speedRatio,
        player.throttle ?? playerInput.throttle,
        player.steer ?? playerInput.steer,
        player.wakeTurbulence || 0,
        true
      );
    } else {
      audio.updateEngine(0, 0, 0, 0, false);
    }

    // Sync HUD & RC widget during racing
    if (appMode === 'racing') {
      updateHudAndTransmitter(playerInput, clampedDt);
    }

    // Render live bay & boats
    const renderRaceState =
      appMode === 'title' && raceState ? { ...raceState, phase: 'menu' } : raceState;

    renderer.render(
      {
        course,
        boats,
        raceState: renderRaceState,
        time: simTime,
        cameraMode: appMode,
      },
      clampedDt
    );

    window.requestAnimationFrame(frame);
  }

  // ========================================================================
  // Initial Startup
  // ========================================================================

  renderer.resize();
  syncMuteUI();
  syncCareerUI();
  prepareCourse(generateCourse());
  setAppMode('title');
  bindEvents();

  window.requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
