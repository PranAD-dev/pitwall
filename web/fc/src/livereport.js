// ---------------------------------------------------------------------------
// livereport.js — drives the finance-report billboard. Prefers the real LiveKit
// report agent (voice/agent.py over the lk.explain-* data channel); if LiveKit
// can't be reached (no worker, no creds, offline CDN) it falls back to the same
// grounded plan over HTTP (/api/explain/<wi>) so the billboard always plays.
// createLiveReport({reporter}) -> { start(subject), stop() }.
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function speakLine(text) {
  return new Promise((resolve) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text || ''));
      u.rate = 1.03;
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      u.onend = fin; u.onerror = fin;
      speechSynthesis.speak(u);
      setTimeout(fin, 12000);                    // safety if onend never fires
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
    for (let i = 0; i < scenes.length && running; i++) {
      reporter.showScene(scenes[i], i, scenes.length);
      await Promise.race([speakLine(scenes[i].say), wait(6500)]);   // pace to speech, cap per scene
      if (running) await wait(400);
    }
  }

  async function viaHttp(subject) {
    reporter.idle('building the grounded report…');
    const plan = await fetch('/api/explain/' + encodeURIComponent(subject)).then((r) => r.json());
    await playPlan(plan, 'replay · http');
  }

  async function viaLiveKit(subject, timeoutMs) {
    const tok = await fetch('/api/livekit/token?room=pitwall-report&identity=stadium').then((r) => r.json());
    if (!tok || tok.error || !tok.token) throw new Error('no-token');
    const LK = await import('livekit-client');           // bare specifier → importmap → CDN
    room = new LK.Room();
    await Promise.race([room.connect(tok.url, tok.token),
      wait(timeoutMs).then(() => { throw new Error('connect-timeout'); })]);
    reporter.idle('connected · asking the report agent…');
    const dec = new TextDecoder(), enc = new TextEncoder();
    let got = false;
    room.on(LK.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      let msg; try { msg = JSON.parse(dec.decode(payload)); } catch (e) { return; }
      if (topic === 'lk.explain-plan' && msg.plan) { got = true; reporter.setTitle(msg.plan.title || 'report'); reporter.setSource('live · livekit'); }
      else if (topic === 'lk.explain-scene' && msg.scene) { got = true; reporter.showScene(msg.scene, msg.index || 0, msg.total || 0); speakLine(msg.scene.say); }
      else if (topic === 'lk.explain-error') reporter.idle('agent error — ' + (msg.error || ''));
    });
    await room.localParticipant.publishData(
      enc.encode(JSON.stringify({ requestId: 'r-' + subject, subject })), { reliable: true, topic: 'lk.explain-request' });
    await wait(5000);
    if (!got) throw new Error('no-agent');               // worker silent → HTTP takes over
  }

  async function start(subject) {
    if (running) return;
    running = true;
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
  return { start, stop };
}
