// Procedural zero-dependency Web Audio engine for AquaRacers.
// Safe in headless/Node environments where AudioContext is unavailable.

function getAudioContextCtor() {
  if (typeof globalThis === 'undefined') return null;
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function createAudioEngine() {
  let ctx = null;
  let masterGain = null;
  let compressor = null;
  let noiseBuffer = null;

  // Continuous engine & ambient nodes
  let engineBus = null;
  let motorGain = null;
  let motorOsc1 = null;
  let motorOsc2 = null;
  let motorSubOsc = null;
  let motorFilter = null;

  let spraySource = null;
  let sprayFilter = null;
  let sprayGain = null;

  let surfSource = null;
  let surfFilter = null;
  let surfGain = null;
  let surfLfo = null;
  let surfLfoGain = null;

  let muted = false;
  let unlocked = false;
  let destroyed = false;
  let initialized = false;

  function createNoiseBuffer(audioCtx, seconds = 2.5) {
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * seconds));
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    // Light pink-ish filtered noise for natural ocean/water texture
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.950 * b2 + white * 0.048;
      data[i] = clamp((b0 + b1 + b2 + white * 0.18) * 1.4, -1, 1);
    }
    return buffer;
  }

  function initGraph() {
    if (initialized || destroyed) return false;
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) return false;

    try {
      ctx = new AudioCtx();
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 18;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.16;

      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0.0001 : 0.6;
      masterGain.connect(compressor);
      compressor.connect(ctx.destination);

      noiseBuffer = createNoiseBuffer(ctx, 2.5);

      // --- Ambient ocean surf ---
      surfSource = ctx.createBufferSource();
      surfSource.buffer = noiseBuffer;
      surfSource.loop = true;

      surfFilter = ctx.createBiquadFilter();
      surfFilter.type = 'lowpass';
      surfFilter.frequency.value = 440;
      surfFilter.Q.value = 0.6;

      surfGain = ctx.createGain();
      surfGain.gain.value = 0.045;

      surfLfo = ctx.createOscillator();
      surfLfo.type = 'sine';
      surfLfo.frequency.value = 0.15;
      surfLfoGain = ctx.createGain();
      surfLfoGain.gain.value = 0.018;
      surfLfo.connect(surfLfoGain);
      surfLfoGain.connect(surfGain.gain);

      surfSource.connect(surfFilter);
      surfFilter.connect(surfGain);
      surfGain.connect(masterGain);

      // --- RC Offshore Brushless / Outboard Motor ---
      engineBus = ctx.createGain();
      engineBus.gain.value = 0.0001;
      engineBus.connect(masterGain);

      motorFilter = ctx.createBiquadFilter();
      motorFilter.type = 'lowpass';
      motorFilter.frequency.value = 340;
      motorFilter.Q.value = 1.4;

      motorGain = ctx.createGain();
      motorGain.gain.value = 0.0001;

      motorOsc1 = ctx.createOscillator();
      motorOsc1.type = 'triangle';
      motorOsc1.frequency.value = 78;

      motorOsc2 = ctx.createOscillator();
      motorOsc2.type = 'sawtooth';
      motorOsc2.frequency.value = 156.6;

      const osc2Trim = ctx.createGain();
      osc2Trim.gain.value = 0.28;

      motorSubOsc = ctx.createOscillator();
      motorSubOsc.type = 'sine';
      motorSubOsc.frequency.value = 39;

      const subTrim = ctx.createGain();
      subTrim.gain.value = 0.35;

      motorOsc1.connect(motorFilter);
      motorOsc2.connect(osc2Trim);
      osc2Trim.connect(motorFilter);
      motorSubOsc.connect(subTrim);
      subTrim.connect(motorFilter);

      motorFilter.connect(motorGain);
      motorGain.connect(engineBus);

      // --- Water prop cavitation & cornering spray ---
      spraySource = ctx.createBufferSource();
      spraySource.buffer = noiseBuffer;
      spraySource.loop = true;

      sprayFilter = ctx.createBiquadFilter();
      sprayFilter.type = 'bandpass';
      sprayFilter.frequency.value = 900;
      sprayFilter.Q.value = 1.3;

      sprayGain = ctx.createGain();
      sprayGain.gain.value = 0.0001;

      spraySource.connect(sprayFilter);
      sprayFilter.connect(sprayGain);
      sprayGain.connect(engineBus);

      // Start continuous sources
      const now = ctx.currentTime;
      surfSource.start(now);
      surfLfo.start(now);
      motorOsc1.start(now);
      motorOsc2.start(now);
      motorSubOsc.start(now);
      spraySource.start(now);

      initialized = true;
      return true;
    } catch {
      ctx = null;
      initialized = false;
      return false;
    }
  }

  function unlock() {
    if (destroyed) return;
    if (!initialized && !initGraph()) return;
    if (!ctx) return;

    try {
      if (ctx.state === 'suspended') {
        const res = ctx.resume();
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
      unlocked = true;
    } catch {
      // Ignore unlock failures in restricted environments
    }
  }

  function canPlaySfx() {
    return !destroyed && !muted && initialized && ctx && ctx.state === 'running';
  }

  function setMuted(nextMuted) {
    muted = Boolean(nextMuted);
    if (masterGain && ctx && !destroyed) {
      try {
        const now = ctx.currentTime;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setTargetAtTime(muted ? 0.0001 : 0.6, now, 0.03);
      } catch {
        // Ignore scheduling errors
      }
    }
  }

  function isMuted() {
    return muted;
  }

  function updateEngine(speedRatio = 0, throttle = 0, steer = 0, wakeChop = 0, active = false) {
    if (destroyed || !initialized || !ctx) return;
    if (ctx.state !== 'running') return;

    try {
      const now = ctx.currentTime;
      const sr = clamp(Number.isFinite(speedRatio) ? speedRatio : 0, 0, 1.35);
      const thr = clamp(Number.isFinite(throttle) ? Math.abs(throttle) : 0, 0, 1);
      const st = clamp(Number.isFinite(steer) ? Math.abs(steer) : 0, 0, 1);
      const chop = clamp(Number.isFinite(wakeChop) ? wakeChop : 0, 0, 1);

      const targetBus = active && !muted ? 1.0 : 0.0001;
      engineBus.gain.setTargetAtTime(targetBus, now, active ? 0.08 : 0.16);

      if (!active) return;

      // Smooth RC electric/outboard pitch curve
      const baseFreq = 72 + sr * 175 + thr * 42 + chop * 10;
      motorOsc1.frequency.setTargetAtTime(baseFreq, now, 0.045);
      motorOsc2.frequency.setTargetAtTime(baseFreq * 2.007, now, 0.045);
      motorSubOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.05);

      const filterCutoff = 260 + sr * 820 + thr * 340;
      motorFilter.frequency.setTargetAtTime(filterCutoff, now, 0.05);

      const targetMotorGain = 0.045 + sr * 0.085 + thr * 0.055;
      motorGain.gain.setTargetAtTime(targetMotorGain, now, 0.05);

      // Spray/cavitation sound scales with hull speed, hard carving, and wake chop
      const sprayLevel = clamp(sr * 0.085 + st * sr * 0.095 + chop * (0.04 + sr * 0.08), 0.0001, 0.24);
      const sprayFreq = 700 + sr * 900 + st * 650 + chop * 250;
      sprayFilter.frequency.setTargetAtTime(sprayFreq, now, 0.05);
      sprayGain.gain.setTargetAtTime(sprayLevel, now, 0.055);
    } catch {
      // Never crash game loop on audio glitch
    }
  }

  function scheduleTone({
    freq,
    endFreq = null,
    type = 'triangle',
    startTime,
    duration,
    gain = 0.16,
    attack = 0.01,
    filterFreq = null,
  }) {
    if (!ctx || !masterGain) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    if (endFreq !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration);
    }

    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(gain, startTime + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    if (filterFreq) {
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = filterFreq;
      osc.connect(flt);
      flt.connect(env);
    } else {
      osc.connect(env);
    }

    env.connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.03);
  }

  function scheduleNoiseBurst({
    startTime,
    duration,
    gain = 0.14,
    startFreq = 1100,
    endFreq = 400,
    q = 1.2,
  }) {
    if (!ctx || !masterGain || !noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;

    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.Q.value = q;
    flt.frequency.setValueAtTime(startFreq, startTime);
    flt.frequency.exponentialRampToValueAtTime(Math.max(80, endFreq), startTime + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(gain, startTime + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    src.connect(flt);
    flt.connect(env);
    env.connect(masterGain);
    src.start(startTime, Math.random() * 0.8);
    src.stop(startTime + duration + 0.03);
  }

  function playCountdown(n = 3) {
    if (!canPlaySfx()) return;
    try {
      const now = ctx.currentTime;
      const base = n === 1 ? 587.33 : 493.88; // Slight anticipation pitch step on "1"
      scheduleTone({
        freq: base,
        type: 'triangle',
        startTime: now,
        duration: 0.22,
        gain: 0.18,
        attack: 0.008,
        filterFreq: 1800,
      });
      scheduleTone({
        freq: base * 1.004,
        type: 'sawtooth',
        startTime: now,
        duration: 0.2,
        gain: 0.06,
        attack: 0.01,
        filterFreq: 1400,
      });
    } catch {
      // Ignore
    }
  }

  function playGo() {
    if (!canPlaySfx()) return;
    try {
      const now = ctx.currentTime;
      // Marine dual-tone airhorn blast (bright brassy nautical chord)
      const freqs = [392.0, 493.88, 587.33, 783.99];
      freqs.forEach((f, idx) => {
        scheduleTone({
          freq: f,
          type: idx < 2 ? 'sawtooth' : 'triangle',
          startTime: now,
          duration: 0.62,
          gain: idx < 2 ? 0.085 : 0.11,
          attack: 0.015,
          filterFreq: 2100,
        });
      });
      scheduleNoiseBurst({
        startTime: now,
        duration: 0.16,
        gain: 0.04,
        startFreq: 1800,
        endFreq: 900,
        q: 1.8,
      });
    } catch {
      // Ignore
    }
  }

  function playLap(isFinal = false) {
    if (!canPlaySfx()) return;
    try {
      const now = ctx.currentTime;
      const notes = isFinal
        ? [523.25, 659.25, 783.99, 1046.5]
        : [523.25, 659.25, 783.99];
      const step = isFinal ? 0.075 : 0.085;
      notes.forEach((freq, i) => {
        const t = now + i * step;
        scheduleTone({
          freq,
          type: 'sine',
          startTime: t,
          duration: isFinal && i === notes.length - 1 ? 0.55 : 0.28,
          gain: 0.14,
          attack: 0.005,
        });
        scheduleTone({
          freq: freq * 2.0,
          type: 'triangle',
          startTime: t,
          duration: 0.16,
          gain: 0.045,
          attack: 0.004,
        });
      });
    } catch {
      // Ignore
    }
  }

  function playBuoyHit() {
    if (!canPlaySfx()) return;
    try {
      const now = ctx.currentTime;
      // Hollow floating buoy thump-clunk
      scheduleTone({
        freq: 225,
        endFreq: 88,
        type: 'triangle',
        startTime: now,
        duration: 0.16,
        gain: 0.24,
        attack: 0.004,
        filterFreq: 900,
      });
      scheduleTone({
        freq: 380,
        endFreq: 160,
        type: 'sine',
        startTime: now,
        duration: 0.09,
        gain: 0.12,
        attack: 0.003,
      });
      // Water splash burst
      scheduleNoiseBurst({
        startTime: now + 0.01,
        duration: 0.24,
        gain: 0.15,
        startFreq: 1250,
        endFreq: 380,
        q: 1.0,
      });
    } catch {
      // Ignore
    }
  }

  function playPenalty() {
    if (!canPlaySfx()) return;
    try {
      const now = ctx.currentTime;
      // Two-pulse nautical warning buzzer
      scheduleTone({
        freq: 310,
        endFreq: 285,
        type: 'sawtooth',
        startTime: now,
        duration: 0.14,
        gain: 0.11,
        attack: 0.008,
        filterFreq: 950,
      });
      scheduleTone({
        freq: 235,
        endFreq: 215,
        type: 'sawtooth',
        startTime: now + 0.16,
        duration: 0.24,
        gain: 0.12,
        attack: 0.008,
        filterFreq: 850,
      });
    } catch {
      // Ignore
    }
  }

  function playFinish(rank = 1) {
    if (!canPlaySfx()) return;
    try {
      const now = ctx.currentTime;
      if (rank === 1) {
        // Celebratory 1st-place victory fanfare
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => {
          const t = now + i * 0.095;
          scheduleTone({
            freq: f,
            type: 'triangle',
            startTime: t,
            duration: i === notes.length - 1 ? 0.72 : 0.24,
            gain: 0.16,
            attack: 0.008,
            filterFreq: 2600,
          });
          if (i === notes.length - 1) {
            scheduleTone({
              freq: 659.25,
              type: 'sine',
              startTime: t,
              duration: 0.7,
              gain: 0.09,
              attack: 0.01,
            });
            scheduleTone({
              freq: 783.99,
              type: 'sine',
              startTime: t,
              duration: 0.7,
              gain: 0.09,
              attack: 0.01,
            });
          }
        });
      } else if (rank <= 3) {
        // Podium cadence
        const notes = [392.0, 493.88, 587.33, 783.99];
        notes.forEach((f, i) => {
          scheduleTone({
            freq: f,
            type: 'triangle',
            startTime: now + i * 0.09,
            duration: i === notes.length - 1 ? 0.52 : 0.22,
            gain: 0.13,
            attack: 0.008,
            filterFreq: 2200,
          });
        });
      } else {
        // Classy finish chime
        const notes = [392.0, 440.0, 392.0];
        notes.forEach((f, i) => {
          scheduleTone({
            freq: f,
            type: 'sine',
            startTime: now + i * 0.11,
            duration: i === notes.length - 1 ? 0.42 : 0.2,
            gain: 0.12,
            attack: 0.01,
          });
        });
      }
    } catch {
      // Ignore
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const sources = [surfSource, surfLfo, motorOsc1, motorOsc2, motorSubOsc, spraySource];
    for (const src of sources) {
      if (src) {
        try {
          src.stop();
        } catch {
          // Ignore already stopped
        }
      }
    }
    if (ctx) {
      try {
        const res = ctx.close();
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      } catch {
        // Ignore close errors
      }
    }
    ctx = null;
    initialized = false;
    unlocked = false;
  }

  return {
    unlock,
    setMuted,
    isMuted,
    updateEngine,
    playCountdown,
    playGo,
    playLap,
    playBuoyHit,
    playPenalty,
    playFinish,
    destroy,
  };
}
