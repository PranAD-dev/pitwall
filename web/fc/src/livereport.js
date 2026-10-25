// ---------------------------------------------------------------------------
// livereport.js — drives the finance-report billboard. Prefers the real LiveKit
// report agent (voice/agent.py over the lk.explain-* data channel); if LiveKit
// can't be reached (no worker, no creds, offline CDN) it falls back to the same
// grounded plan over HTTP (/api/explain/<wi>) so the billboard always plays.
// createLiveReport({reporter}) -> { start(subject), stop() }.
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hasTTS = typeof speechSynthesis !== 'undefined';

// Browsers gate speech synthesis behind a user gesture and load voices lazily.
// prime() must be called from a click/tap; ensureVoices waits for the list.
export function primeSpeech() {
  if (!hasTTS) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}
}
function ensureVoices() {
  return new Promise((resolve) => {
    if (!hasTTS) return resolve();
    if ((speechSynthesis.getVoices() || []).length) return resolve();
    let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
    speechSynthesis.onvoiceschanged = fin;
    setTimeout(fin, 1200);
  });
}
function pickVoice() {
  if (!hasTTS) return null;
  const vs = speechSynthesis.getVoices() || [];
  return vs.find((v) => /^en/i.test(v.lang) && /Google|Samantha|Daniel|Karen|Serena/i.test(v.name))
    || vs.find((v) => /^en-US/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || vs[0] || null;
}
function speakLine(text) {
  return new Promise((resolve) => {
    const t = String(text || '').trim();
    if (!hasTTS || !t) return resolve();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
      const v = pickVoice(); if (v) u.voice = v;
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      u.onend = fin; u.onerror = fin;
      speechSynthesis.speak(u);
      setTimeout(fin, Math.max(6000, t.length * 95));   // watchdog if onend never fires
    } catch (e) { resolve(); }
  });
}

export function createLiveReport({ reporter }) {
  let running = false, room = null;

  async function playPlan(plan, source) {
    reporter.setTitle(plan.title || 'finance report');
    reporter.setSource(source);
    const scenes = plan.scenes || [];
    if (!scenes.length) { reporter.idle(plan.error ? ('report unavailable — ' + plan.error) : 'no scenes'); return; }
    await ensureVoices();
    for (let i = 0; i < scenes.length && running; i++) {
      const say = scenes[i].say || '';
      reporter.showScene(scenes[i], i, scenes.length);
      // readable minimum per scene, extended to the spoken length — never races ahead
      const words = say.split(/\s+/).filter(Boolean).length;
      const dwell = Math.max(4500, words * 380 + 1200);
      await Promise.all([Promise.race([speakLine(say), wait(16000)]), wait(dwell)]);
      if (running) await wait(600);
    }
  }

  async function viaHttp(subject) {
    reporter.idle('building the grounded report…');
    const plan = await fetch('/api/explain/' + encodeURIComponent(subject)).then((r) => r.json());
    await playPlan(plan, 'replay · http');
  }

  // The reports desk: a financial report read straight off the DB + forecast, narrated,
  // and handed to the download button. This is what the terminal offloads here.
  async function startFinancial() {
    if (running) return;
    running = true;
    primeSpeech();
    reporter.showScene(null); reporter.setSource('reports desk…');
    reporter.idle('reading the database + forecast…');
    let rep;
    try { rep = await fetch('/api/finreport').then((r) => r.json()); }
    catch (e) { reporter.idle('report backend offline — run `make fc`'); running = false; return; }
    if (!running) return;
    if (window.__pwReportReady) window.__pwReportReady(rep);     // enable the download button
    reporter.setTitle(rep.title || 'financial report');
    reporter.setSource('financial report · ' + (rep.as_of || ''));
    await ensureVoices();
    const secs = rep.sections || [];
    for (let i = 0; i < secs.length && running; i++) {
      const say = secs[i].say || '';
      reporter.showScene(secs[i], i, secs.length, { build: true });   // Opennote-style build
      const dwell = Math.max(5500, say.split(/\s+/).filter(Boolean).length * 380 + 1800);
      await Promise.all([Promise.race([speakLine(say), wait(16000)]), wait(dwell)]);
      if (running) await wait(700);
    }
  }

  async function viaLiveKit(subject, timeoutMs) {
    const tok = await fetch('/api/livekit/token?room=pitwall-report&identity=stadium').then((r) => r.json());
    if (!tok || tok.error || !tok.token) throw new Error('no-token');
    const LK = await import('livekit-client');           // bare specifier → importmap → CDN
    room = new LK.Room();
    await Promise.race([room.connect(tok.url, tok.token),
      wait(timeoutMs).then(() => { throw new Error('connect-timeout'); })]);
    reporter.idle('connected · asking the report agent…');
    await ensureVoices();
    const dec = new TextDecoder(), enc = new TextEncoder();
    let got = false, busy = Promise.resolve();
    room.on(LK.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      let msg; try { msg = JSON.parse(dec.decode(payload)); } catch (e) { return; }
      if (topic === 'lk.explain-plan' && msg.plan) { got = true; reporter.setTitle(msg.plan.title || 'report'); reporter.setSource('live · livekit'); }
      else if (topic === 'lk.explain-scene' && msg.scene) {
        got = true;
        // serialize scenes so speech doesn't overlap even if the agent streams fast
        busy = busy.then(async () => {
          if (!running) return;
          reporter.showScene(msg.scene, msg.index || 0, msg.total || 0);
          const say = msg.scene.say || '';
          const dwell = Math.max(4500, say.split(/\s+/).filter(Boolean).length * 380 + 1200);
          await Promise.all([Promise.race([speakLine(say), wait(16000)]), wait(dwell)]);
        });
      } else if (topic === 'lk.explain-error') reporter.idle('agent error — ' + (msg.error || ''));
    });
    await room.localParticipant.publishData(
      enc.encode(JSON.stringify({ requestId: 'r-' + subject, subject })), { reliable: true, topic: 'lk.explain-request' });
    await wait(5000);
    if (!got) throw new Error('no-agent');               // worker silent → HTTP takes over
  }

  async function start(subject) {
    if (running) return;
    running = true;
    primeSpeech();                                       // unlock audio on this gesture
    const wi = subject || 'WI-5602';
    reporter.showScene(null); reporter.setSource('connecting…');
    try {
      await viaLiveKit(wi, 3500);
    } catch (e) {
      if (room) { try { await room.disconnect(); } catch (_) {} room = null; }
      if (running) { try { await viaHttp(wi); } catch (_) { reporter.idle('report backend offline — run `make fc`'); } }
    }
  }
  function stop() {
    running = false;
    try { speechSynthesis.cancel(); } catch (e) {}
    if (room) { try { room.disconnect(); } catch (e) {} room = null; }
  }
  return { start, startFinancial, stop };
}
