import { ACHERS } from './util.js';

// Spoken commentary for the Acher family, using the browser's own speech
// synthesiser — the only way to get a real voice without shipping an audio file.
//
// Three browser realities shape this module:
//  1. Autoplay policy: speech is refused until the user has interacted with the
//     page, so the announcement LATCHES rather than edge-triggers (see
//     `announced`) — otherwise a line queued while speech is still locked is
//     burned on a no-op and then sits in cooldown. The engine is also primed
//     with a silent utterance inside the gesture handler, which is what some
//     mobile builds need before they will speak at all.
//  2. Voice lists load asynchronously (and are empty on the first call in
//     Chrome), so the French voice is resolved lazily, and assigning a bad one
//     must never take the line down with it.
//  3. Speech can be silently unavailable (muted device, no installed voice,
//     locked-down browser). A subtitle is therefore always drawn, so the
//     commentary is visible even when it is inaudible.
//
// It announces EVERY Acher, not just the two supers: with 11 players on the
// side, gating it on the supers meant a line fired only when one of two
// specific players happened to be selected, which reads as "the sound is
// broken".

// "But" must be spelled correctly or the synthesiser reads it as a nonsense
// word. The drama comes from repetition and prosody, not from stretched vowels.
const BUT = 'But ! But ! Buuut !';

const GRAND = [
  'Mais quel joueur, c’est absolument phénoménal !',
  'Une technique venue d’une autre planète, mesdames et messieurs !',
  'Il est intouchable, IN-TOU-CHABLE ce soir !',
  'Le meilleur joueur de tous les temps, et je pèse mes mots !',
  'Quelle classe ! Quelle élégance ! C’est du grand art !',
  'Personne, absolument personne ne peut l’arrêter !',
  'Un génie ! Un monstre ! Un extraterrestre du ballon rond !',
  'Extraordinaire ! In-cro-yable ! Je n’ai jamais vu ça !',
  'Une vitesse absolument hallucinante, il vole littéralement !',
  'Il est dans un autre monde, dans une autre galaxie !',
  'Arrêtez tout, regardez ce joueur !',
  'C’est indécent ! C’est presque de la triche !',
];

const FAMILY = [
  'Quelle superbe joueuse !',
  'Toujours au bon endroit.',
  'Un sang-froid remarquable.',
  'La famille Acher au complet ce soir !',
  'Quelle vision du jeu !',
  'Un travail de l’ombre exemplaire.',
  'Elle ne lâche rien.',
  'Encore un Acher, évidemment !',
  'Quelle générosité dans l’effort !',
  'Le public apprécie.',
];

// A couple of personal lines each, so nobody sounds interchangeable.
const OWN = {
  10: ['LE MAGICIEN DE DRAGUIGNAN !', 'La foudre en personne, mesdames et messieurs !',
       'Il a le feu aux crampons, c’est un incendie !'],
  7: ['L’ARCHITECTE ! Le cerveau ! Le patron !',
      'Il voit le football trois secondes avant tout le monde !',
      'Un ordinateur dans la tête et de la soie dans les pieds !'],
  9: ['Quel sens du but !', 'Toujours dans les bons coups !'],
  2: ['Une défenseure impeccable.', 'Elle verrouille son couloir.'],
  3: ['Quelle vitesse sur le côté !', 'Impossible à déborder.'],
  4: ['Le patron de la défense.', 'Solide comme un roc.'],
  5: ['L’expérience à l’état pur.', 'Elle lit le jeu avant tout le monde.'],
  6: ['Quel volume de jeu !', 'Il est partout sur le terrain.'],
  8: ['Quelle qualité de passe !', 'Elle oriente le jeu à merveille.'],
  11: ['Quel dribble !', 'Elle fait la différence sur son aile.'],
};

const GOAL_GRAND = [
  BUT + ' Évidemment, c’est lui, qui d’autre !',
  BUT + ' Encore un chef-d’œuvre, rangez vos cahiers !',
  BUT + ' Imparable ! Le gardien peut aller se rhabiller !',
  BUT + ' Quelle frappe ! Le filet a failli céder !',
  BUT + ' Il ne rate JAMAIS ! Ja-mais !',
  BUT + ' Raoul Brulat est debout, tout Draguignan tremble !',
];
const GOAL_FAMILY = [
  BUT + ' Quelle joie dans les tribunes !',
  BUT + ' Et ça fait mouche, magnifique !',
  BUT + ' Superbe réalisation, quelle finition !',
  BUT + ' Le stade explose de joie !',
];

const DUO_LINE = 'Les frères Acher, quelle famille ! Deux dans la même équipe, c’est illégal !';

// Lines about the MATCH rather than a player, so the commentary has something
// to say between selections. Keyed to things the sim actually emits or that we
// can detect from state, never fired at random.
const AMBIENT = {
  turnover: [
    'Oh là là, quelle perte de balle !',
    'Manque de concentration total, c’est impardonnable à ce niveau !',
    'Mais qu’est-ce qu’il fait ! C’est catastrophique !',
    'Ballon rendu bêtement, le banc ne va pas apprécier !',
    'Alors ça, c’est du grand n’importe quoi !',
    'Cadeau ! Un cadeau à l’adversaire !',
  ],
  out: [
    'Ça sort ! Un manque de précision flagrant.',
    'En touche… c’était pourtant simple !',
    'Le ballon file en dehors du terrain, quel gâchis.',
  ],
  save: [
    'QUEL ARRÊT ! Le gardien sort le grand jeu !',
    'Arrêt réflexe absolument monumental !',
    'Il détourne ! Le stade retient son souffle !',
  ],
  crowd: [
    'L’ambiance en Dracénie est tout simplement incroyable ce soir !',
    'Écoutez ce public ! Raoul Brulat est en fusion !',
    'Quelle atmosphère ! On ne s’entend plus parler dans ce stade !',
    'Les tribunes poussent, elles portent cette équipe !',
    'Frissons dans tout le stade, mesdames et messieurs !',
    'La Dracénie est debout, c’est magnifique à voir !',
    'Quelle soirée à Draguignan ! Le Stade Raoul Brulat est plein à craquer !',
  ],
  kickoff: [
    'C’est parti ! Le coup d’envoi est donné au Stade Raoul Brulat !',
    'Et c’est reparti pour un festival !',
  ],
  dominance: [
    'C’est un récital ! Draguignan déroule complètement !',
    'On assiste à une démonstration, une véritable démonstration !',
    'Le score est déjà sévère, et ça continue !',
  ],
};

export function createCommentary({ match, rng }) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const state = { enabled: !!synth, muted: false, unlocked: false, lastError: null };

  let capture = false;
  try {
    const q = new URLSearchParams(location.search);
    capture = q.has('t') && q.get('live') !== '1';
  } catch (e) { /* ignore */ }

  // ---- subtitle -------------------------------------------------------------
  let bar = null, barT = 0;
  if (!capture && typeof document !== 'undefined') {
    const host = document.getElementById('hud') || document.body;
    const css = document.createElement('style');
    css.textContent = `
    .fc-sub{position:fixed;left:50%;bottom:5.2%;transform:translate(-50%,8px);
      max-width:min(760px,84vw);padding:9px 17px;border-radius:9px;
      background:rgba(9,12,18,.76);backdrop-filter:blur(10px);
      -webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.12);
      color:#eef3fb;font:600 15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
      letter-spacing:.005em;text-align:center;pointer-events:none;z-index:30;
      opacity:0;transition:opacity .22s ease,transform .22s ease;
      box-shadow:0 6px 26px rgba(0,0,0,.42)}
    .fc-sub.on{opacity:1;transform:translate(-50%,0)}
    .fc-sub b{color:#ffd76a;font-weight:800}
    .fc-sub i{font-style:normal;opacity:.5;font-size:12px;display:block;margin-top:3px}
    @media (max-height:460px){.fc-sub{font-size:13px;padding:7px 13px;bottom:4%}}`;
    document.head.appendChild(css);
    bar = document.createElement('div');
    bar.className = 'fc-sub';
    host.appendChild(bar);
  }
  function subtitle(who, line, note) {
    if (!bar) return;
    bar.innerHTML = `<b>${who}</b> — ${line}${note ? `<i>${note}</i>` : ''}`;
    bar.classList.add('on');
    barT = 3.4;
  }

  const rnd = () => (rng ? rng() : Math.random());
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];

  // Two casts: a measured play-by-play voice for the supers, and a second,
  // deliberately different one that just yells first names.
  //
  // Voice quality is bounded by what the OS has installed — the Web Speech API
  // only exposes system voices, and shipping a neural model would mean an asset
  // download this project does not do. What we CAN do is: prefer the platform's
  // best-known French voices, skip the novelty ones (Grandma, Rocko, Bubbles…)
  // for the commentator, ensure the two casts are never the same voice, and
  // vary rate/pitch slightly per line so it stops sounding metronomic.
  const NOVELTY = /grandma|grandpa|rocko|shelley|sandy|bubbles|bells|boing|jester|organ|trinoids|whisper|wobble|zarvox|superstar|bad news|good news/i;
  // ORDERED preference, not a regex over list order. A regex picked whichever
  // matching voice happened to come first, and on macOS that was
  // "Daniel (French (France))" — a voice Chrome lists but which never produces
  // audio. That is the whole reason the supers were silent while the family
  // (on a different voice) spoke fine.
  const MAIN_ORDER = ['Thomas', 'Jacques', 'Nicolas', 'Henri', 'Paul', 'Eddy'];
  const HYPE_ORDER = ['Marie', 'Amélie', 'Amelie', 'Audrey', 'Chantal', 'Virginie', 'Flo'];

  // Voices that were selected but produced no audio. Populated at runtime by
  // the watchdog in say(), so a dud is only ever heard once — on any platform,
  // not just the one this was written on.
  const badVoices = new Set();
  let speakGen = 0;   // see the watchdog in say()

  let voices = { main: null, hype: null, resolved: false };
  function resolveVoices() {
    if (voices.resolved) return voices;
    const all = (synth && synth.getVoices()) || [];
    if (!all.length) return voices;                 // try again next line
    const fr = all.filter((v) => /^fr[-_]/i.test(v.lang));
    const frFR = fr.filter((v) => /^fr[-_]FR/i.test(v.lang));
    const pool = (frFR.length ? frFR : fr).filter((v) => !badVoices.has(v.name));
    const clean = pool.filter((v) => !NOVELTY.test(v.name));
    const byOrder = (order, exclude) => {
      for (const want of order) {
        const hit = clean.find((v) => v !== exclude &&
          v.name.toLowerCase().startsWith(want.toLowerCase()));
        if (hit) return hit;
      }
      return clean.find((v) => v !== exclude) || pool.find((v) => v !== exclude) || null;
    };
    const main = byOrder(MAIN_ORDER, null);
    const hype = byOrder(HYPE_ORDER, main) || main;
    voices = { main, hype, resolved: !!main };
    return voices;
  }
  if (synth && synth.onvoiceschanged !== undefined) {
    synth.addEventListener('voiceschanged', () => { voices.resolved = false; resolveVoices(); });
  }

  const canSpeak = () => !!synth && !state.muted && !capture && state.unlocked;

  function say(text, opts = {}) {
    if (!canSpeak()) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = resolveVoices();
      // Assigning a non-SpeechSynthesisVoice throws; the lang hint alone is
      // enough, so never let the voice lookup take the whole line down.
      try {
        const chosen = opts.forceDefaultVoice ? null : (opts.hype ? v.hype : v.main);
        if (chosen) u.voice = chosen;
      } catch (e) { /* lang wins */ }
      u.lang = 'fr-FR';
      // Jitter: identical prosody on every line is most of what reads as
      // "robot". A few percent of variation costs nothing and helps a lot.
      const jitter = (rnd() - 0.5) * 0.06;
      u.rate = clampNum((opts.rate || 1.0) + jitter, 0.5, 2);
      u.pitch = clampNum((opts.pitch || 1.0) + jitter * 0.8, 0.4, 2);
      u.volume = 1;

      // Watchdog: a voice can be listed, accepted, and simply never speak.
      // If nothing starts, blacklist that voice, re-resolve, and retry once
      // with no explicit voice at all — the lang hint alone falls back to the
      // system default, which is the one thing always guaranteed to work.
      const chosenName = u.voice && u.voice.name;
      let started = false;
      // Generation token. The watchdog below must not blame the VOICE when the
      // real reason a line never started is that we cancelled it ourselves to
      // make way for a newer one — that misdiagnosis blacklisted perfectly good
      // voices one by one and eventually elected the dud we were avoiding.
      const myGen = ++speakGen;
      u.onstart = () => { started = true; };
      u.onerror = (e) => { state.lastError = (e && e.error) || 'error'; };
      if (!opts.isRetry && chosenName) {
        setTimeout(() => {
          if (started || !synth) return;
          if (myGen !== speakGen) return;      // superseded, not broken
          badVoices.add(chosenName);
          voices.resolved = false;
          state.lastError = 'no-audio:' + chosenName;
          try { synth.cancel(); } catch (e2) { /* ignore */ }
          say(text, { ...opts, isRetry: true, forceDefaultVoice: true });
        }, 1100);
      }

      if (synth.speaking || synth.pending) synth.cancel();
      synth.speak(u);
      quietFor = 0;
    } catch (e) { state.lastError = String(e); }
  }
  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Speech needs a user gesture. Prime the engine INSIDE the handler with a
  // silent utterance — several mobile builds stay mute otherwise.
  const unlock = () => {
    if (state.unlocked || !synth) return;
    state.unlocked = true;
    try {
      synth.resume();
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0; warm.lang = 'fr-FR';
      synth.speak(warm);
    } catch (e) { /* ignore */ }
  };
  if (typeof window !== 'undefined') {
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(ev, unlock, { passive: true });
    }
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM') return;
      state.muted = !state.muted;
      if (state.muted && synth) { try { synth.cancel(); } catch (err) { /* ignore */ } }
      subtitle('SON', state.muted ? 'coupé' : 'activé', 'touche M');
    });
  }

  const byNumber = new Map(ACHERS.map((a) => [a.number, a]));
  // Latched per PLAYER, not as a boolean. A boolean stayed true while any Acher
  // was selected, so switching from one family member to the next never
  // re-armed and only the first one ever spoke — which is exactly why the
  // family sounded broken.
  let announcedFor = null;
  let lastPoss = null;
  let quietFor = 0;
  let spotlightCd = 10;
  let now = 0;                 // seconds since start, for the spotlight
  const lastHeard = new Map(); // player number -> when last named
  let cooldown = 0;
  let pendingLine = null;
  let lastNumber = null;

  // Ambient colour: fired off real match events, on its own slower budget so it
  // never talks over a player announcement.
  let ambientCd = 12;
  function ambient(kind, minGap = 9) {
    if (ambientCd > 0 || cooldown > 0 || pendingLine) return;
    const pool = AMBIENT[kind];
    if (!pool) return;
    const line = pick(pool);
    say(line, { rate: 1.06, pitch: 1.0 });
    subtitle('HARBOURSIDE ARENA', line, state.muted ? 'son coupé — touche M' : null);
    ambientCd = minGap + rnd() * 7;
    cooldown = Math.max(cooldown, 3.5);
  }

  match.onEvent((type, data) => {
    if (type === 'out') { ambient('out', 11); return; }
    if (type === 'save') { ambient('save', 7); return; }
    if (type === 'kickoff') { ambient('kickoff', 14); return; }
    if (type !== 'goal' || !data) return;
    const n = data.scorer ? data.scorer.number : data.number;
    const rec = data.team === 'home' ? byNumber.get(n) : null;
    if (!rec) return;
    if (rec.superStar) {
      const line = pick(GOAL_GRAND);
      say(`${rec.spoken} ! ${line}`, { rate: 1.14, pitch: 1.06 });
      subtitle(rec.spoken, line);
    } else {
      const line = pick(GOAL_FAMILY);
      const shout = rec.shout || rec.first;
      say(`${shout} ! ${line}`, { hype: true, rate: 1.3, pitch: 1.45 });
      subtitle(shout, line);
    }
    cooldown = 6;
    lastNumber = n;
  });

  return {
    debug: () => ({ ...state, capture, cooldown, announcedFor, roster: ACHERS.length,
      voices: { main: voices.main && voices.main.name, hype: voices.hype && voices.hype.name } }),
    get muted() { return state.muted; },
    toggleMute() {
      state.muted = !state.muted;
      if (state.muted && synth) synth.cancel();
      subtitle('SON', state.muted ? 'coupé' : 'activé', 'touche M');
    },
    update(dt) {
      now += dt;
      if (cooldown > 0) cooldown -= dt;
      if (ambientCd > 0) ambientCd -= dt;
      if (barT > 0) { barT -= dt; if (barT <= 0 && bar) bar.classList.remove('on'); }

      // Turnovers are not an event the sim emits, so watch possession directly.
      // Only Draguignan losing it is worth shouting about.
      const poss = match.state && match.state.possession;
      if (poss && poss !== lastPoss) {
        if (lastPoss === 'home' && poss === 'away') ambient('turnover', 13);
        lastPoss = poss;
      }
      // Idle colour: if nothing has been said for a while, sell the atmosphere.
      // Rotating spotlight on its own clock. Gating it on a quiet spell meant
      // it never fired at all: with goals flowing there is never 13 s of
      // silence, so the four defenders stayed permanently unnamed.
      spotlightCd -= dt;
      if (spotlightCd <= 0 && cooldown <= 0 && !pendingLine && state.unlocked && !capture) {
        // Supers are excluded: they already own the microphone. The spotlight
        // exists for the players the ball never reaches.
        let pickRec = null, oldest = -1;
        for (const a of ACHERS) {
          if (a.superStar) continue;
          const age = now - (lastHeard.get(a.number) || -999);
          if (age > oldest) { oldest = age; pickRec = a; }
        }
        if (pickRec) {
          lastHeard.set(pickRec.number, now);
          const shout = pickRec.shout || pickRec.first;
          say(`${shout} !`, { hype: true, rate: 1.28, pitch: 1.44 });
          subtitle(shout, '!', state.muted ? 'son coupé — touche M' : null);
          cooldown = Math.max(cooldown, 4);
        }
        spotlightCd = 15 + rnd() * 9;
      }

      quietFor += dt;
      if (quietFor > 20) {
        const sc = match.state && match.state.score;
        const rout = sc && sc.home - sc.away >= 3;
        // Rotating spotlight. Measured selection time over 400 s: the two
        // supers take 47%, the front six take nearly all the rest, and the
        // centre-backs get under 1% — Anaé was never selected once. Gating
        // every mention on selection means half the family is simply never
        // named. So during a quiet spell, name whoever has waited longest.
        ambient(rout && rnd() < 0.5 ? 'dominance' : 'crowd', 16);
        quietFor = 0;
      }

      const cur = match.controlledPlayer;
      const rec = cur ? byNumber.get(cur.number) : null;
      // Only Achers on the home side; away shirts share these numbers.
      const isAcher = !!(rec && cur.team === 'home');
      if (!isAcher) { announcedFor = null; }
      else if (announcedFor !== rec.number && cooldown <= 0 && state.unlocked && !capture) {
        announcedFor = rec.number;
        if (rec.superStar) {
          // Full commentator treatment: name plus a line.
          const swapped = lastNumber !== null && lastNumber !== rec.number;
          const prev = lastNumber != null ? byNumber.get(lastNumber) : null;
          const own = OWN[rec.number];
          const line = (swapped && prev && prev.superStar && rnd() < 0.35)
            ? DUO_LINE
            : (own && rnd() < 0.5 ? pick(own) : pick(GRAND));
          pendingLine = { t: 0.12, who: rec.spoken, line, hype: false };
          cooldown = 7 + rnd() * 4;
        } else {
          // The rest of the family get their FIRST NAME only, shouted by a
          // different, more excitable voice.
          pendingLine = { t: 0.1, who: rec.shout || rec.first, line: null, hype: true };
          cooldown = 5 + rnd() * 3;
        }
        lastNumber = rec.number;
        lastHeard.set(rec.number, now);
      }

      if (pendingLine) {
        pendingLine.t -= dt;
        if (pendingLine.t <= 0) {
          const p = pendingLine;
          if (p.hype) {
            // First name only, hurled: high and fast, second voice.
            say(`${p.who} !`, { hype: true, rate: 1.32, pitch: 1.5 });
            subtitle(p.who, '!', state.muted ? 'son coupé — touche M' : null);
          } else {
            say(`${p.who} ! ${p.line}`, { rate: 1.04, pitch: 1.0 });
            subtitle(p.who, p.line, state.muted ? 'son coupé — touche M' : null);
          }
          pendingLine = null;
        }
      }
    },
  };
}
