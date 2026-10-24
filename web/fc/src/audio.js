// Stadium atmosphere, synthesised live with Web Audio. No audio files, no
// network, nothing copyrighted — same rule as the rest of the project.
//
// Layers:
//   brouhaha  four decorrelated noise bands with independent slow swells,
//             plus sparse single voices (whistles, shouts) cutting through
//   cicadas   Provence at night: narrow noise bands amplitude-modulated at
//             40-70 Hz, thinning out as the crowd lifts. Every CHORUS_EVERY
//             seconds (10 min default, ?cicada= to tune) a whole hillside of
//             them goes up together and dies away.
//   chant     rare terrace pattern, only once the crowd is genuinely up
//   roar      swell on a goal
//   anthem    a short ORIGINAL entrance fanfare at kickoff
//
// Everything is scheduled ahead of time on the AudioContext clock rather than
// from requestAnimationFrame, because rAF jitter is audible as unsteady rhythm.

const MASTER = 0.5;

export function createAudio({ match, rng }) {
  const noop = { update() {}, toggleMute() {}, anthem() {}, get muted() { return true; }, debug: () => ({}) };
  if (typeof window === 'undefined') return noop;

  let capture = false;
  try {
    const q = new URLSearchParams(location.search);
    capture = q.has('t') && q.get('live') !== '1';
  } catch (e) { /* ignore */ }
  if (capture) return noop;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return noop;

  // Seconds between cicada choruses. Ten minutes by default; override with
  // ?cicada=30 to hear one without waiting, or ?cicada=0 to switch them off.
  let CHORUS_EVERY = 600;
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('cicada')) CHORUS_EVERY = Math.max(0, parseFloat(q.get('cicada')) || 0);
  } catch (e) { /* ignore */ }

  const rnd = () => (rng ? rng() : Math.random());

  let ctx = null, master = null, crowdGain = null, crowdFilter = null;
  let noiseBuf = null;
  let started = false, muted = false;
  let cicadaBus = null, nextCicada = 0, nextShout = 0;
  let nextChorus = 0, chorusUntil = 0;
  const crowdBands = [];
  let excite = 0.15, exciteTarget = 0.15;
  let duck = 1;   // ambience ducking while the commentator speaks
  let nextChant = 0, chantOn = false;

  function makeNoise() {
    const len = Math.floor(ctx.sampleRate * 2.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Pink-ish noise: cheap one-pole smoothing of white noise. Pure white is
    // hissy and reads as radio static rather than a crowd.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      last = (last + 0.045 * w) / 1.045;
      d[i] = last * 3.2;
    }
    return buf;
  }

  function start() {
    if (started) return;
    started = true;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(ctx.destination);

    noiseBuf = makeNoise();

    // --- crowd brouhaha ---------------------------------------------------
    // A stadium is not one hiss. It is a low body of thousands of chests, a
    // midrange babble of voices, and a thin top of movement — each drifting
    // independently. One filtered noise source reads as radio static; three
    // decorrelated bands with slow independent swells read as a crowd.
    crowdGain = ctx.createGain();
    crowdGain.gain.value = 0.0;
    crowdGain.connect(master);

    const BANDS = [
      { f: 180,  q: 0.7, g: 0.85, rate: 0.9,  lfo: 0.055 },  // body
      { f: 520,  q: 0.6, g: 1.0,  rate: 1.0,  lfo: 0.083 },  // babble
      { f: 1250, q: 0.8, g: 0.42, rate: 1.13, lfo: 0.121 },  // movement
      { f: 3200, q: 1.2, g: 0.12, rate: 0.77, lfo: 0.047 },  // air
    ];
    crowdFilter = null;
    for (const b of BANDS) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      src.playbackRate.value = b.rate;      // decorrelate the shared buffer
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = b.f; f.Q.value = b.q;
      const g = ctx.createGain();
      g.gain.value = b.g;
      // Slow independent swell: this is what stops it sounding like a machine.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = b.lfo;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = b.g * 0.42;
      lfo.connect(lfoAmt); lfoAmt.connect(g.gain);
      lfo.start();
      src.connect(f); f.connect(g); g.connect(crowdGain);
      src.start(0, rnd() * 2);
      if (b.f === 520) crowdFilter = f;      // the band we sweep with excitement
      crowdBands.push({ filter: f, base: b.f });
    }

    // Sparse single voices cutting through: a whistle, a shout, a laugh. Real
    // brouhaha has transients; a steady bed alone still sounds synthetic.
    nextShout = ctx.currentTime + 2 + rnd() * 4;

    // --- cicadas ------------------------------------------------------------
    // Draguignan is in Provence, so the night has cicadas. A cicada is a narrow
    // noise band amplitude-modulated at 40-70 Hz — the buzz IS the modulation.
    cicadaBus = ctx.createGain();
    cicadaBus.gain.value = 0.0;
    cicadaBus.connect(master);
    nextCicada = ctx.currentTime + 1.5;
    nextChorus = ctx.currentTime + CHORUS_EVERY;

    nextChant = ctx.currentTime + 6;
  }

  // ---- one-shot voices ------------------------------------------------------
  function kick(t, gain = 0.9) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.14);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.30);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.32);
  }

  function clap(t, gain = 0.5) {
    // Massed hands: a short noise burst, band-limited, with a tiny spread of
    // three grains so it reads as a crowd rather than one pair of hands.
    for (let i = 0; i < 3; i++) {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      s.playbackRate.value = 1 + i * 0.06;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1500 + i * 320; f.Q.value = 1.1;
      const g = ctx.createGain();
      const t0 = t + i * 0.011;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain * (1 - i * 0.22), t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.13);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0, rnd() * 1.5); s.stop(t0 + 0.15);
    }
  }

  // Massed "oh" — detuned saw stack through a formant-ish filter.
  function voiceChord(t, freq, dur, gain = 0.16) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.09);
    g.gain.setValueAtTime(gain, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 950; f.Q.value = 0.8;
    g.connect(f); f.connect(master);
    for (const cents of [-9, -3, 4, 11]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq * Math.pow(2, cents / 1200);
      o.connect(g);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }

  function brass(t, freq, dur, gain = 0.2) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.045);
    g.gain.setValueAtTime(gain * 0.85, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(2600, t + 0.08);
    f.frequency.linearRampToValueAtTime(1400, t + dur);
    g.connect(f); f.connect(master);
    for (const [mul, det] of [[1, -6], [1, 7], [2, 0]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq * mul * Math.pow(2, det / 1200);
      const og = ctx.createGain();
      og.gain.value = mul === 2 ? 0.35 : 1;
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }

  // One cicada: a narrow noise band whose amplitude is modulated at 40-70 Hz.
  // That modulation IS the rasp — filtered noise alone just sounds like wind.
  function cicada(t, o = {}) {
    const dur = o.dur !== undefined ? o.dur : 3.5 + rnd() * 7;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    src.playbackRate.value = 0.8 + rnd() * 0.5;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = o.band !== undefined ? o.band : 4200 + rnd() * 2200;
    band.Q.value = 6 + rnd() * 6;

    const am = ctx.createGain();          // modulated by the buzz oscillator
    am.gain.value = 0.45;
    const buzz = ctx.createOscillator();
    buzz.type = 'sawtooth';
    const rate = o.rate !== undefined ? o.rate : 42 + rnd() * 28;
    buzz.frequency.setValueAtTime(rate * 0.85, t);
    buzz.frequency.linearRampToValueAtTime(rate, t + 1.2);   // winds up
    buzz.frequency.setValueAtTime(rate, t + dur - 1.0);
    buzz.frequency.linearRampToValueAtTime(rate * 0.8, t + dur);
    const buzzAmt = ctx.createGain();
    buzzAmt.gain.value = 0.5;
    buzz.connect(buzzAmt); buzzAmt.connect(am.gain);

    const env = ctx.createGain();
    const peak = o.peak !== undefined ? o.peak : 0.055 + rnd() * 0.05;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.9 + rnd());
    env.gain.setValueAtTime(peak, t + dur - 1.1);
    env.gain.linearRampToValueAtTime(0, t + dur);

    src.connect(band); band.connect(am); am.connect(env); env.connect(cicadaBus);
    buzz.start(t); buzz.stop(t + dur + 0.05);
    src.start(t, rnd() * 2); src.stop(t + dur + 0.05);
  }

  // The chorus: real cicadas do not sing evenly, they set each other off and a
  // whole hillside goes up at once. Many overlapping singers, staggered so the
  // wall builds rather than switching on, held, then dying away raggedly.
  function cicadaChorus(t0) {
    const n = 16 + Math.floor(rnd() * 10);
    const build = 2.6;
    for (let i = 0; i < n; i++) {
      // Staggered entries, weighted early so it swells instead of fading in.
      const start = t0 + Math.pow(rnd(), 1.7) * build;
      cicada(start, {
        dur: 7 + rnd() * 6,
        peak: 0.10 + rnd() * 0.07,
        band: 3900 + rnd() * 2600,
        rate: 44 + rnd() * 26,
      });
    }
    // Lift the whole cicada bus for the duration so the chorus reads over the
    // crowd instead of being buried under it.
    // Note the chorus writes the bus level directly, so update() stops driving
    // it until chorusUntil — otherwise the two would fight each other. Ducking
    // resumes with it.
    const g = cicadaBus.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(g.value, t0);
    g.linearRampToValueAtTime(4.2, t0 + build);
    g.setValueAtTime(4.2, t0 + 9);
    g.linearRampToValueAtTime(2.6, t0 + 15);
    return t0 + 15;
  }

  // A single voice cutting out of the babble: whistle, shout or short laugh.
  function shout(t) {
    const kind = rnd();
    if (kind < 0.4) {                       // whistle
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      const f0 = 1700 + rnd() * 1100;
      o.frequency.setValueAtTime(f0 * 0.92, t);
      o.frequency.linearRampToValueAtTime(f0, t + 0.06);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035 + rnd() * 0.03, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.25 + rnd() * 0.3);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.7);
    } else {                                // shout / "oh"
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf; s.playbackRate.value = 0.7 + rnd() * 0.7;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(500 + rnd() * 400, t);
      f.frequency.linearRampToValueAtTime(320 + rnd() * 250, t + 0.35);
      f.Q.value = 2.5;
      const g = ctx.createGain();
      const dur = 0.25 + rnd() * 0.4;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05 + rnd() * 0.05, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t, rnd() * 1.5); s.stop(t + dur + 0.05);
    }
  }

  // ---- patterns -------------------------------------------------------------
  // A terrace chant: four-on-the-floor drum, claps on the off-beats, and a
  // rising two-note "oh oh" over the top. Original, generic, no melody quoted.
  function scheduleChant(t0) {
    const beat = 0.5;                       // 120 bpm
    const bars = 4;
    for (let b = 0; b < bars; b++) {
      for (let i = 0; i < 4; i++) {
        const t = t0 + (b * 4 + i) * beat;
        kick(t, i === 0 ? 0.5 : 0.32);
        if (i % 2 === 1) clap(t, 0.3);
      }
      const base = t0 + b * 4 * beat;
      voiceChord(base, 146.83, 0.9, 0.09);          // D3
      voiceChord(base + beat * 2, 174.61, 0.9, 0.09); // F3
    }
    return t0 + bars * 4 * beat;
  }

  function roar(t) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.5;
    f.frequency.setValueAtTime(400, t);
    f.frequency.linearRampToValueAtTime(1500, t + 0.7);
    f.frequency.linearRampToValueAtTime(700, t + 4.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.02, t);
    g.gain.linearRampToValueAtTime(0.62, t + 0.5);
    g.gain.setValueAtTime(0.62, t + 2.2);
    g.gain.exponentialRampToValueAtTime(0.001, t + 5.2);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t + 5.4);
    // whistles on top
    for (let i = 0; i < 7; i++) {
      const o = ctx.createOscillator(), og = ctx.createGain();
      const ts = t + 0.15 + rnd() * 2.4;
      o.type = 'sine';
      o.frequency.setValueAtTime(1900 + rnd() * 900, ts);
      og.gain.setValueAtTime(0, ts);
      og.gain.linearRampToValueAtTime(0.05, ts + 0.03);
      og.gain.exponentialRampToValueAtTime(0.0008, ts + 0.4);
      o.connect(og); og.connect(master);
      o.start(ts); o.stop(ts + 0.45);
    }
  }

  // Original entrance fanfare — a rising modal figure over a drum, written to
  // feel like walk-out music without quoting any existing song.
  function anthem() {
    if (!started || muted) return;
    const t0 = ctx.currentTime + 0.15;
    const beat = 0.44;
    const D = 146.83, F = 174.61, G = 196.0, A = 220.0, C = 261.63, D4 = 293.66;
    const line = [
      [D, 1], [D, 0.5], [F, 0.5], [G, 1], [A, 1],
      [A, 0.5], [C, 0.5], [D4, 1.5], [A, 0.5], [G, 2],
    ];
    let t = t0;
    for (const [f, len] of line) {
      brass(t, f, len * beat * 0.95, 0.19);
      t += len * beat;
    }
    for (let i = 0; i < 20; i++) {
      kick(t0 + i * beat, i % 4 === 0 ? 0.85 : 0.5);
      if (i % 2 === 1) clap(t0 + i * beat, 0.4);
    }
    // crowd lifts under the fanfare
    if (crowdGain) {
      const g = crowdGain.gain;
      g.cancelScheduledValues(t0);
      g.setValueAtTime(g.value, t0);
      g.linearRampToValueAtTime(0.5, t0 + 0.6);
    }
  }

  // ---- wiring ---------------------------------------------------------------
  const unlock = () => {
    if (started) return;
    start();
    if (ctx.state === 'suspended') ctx.resume();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, unlock, { passive: true });
  }
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM') return;
    muted = !muted;
    if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ctx.currentTime, 0.05);
  });

  match.onEvent((type) => {
    if (!started || muted) return;
    if (type === 'goal') { roar(ctx.currentTime + 0.05); nextChant = ctx.currentTime + 7; }
    else if (type === 'kickoff') anthem();
    else if (type === 'save') clap(ctx.currentTime + 0.02, 0.65);
  });

  return {
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ctx.currentTime, 0.05);
    },
    anthem,
    chorus: () => { if (started && !muted) chorusUntil = cicadaChorus(ctx.currentTime + 0.1); },
    debug: () => ({ started, muted, state: ctx && ctx.state, excite: +excite.toFixed(2),
      chorusEvery: CHORUS_EVERY,
      nextChorusIn: started ? +(nextChorus - ctx.currentTime).toFixed(1) : null,
      chorusActive: started ? ctx.currentTime < chorusUntil : false }),
    update(dt, excitement) {
      if (!started || !ctx) return;
      exciteTarget = Math.max(0, Math.min(1, excitement || 0));
      excite += (exciteTarget - excite) * Math.min(1, dt * 1.6);
      const t = ctx.currentTime;
      // Speech synthesis plays outside this AudioContext, so nothing mixes it
      // for us: if the bed is loud enough to be caricatural it will bury the
      // commentary unless we duck it ourselves.
      let speaking = false;
      try { speaking = !!(window.speechSynthesis && window.speechSynthesis.speaking); } catch (e) { /* ignore */ }
      duck += ((speaking ? 0.3 : 1) - duck) * Math.min(1, dt * (speaking ? 8 : 2.2));
      // Level and brightness both rise with the match: a lifted crowd is louder
      // AND higher-pitched, not just louder.
      crowdGain.gain.setTargetAtTime((0.05 + excite * 0.22) * duck, t, 0.25);
      if (crowdFilter) crowdFilter.frequency.setTargetAtTime(520 + excite * 700, t, 0.4);

      // CARICATURE MIX: this is Provence in August, so the cicadas ARE the
      // soundtrack and the stadium is behind them. They still thin out a little
      // when the crowd erupts, but they never get out of the way.
      // Never stack a chorus on top of one still running: harmless at the
      // 10-minute default, but a short ?cicada= interval would otherwise keep
      // re-triggering and the hillside would never fall silent.
      if (CHORUS_EVERY > 0 && t > nextChorus && t > chorusUntil) {
        chorusUntil = cicadaChorus(t + 0.2);
        nextChorus = t + CHORUS_EVERY;
      }
      // The chorus owns the bus while it runs; ambient level resumes after.
      if (t > chorusUntil) cicadaBus.gain.setTargetAtTime((2.6 - excite * 0.7) * duck, t, 1.2);
      if (t > nextCicada && t > chorusUntil) {
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) cicada(t + rnd() * 1.5);
        nextCicada = t + 0.5 + rnd() * 1.4 + excite * 1.2;
      }

      // Individual voices out of the babble, more often when excited.
      if (t > nextShout) {
        shout(t + rnd() * 0.3);
        nextShout = t + (1.6 + rnd() * 4.5) * (1 - excite * 0.55);
      }

      // The chant is now rare and only when the crowd is genuinely up — a drum
      // pattern looping over a quiet match is what made this sound like a toy.
      if (!chantOn && t > nextChant && excite > 0.42) {
        chantOn = true;
        const end = scheduleChant(t + 0.1);
        nextChant = end + 22 + rnd() * 25;
        setTimeout(() => { chantOn = false; }, (end - t) * 1000);
      } else if (t > nextChant && excite <= 0.42) {
        nextChant = t + 6;                 // re-check soon, don't fire
      }
    },
  };
}
