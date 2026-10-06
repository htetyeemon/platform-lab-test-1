# QUALITY_GATE_REVIEW.md

Review date: 2026-10-06. The full rubric was walked area by area; each check was
answered with a live curl, a file listing, or a run of the evidence suite.
Only real defects were fixed — no API behaviour was changed for the sake of a
table entry, and the code passed the review as-is.

## Improvements made (finding → action taken → evidence)

| Quality Gate area | Finding | Action taken | Evidence |
| --- | --- | --- | --- |
| Reliability / Accuracy | Overlap correctness with mixed timezones and partial `PATCH` merges was asserted in code but had **no recorded evidence**; a defect there would silently pass the original 25-case suite. | Added cases #22–#26 to `scripts/curl-tests.ps1`: `+07:00` timestamps stored as UTC, overlap detected against the *normalised* instant, `PATCH` with no time fields keeps stored times, `endAt`-only change making the merged range conflict, and a JSON-array body. | Suite re-run after `db:seed:remote`: **30/30 passed, exit 0**. Results: `201` with `"startAt":"…T17:00:00.000Z"`, `409` vs the normalised value, `200` with unchanged times, `409`/`400` for the merge cases, `400 Request body must be a JSON object`. |
| Accuracy | Contract drift: `GET /`, `GET /api` and `GET /api/health` were added to the code (to stop a bare `/api` returning 404) but `API_CONTRACT.md` §2 listed only the CRUD + equipment routes — contract and code disagreed. | Documented them as §2.3 "Service routes" with the exact response shapes, and stated every unrouted path still returns `404 {"error":"Not found"}`. | Live curl: `GET /` → 200 index `{"name",…,"endpoints":{…},"methods":[…]}`; `GET /api` → 200 identical; `GET /api/health` → `{"status":"ok"}`; body matches the documented shape field-for-field. |
| Delivery Quality | Rubric step 5 requires *"the API can be run by following the instructions in README.md"* — but **no `README.md` existed**. | Wrote `README.md`: prerequisites, `db:create/migrate/seed`, `deploy`, `dev`, `typecheck`, endpoint table, curl/Postman test instructions, project layout, and explicit no-CORS note. | `npm run typecheck` → exit 0; the suite listed in the README runs via the README's own commands and reproduces **30/30**. |
| Reasoning / You Own It | `AI_LOG.md` recorded decisions and evidence but **not the prompts/instructions received or how each was verified**, so it could not answer "what exactly did AI do, and how did you check it?" | Added §7 "Important prompts received, how they were used, and how checked" (prompt → use → verification column) and a section "What I changed after the Quality Gate review and why". | `AI_LOG.md` now covers every prompt used in this work, including the review itself; this file records the review outcome openly. |

## Checks that passed without change

* **Reliability — overlap can't be created:** POST 409 (case #10), PATCH 409
  (case #17), boundary back-to-back allowed (case #11), self-conflict
  impossible (case #16). `equipmentId` checked against existing rows (404).
* **Accuracy:** every error is `{ "error": "..." }`; timestamps parsed then
  normalised to `toISOString()`; all SQL uses bound `?` parameters — a repo
  grep shows no request value is ever concatenated into a statement.
* **Execution value:** deployed and reachable at
  `https://faculty-equipment-booking.taskflow-123.workers.dev/api`; 12 success
  + 18 error cases in the recorded suite.

## Considered and consciously left alone

* **Check-then-insert race** (`ERD.md` §limitations): two simultaneous
  requests could both pass the conflict check before either INSERT commits,
  because D1 has no exclusion constraint and no multi-statement transaction
  wrapper here. Fixing it would change the required architecture, so it is
  documented rather than sunk cost — it is not testable deterministically and
  is out of scope for this lab.
* **CORS:** deliberately absent — no browser client exists, so no preflight is
  ever sent (rubric item 7 explicitly ties CORS to a browser client).
* **`GET /bookings?equipmentId=unknown` → 200 `[]`**: kept as documented; the
  filter names no resource being dereferenced, so 404 would be wrong.