# explainer — a reusable AI explainer you plug data into

Turn **financial reports and transactions from any system** into short, narrated
"build it live" explanations: a voice (LiveKit + Cartesia) speaks one grounded
sentence per scene while a black terminal canvas draws the table / journal entry /
reconciliation / comparison it's talking about. Decoupled from any schema — Pit
Wall's football data is just one provider.

Two guarantees, enforced in code (`engine.validate_scene`):
- **never speaks a number the source didn't return** — every number in a spoken line
  must appear in that scene's `facts` or on its canvas `draw`;
- the engine is **pure** (no DB/network unless you pass a say-writer), so it drops
  into any backend.

## The contract — an "explain-request"
Plain JSON any system can emit:
```jsonc
{
  "subject_id": "acme-close-2026-03",
  "title": "Acme Corp — March close, reviewed",
  "as_of": null,
  "scenes": [
    {
      "say": "In March, revenue was $4,820,000 and net income $610,000.",
      "ui": {"focus": "P&L — March", "panel": "canvas", "highlight": "table"},
      "facts": [{"key": "revenue", "value": "$4,820,000", "source": "report"},
                {"key": "net_income", "value": "$610,000", "source": "report"}],
      "draw": {"type": "table", "title": "P&L — March",
               "columns": ["Line", "Amount"],
               "rows": [["Revenue", "$4,820,000"], ["Net income", "$610,000"]],
               "highlight_row": 1}
    }
  ]
}
```
Canvas `draw` types: `table`, `calc`, `entry` (Dr/Cr → "POSTED"), `checks`,
`flow`, `compare`. Each renders on black, monospace, green/amber/red for meaning.

## Author scenes with recipes
```python
from explainer import recipes as r, engine
scenes = [
    r.report_table("P&L — March", ["Line", "Amount"],
                   [["Revenue", "$4,820,000"], ["Net income", "$610,000"]],
                   say="Revenue was $4,820,000 and net income $610,000.",
                   facts={"revenue": "$4,820,000", "net_income": "$610,000"}, highlight_row=1),
    r.transaction_entry(["Dr  Accounts payable  $250,000", "Cr  Cash  $250,000"],
                        say="We settled a $250,000 supplier invoice.",
                        facts={"amount": "$250,000"}),
    r.reconciliation_calc([...], say="...", facts={...}),
    r.comparison("Budget", [...], "Actual", [...], say="...", facts={...}),
]
plan = engine.build_plan({"subject_id": "acme-close", "title": "March close", "scenes": scenes})
```

## Plug your data in (providers)
Implement `fetch(subject_id, as_of) -> request`. Built in: `DictProvider`,
`JsonProvider` (a file or a directory of `<subject>.json`). Pit Wall is
`pitwall.explain.plan` (a DB-backed provider that also does `as_of` rewind).

## Drive it
```bash
# offline, no keys — terminal playback + export the browser player
pitwall explain sample                         # bundled monthly-close sample
pitwall explain from-json path/to/request.json --export voice/plan.js
open voice/replay.html                         # watch it build live (captions + canvas)

# live voice (drop keys in .env): narrate your data
EXPLAIN_SOURCE=json:/path/to/requests  uv run python voice/agent.py dev
```
Optional: set `ANTHROPIC_API_KEY` to let Claude polish the spoken lines (still
re-validated for grounding). Files: `engine.py` · `recipes.py` · `providers.py` ·
`llm.py` · `samples/`.
