# Prompt — generate a "How we used Moss" slide

Paste everything in the fenced block below into your slide-making AI (Claude, Gemini,
Gamma, Tome, etc.). It already contains the real facts about how Moss is used in
Pit Wall, so the output will be accurate and specific.

---

```
You are a designer + copywriter making ONE judge-facing slide for a hackathon demo.
The slide explains how our project uses Moss (a semantic-retrieval / vector-memory
service) and why it matters. Be concrete and punchy, not generic. No buzzword soup.

PROJECT (one line of context):
"Pit Wall" is an autonomous transfer-finance agent for a football club. It turns every
money event (transfer installments, agent fees, wages, short payments, fraud attempts)
into correct double-entry accounting, decides what to auto-post vs escalate to a human,
and learns from the humans it works with. The system of record is a Postgres/TigerData
database (golden.*). Moss is the agent's MEMORY layer on top of it.

HOW WE USE MOSS (ground the slide in these — they're real):
- Guiding principle: "Moss finds; Tiger is the truth." Moss retrieves candidates fast;
  every Moss doc id is a primary key back into the database, and the agent REFETCHES the
  real row from the DB before it acts or speaks. So retrieval can be fuzzy without the
  agent ever stating an unverified number.
- Five memory indexes: past DECISIONS, human PRECEDENTS (corrections), learned POLICIES,
  prior human ANSWERS (Q&A), and contract CLAUSES.
- Before the agent decides anything, it calls recall_memory: it pulls similar past
  decisions, the human precedent, and the governing policy to ORIENT itself — then code
  (a hard-check gate) makes the actual call. Memory informs perception, not the verdict.
- reuse_prior_answer: if a human already answered this exact question before, the agent
  cites that answer instead of asking again → less human toil over time.
- find_policy: when we "onboard" the agent, the policies it learns are indexed into Moss,
  so the live agent recalls its own policies from memory in every scenario.
- The "Final Whistle" catch: a bespoke contract clause whose type isn't in our structured
  rules is missed by the rigid cascade — but Moss surfaces it semantically, so the agent
  escalates instead of silently getting it wrong. Fuzzy memory beats brittle rules.
- Time travel: queries support as_of rewind (answer "as the agent knew it" on a past date),
  enforced at retrieval time.
- Safety: a dedicated least-privilege database role writes only retrieval telemetry;
  individual salaries are NEVER indexed into Moss (verified zero leakage).

PROVEN RESULTS (use as a metrics strip):
- Retrieval quality: top-1 90% / top-3 93% across 30 natural-language questions.
- A date filter lifts month-named queries from 75% to 100% correct.
- Latency: p50 0 ms / p95 1 ms — effectively free at demo scale.
- Memory lives in the DB, not the prompt → the agent self-learns (mines history into
  policies) and self-improves (human corrections become precedents, then policies).

THE SLIDE — produce exactly this:
1. Headline (≤7 words) that captures the idea, e.g. "Moss finds. Tiger is the truth."
2. One-line subtitle framing Moss as the agent's long-term memory.
3. Three short columns/bullets: (a) WHAT Moss stores (the 5 indexes), (b) HOW the agent
   uses it each turn (recall → refetch → code decides; reuse answers; find its policies),
   (c) WHY it's safe (id-back-to-DB refetch, least-privilege, salaries never indexed).
4. A metrics strip with the 4 proven numbers above.
5. One bold bottom-line sentence on IMPACT: because memory lives in the database, the
   agent gets better the more it's used — it stops re-asking, generalizes human
   corrections into policy, and never states a number it can't re-verify.
6. Speaker notes: 3 sentences a presenter can read in ~20 seconds.

STYLE: dark background, one lime/volt accent color, mono headers, lots of whitespace,
no clip-art. Think "developer keynote," not "corporate template." Keep total words on the
slide under ~90 so it reads in 10 seconds.
```

---

## If you'd rather present it live, the one-liner version

> "The agent's memory lives in the database, not the prompt. **Moss finds; the database is
> the truth** — it retrieves similar past decisions, human corrections, and the governing
> policy in ~1 ms, the agent re-fetches the real rows before it acts, and the hard-check
> gate decides. So it gets better the more we use it — it stops re-asking, turns human
> corrections into policy, and never states a number it can't re-verify. Salaries are never
> indexed. 90% top-1 retrieval across 30 questions."
