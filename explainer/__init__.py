"""explainer — a reusable, data-agnostic AI explainer.

Plug in your own financial reports and transactions (any system, any schema):
you hand it a request of grounded facts + "build it live" canvas draws, and it
produces a validated narration plan that the LiveKit voice agent speaks and the
terminal canvas renders scene by scene.

Two guarantees, enforced in code:
  * never speaks a number a tool/source didn't return — every number in a spoken
    line must appear in that scene's facts or on its canvas;
  * the engine is pure (no DB, no network unless you pass a say-writer) so it drops
    into any backend.

Author scenes with `recipes`, feed them via a `providers.Provider`, finalize with
`engine.build_plan`.
"""

from .engine import build_plan, validate_scene  # noqa: F401
