"""System of Work — the 'beyond the harness' core (Hyphenate blueprint).

Records hold the truth about the business; this holds the truth about the WORK:
work items, decisions + reasons, questions + approvals, learned policies, the log.

  roles.py        who may do what, to which resource (+ separation of duties)
  transitions.py  the work-item state machine
  gateway.py      the ONE door: every write checked, logged as a diff, same commit
  sync.py         systems of record -> one shape; a work item per bank line
"""
