window.PITWALL_PLANS = {
 "txn-INV-2048": {
  "subject_id": "txn-INV-2048",
  "as_of": null,
  "title": "Customer payment \u2014 INV-2048",
  "scenes": [
   {
    "say": "A customer paid $120,000 against invoice INV-2048.",
    "ui": {
     "focus": "Customer payment \u2014 INV-2048",
     "panel": "canvas",
     "highlight": "entry"
    },
    "facts": [
     {
      "key": "amount",
      "value": "$120,000",
      "source": "ledger"
     }
    ],
    "draw": {
     "type": "entry",
     "title": "Customer payment \u2014 INV-2048",
     "lines": [
      "Dr  Cash                 $120,000",
      "Cr  Accounts receivable  $120,000"
     ]
    }
   },
   {
    "say": "That one payment touched four other tables \u2014 receivable cleared, cash up, balance zeroed, and an audit row appended.",
    "ui": {
     "focus": "Customer payment \u2014 INV-2048 \u2014 tables affected",
     "panel": "canvas",
     "highlight": "table"
    },
    "facts": [],
    "draw": {
     "type": "table",
     "title": "Customer payment \u2014 INV-2048 \u2014 tables affected",
     "columns": [
      "Table",
      "Rows",
      "Effect"
     ],
     "rows": [
      [
       "accounts_receivable",
       "1",
       "INV-2048 cleared  (\u2212$120,000)"
      ],
      [
       "cash_ledger",
       "1",
       "+$120,000"
      ],
      [
       "customer_balance",
       "1",
       "now $0 outstanding"
      ],
      [
       "audit_log",
       "1",
       "append: payment.posted"
      ]
     ]
    }
   },
   {
    "say": "Every write landed inside a single committed transaction, logged append-only.",
    "ui": {
     "focus": "write-ahead log",
     "panel": "canvas",
     "highlight": "log"
    },
    "facts": [],
    "draw": {
     "type": "log",
     "title": "write-ahead log",
     "entries": [
      {
       "at": "09:41:02.113",
       "text": "BEGIN  tx_8842",
       "level": "info"
      },
      {
       "at": "09:41:02.114",
       "text": "UPDATE accounts_receivable  id=INV-2048  balance -120000",
       "level": "info"
      },
      {
       "at": "09:41:02.115",
       "text": "INSERT cash_ledger  +120000",
       "level": "info"
      },
      {
       "at": "09:41:02.116",
       "text": "UPDATE customer_balance  acme-corp  -> 0",
       "level": "info"
      },
      {
       "at": "09:41:02.117",
       "text": "INSERT audit_log  payment.posted",
       "level": "ok"
      },
      {
       "at": "09:41:02.118",
       "text": "COMMIT tx_8842",
       "level": "ok"
      }
     ]
    }
   }
  ]
 },
 "acme-close-2026-03": {
  "subject_id": "acme-close-2026-03",
  "as_of": null,
  "title": "Acme Corp \u2014 March close, reviewed",
  "scenes": [
   {
    "say": "In March, revenue was $4,820,000 and net income came in at $610,000.",
    "ui": {
     "focus": "P&L \u2014 March",
     "panel": "canvas",
     "highlight": "table"
    },
    "facts": [
     {
      "key": "revenue",
      "value": "$4,820,000",
      "source": "report"
     },
     {
      "key": "net_income",
      "value": "$610,000",
      "source": "report"
     }
    ],
    "draw": {
     "type": "table",
     "title": "P&L \u2014 March",
     "columns": [
      "Line",
      "Amount"
     ],
     "rows": [
      [
       "Revenue",
       "$4,820,000"
      ],
      [
       "COGS",
       "($2,310,000)"
      ],
      [
       "Opex",
       "($1,540,000)"
      ],
      [
       "Operating income",
       "$970,000"
      ],
      [
       "Net income",
       "$610,000"
      ]
     ],
     "highlight_row": 4
    }
   },
   {
    "say": "We settled a $250,000 supplier invoice \u2014 payables down, cash down.",
    "ui": {
     "focus": "journal entry",
     "panel": "canvas",
     "highlight": "entry"
    },
    "facts": [
     {
      "key": "amount",
      "value": "$250,000",
      "source": "ledger"
     }
    ],
    "draw": {
     "type": "entry",
     "title": "journal entry",
     "lines": [
      "Dr  Accounts payable      $250,000",
      "Cr  Cash                  $250,000"
     ]
    }
   },
   {
    "say": "The bank reconciled to the cent \u2014 $52,500 of outstanding checks explains the gap.",
    "ui": {
     "focus": "reconciliation",
     "panel": "canvas",
     "highlight": "calc"
    },
    "facts": [
     {
      "key": "outstanding",
      "value": "$52,500",
      "source": "calc"
     }
    ],
    "draw": {
     "type": "calc",
     "title": "reconciliation",
     "lines": [
      "Book balance        $1,205,400",
      "Bank statement      $1,257,900",
      "Outstanding checks  $52,500",
      "1,205,400 + 52,500 = 1,257,900  tie"
     ]
    }
   },
   {
    "say": "Every close check passed.",
    "ui": {
     "focus": "checks",
     "panel": "canvas",
     "highlight": "checks"
    },
    "facts": [],
    "draw": {
     "type": "checks",
     "title": "checks",
     "items": [
      {
       "label": "Subledgers tie to GL",
       "ok": true
      },
      {
       "label": "Accruals posted",
       "ok": true
      },
      {
       "label": "Intercompany eliminated",
       "ok": true
      },
      {
       "label": "FX revalued",
       "ok": true
      }
     ]
    }
   },
   {
    "say": "We beat plan: revenue of $4,820,000 against $4,500,000 budgeted.",
    "ui": {
     "focus": "comparison",
     "panel": "canvas",
     "highlight": "compare"
    },
    "facts": [
     {
      "key": "actual_rev",
      "value": "$4,820,000",
      "source": "compare"
     },
     {
      "key": "budget_rev",
      "value": "$4,500,000",
      "source": "compare"
     }
    ],
    "draw": {
     "type": "compare",
     "title": "comparison",
     "columns": [
      {
       "label": "Budget",
       "lines": [
        "Revenue  $4,500,000",
        "Net      $520,000"
       ]
      },
      {
       "label": "Actual",
       "lines": [
        "Revenue  $4,820,000",
        "Net      $610,000"
       ]
      }
     ]
    }
   }
  ]
 },
 "txn-PO-7731": {
  "subject_id": "txn-PO-7731",
  "as_of": null,
  "title": "Vendor payment \u2014 PO-7731 (held)",
  "scenes": [
   {
    "say": "A vendor payment for $88,400 was queued against PO-7731.",
    "ui": {
     "focus": "Vendor payment \u2014 PO-7731",
     "panel": "canvas",
     "highlight": "entry"
    },
    "facts": [
     {
      "key": "amount",
      "value": "$88,400",
      "source": "ledger"
     }
    ],
    "draw": {
     "type": "entry",
     "title": "Vendor payment \u2014 PO-7731",
     "lines": [
      "Dr  Accounts payable   $88,400",
      "Cr  Cash               $88,400"
     ]
    }
   },
   {
    "say": "But the payee account changed right before this run, after two clean payments.",
    "ui": {
     "focus": "Payee history",
     "panel": "canvas",
     "highlight": "table"
    },
    "facts": [],
    "draw": {
     "type": "table",
     "title": "Payee history",
     "columns": [
      "Payment",
      "Account",
      "Changed?"
     ],
     "rows": [
      [
       "1",
       "DE21\u20264471",
       "no"
      ],
      [
       "2",
       "DE21\u20264471",
       "no"
      ],
      [
       "3 (new)",
       "LT05\u20269902",
       "YES"
      ]
     ],
     "highlight_row": 2
    }
   },
   {
    "say": "Two hard checks failed \u2014 the bank account is unverified and changed inside the cutoff.",
    "ui": {
     "focus": "checks",
     "panel": "canvas",
     "highlight": "checks"
    },
    "facts": [],
    "draw": {
     "type": "checks",
     "title": "checks",
     "items": [
      {
       "label": "amount within PO",
       "ok": true
      },
      {
       "label": "payee bank verified",
       "ok": false
      },
      {
       "label": "change window > 72h",
       "ok": false
      }
     ]
    }
   },
   {
    "say": "So it was held and routed to a human, not paid.",
    "ui": {
     "focus": "cascade",
     "panel": "canvas",
     "highlight": "flow"
    },
    "facts": [],
    "draw": {
     "type": "flow",
     "title": "cascade",
     "boxes": [
      "bank check \u2717",
      "HOLD",
      "route to controller"
     ]
    }
   },
   {
    "say": "Every step is in the append-only log, including why it was held.",
    "ui": {
     "focus": "write-ahead log",
     "panel": "canvas",
     "highlight": "log"
    },
    "facts": [],
    "draw": {
     "type": "log",
     "title": "write-ahead log",
     "entries": [
      {
       "at": "14:02:09.004",
       "text": "BEGIN tx_5521",
       "level": "info"
      },
      {
       "at": "14:02:09.006",
       "text": "SELECT vendor_bank  PO-7731  -> mismatch",
       "level": "warn"
      },
      {
       "at": "14:02:09.007",
       "text": "UPDATE payment  status=HELD",
       "level": "warn"
      },
      {
       "at": "14:02:09.008",
       "text": "INSERT audit_log  payment.held reason=bank_unverified",
       "level": "err"
      },
      {
       "at": "14:02:09.009",
       "text": "COMMIT tx_5521",
       "level": "ok"
      }
     ]
    }
   }
  ]
 }
};
window.PITWALL_INDEX = [
 {
  "id": "txn-INV-2048",
  "title": "Customer payment \u2014 INV-2048",
  "scenes": 3,
  "grounded": true
 },
 {
  "id": "acme-close-2026-03",
  "title": "Acme Corp \u2014 March close, reviewed",
  "scenes": 5,
  "grounded": true
 },
 {
  "id": "txn-PO-7731",
  "title": "Vendor payment \u2014 PO-7731 (held)",
  "scenes": 5,
  "grounded": true
 }
];
