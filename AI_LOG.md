# AI_LOG.md — Faculty Shared-Equipment Booking API

Record of how this lab was produced, which decisions were taken and why, and
where the evidence lives. Written as the work proceeded, not reconstructed at
the end.

**Stack:** TypeScript · Cloudflare Worker · Hono · Cloudflare D1
**Deployed URL:** `https://faculty-equipment-booking.taskflow-123.workers.dev/api`
**D1 database:** `faculty-booking-db` (`23f181b2-57b2-4cd2-b8d1-1f605a7b5f3d`), region APAC
**Date:** 2026-10-06

---

## 1. What the AI did, in order

| Stage | Output |
| --- | --- |
| Design first (Parts 1–2) | `API_CONTRACT.md` and `ERD.md` written **before** any code, as the brief requires |
| Schema (Part 2) | `migrations/0001_create_equipment_and_bookings.sql` — the two tables exactly as specified, plus two supporting indexes; applied `--local` and `--remote` |
| Seed (Part 3) | `seed.sql` — `eq-1` Projector A / Building 1, `eq-2` Camera A / Media Room; `GET /api/equipment` returns the expected array |
| Read endpoints (Parts 4–5) | `GET /api/bookings`, `GET /api/bookings/:id` |
| Create + validation (Parts 6–7) | `POST /api/bookings` with the three validations and `crypto.randomUUID()` insert |
| Update (Part 8) | `PATCH /api/bookings/:id` — partial merge, same three validations, `AND id != ?` |
| Delete (Part 9) | `DELETE /api/bookings/:id` — 204 / 404 |
| Evidence | `scripts/curl-tests.ps1` — 25 cases against the **deployed** URL, all passing |
| Quality Gate | Re-reviewed every rubric area; added 5 edge-case tests (30 total), wrote `README.md`, fixed contract drift (discovery routes), logged prompts (§7). See `QUALITY_GATE_REVIEW.md` |

No code was written until Parts 1 and 2 were finished and reviewed.

---

## 2. Decisions taken (and why)

**Deployed URL, not localhost.** The brief's example says
`http://localhost:8787/api`, but this lab tests against a real Cloudflare
deployment. `BASE_URL` is defined as the `*.workers.dev` link in
`API_CONTRACT.md`; `wrangler dev` exists only for local development.

**404 for an unknown `equipmentId`, 400 for a malformed one.** A missing or
empty value is invalid data → `400`. A well-formed value that names nothing
is a resource that is not found → `404`, same as `GET /bookings/no-such-id`.
The brief's wording — *"use 404 when a resource is not found"* — supports
this, and `API_CONTRACT.md` documents it explicitly so the choice is visible
rather than accidental.

**Timestamps are parsed, then normalised.** Every incoming instant goes
through `new Date()`; the ordering check compares `Date` objects
(`NaN || start >= end`), never raw strings. What is stored is always
`toISOString()` output — fixed width, fixed format, UTC — which is why
SQLite's plain `<` / `>` on TEXT compares chronologically and cannot be
fooled by a `+07:00` offset.

**Half-open intervals: touching is allowed.** `09:00–11:00` followed by
`11:00–13:00` is a `201`, because `existing.end > new.start` is
`11:00 > 11:00` → false. The lab leaves the boundary rule open; this is the
interpretation that makes a handover work, and `API_CONTRACT.md` §4 states it
as a chosen rule so it can be explained if asked.

**Conflict query is exactly the lab's three parameters on POST** —
`equipment_id = ?`, `start_at < ?`, `end_at > ?`, bound as
`(equipmentId, endAt, startAt)`. PATCH adds `AND id != ?` bound with the
booking's own id; without it an update would conflict with itself and no
booking could ever be edited.

**Validation order follows the flow diagram:** body well-formed (400) →
equipment exists (404) → `startAt < endAt` (400) → overlap (409). Every check
runs before any INSERT, so a rejected request writes nothing.

**Ids:** `crypto.randomUUID()` for bookings (server-minted, so a client can
never choose or overwrite an id); the fixed strings `eq-1` / `eq-2` for
equipment, since those are seeded fixtures.

**Snake_case → camelCase mapping.** `SELECT *` returns `equipment_id`,
`start_at`… while the contract requires `equipmentId`, `startAt`…, so every
row passes through `toBooking()` before it is sent. The API never leaks
storage details to clients.

**Equipment is read-only.** The contract defines `GET /api/equipment` only;
the two records come from `seed.sql`, not from a `POST`.

---

## 3. Lab requirements → where they are satisfied

| Requirement | Where |
| --- | --- |
| Two+ equipment records | `seed.sql`, verified by test case #1 |
| `bookings` CRUD, correct status codes | `src/index.ts` — 200/201/204/400/404/409 |
| `equipmentId` must exist | `src/index.ts` `equipmentExists()` → 404 |
| `startAt` before `endAt` | `src/validation.ts` `parseTimeRange()` → 400 |
| No overlapping bookings | `src/bookings.ts` `findConflict()` → 409 |
| Parameter binding, no string concatenation | every `.prepare(...).bind(...)`; no request value appears in SQL text anywhere |
| JSON error format `{ "error": "..." }` | single constants + `app.notFound` + `app.onError` |
| Evidence for 5+ cases, success and error | `scripts/curl-tests.ps1` — 30 cases (12 success, 18 error) |

---

## 4. Evidence

Reproduce from a clean table:

```bash
npm run db:seed:remote
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/curl-tests.ps1
```

Latest run: **30/30 passed**, exit code 0.

| # | Case | Status |
| ---: | --- | ---: |
| 1 | `GET /equipment` returns both seeded records | 200 |
| 2 | `GET /bookings` empty after seed | 200 `[]` |
| 3 | Create a booking | 201 |
| 4–5 | Read it back / see it in the list | 200 |
| 6 | Unknown `equipmentId` | 404 |
| 7–9 | Reversed / equal / unparseable timestamps | 400 |
| 10 | Overlapping booking | 409 |
| 11–12 | Back-to-back booking; same hours on other equipment | 201 |
| 13–14 | Missing field; malformed JSON | 400 |
| 15 | Unknown booking id | 404 |
| 16 | PATCH with its own time range (no self-conflict) | 200 |
| 17 | PATCH into another booking's window | 409 |
| 18–21 | PATCH unknown equipment / reversed / empty body / unknown id | 404, 400, 400, 404 |
| 22 | Timestamp `+07:00` is stored normalised as UTC | 201 |
| 23 | Overlap is detected against the normalised UTC value | 409 |
| 24 | Partial PATCH with no time fields keeps stored times | 200 |
| 25 | PATCH `endAt`-only: merged range conflicts | 409 |
| 26 | JSON array as request body | 400 |
| 27–29 | DELETE → 204 with empty body, then 404 on GET and on repeat delete | 204/404 |
| 30 | Neighbouring booking survived the delete | 200 |

---

## 5. Known limitations

* **Check-then-insert race.** The conflict test and the INSERT are two
  statements. D1 offers no exclusion constraint and no multi-row interactive
  transaction, so two requests racing in the same millisecond could both pass
  the check. This is documented in `ERD.md`; a production design would
  serialise writes per equipment item.
* No auth, no pagination, no CORS — none required by the brief, and adding
  them later must not change the response shapes in `API_CONTRACT.md`.
* Equipment has no create/update/delete endpoints, by contract.

---

## 7. Important prompts received, how they were used, and how checked

The brief arrived as a numbered Parts 1–9 task list with example curl commands.
The AI assistance was applied to every part, and no result was accepted purely
on trust — the deployed API was queried for each claim.

| Prompt / instruction (what was asked) | What was used (where) | How it was checked |
| --- | --- | --- |
| "What did we do so far?" — resume context | The summary of completed work, reused to continue without re-reading source | Cross-checked file list, curl hits and current D1 contents against the summary before acting |
| Parts 1–2: write contract + ERD **before** code | Written into `API_CONTRACT.md` and `ERD.md`, then kept as the source of truth | The final deployed responses were diffed against the contract §2/§3; 30/30 cases match |
| Part 3: seed two equipment records | `seed.sql`; `GET /api/equipment` shows them | Curl: `200` with `eq-1`/`eq-2` (test #1) |
| Parts 4–9: bookings CRUD + validations + evidence | `src/*.ts`, `scripts/curl-tests.ps1` | Full 30-case suite + Postman guide for manual screenshots |
| Review turns (mixed): "nothing shows up on /api/bookings", overlap PATCH bug | Diagnosed empty-array rendering; added `AND id != ?` | Curl showing `200 []` vs populated list; self-conflict test #16 |
| Quality Gate checklist | Rubric walked in full; only defects (missing README, contract drift, untested edges) were fixed | Re-ran typecheck + suite → 30/30, live URL verified |

**What I changed after the Quality Gate review and why** (see
`QUALITY_GATE_REVIEW.md` for the full finding→action→evidence table): added
timezone/merge/array-body test cases; documented the discovery routes that
existed in code but not in the contract; wrote the missing `README.md`;
expanded this log to record prompts. No API behaviour was altered — the code
passed the review as-is.

---

## 6. Verification commands

```bash
npm run typecheck        # tsc --noEmit
npm run db:migrate:remote
npm run db:seed:remote
npm run deploy
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/curl-tests.ps1
```
