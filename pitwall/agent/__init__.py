"""The Pit Wall agent — autonomous transfer finance.

The harness (model + tools + loop + context) proposes and explains; CODE decides.
Nothing auto-completes unless the hard-check gate passes to the cent. Low-confidence
work escalates to the right model-played human with the failing check named.

  read.py       read-only facts the agent gathers (golden.*)
  checks.py     the hard-check confidence gate — code decides, not the LLM
  detectors.py  per-scenario decision logic (reconcile, fraud, add-on, FX, …)
  humans.py     model-played controller / CFO / accountant — who sometimes say no
  policy.py     self-learning (mine history → draft policy) + lookup
  improve.py    self-improving (human correction → precedent → general policy)
  llm.py        Claude proposes + explains (deterministic mock when no key)
  run.py        onboarding + the processing loop
"""
