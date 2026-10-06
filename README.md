# Faculty Shared-Equipment Booking API

A backend API for reserving shared faculty equipment (projectors, cameras,
meeting rooms). It refuses to book the same item twice for overlapping times.

**Stack:** TypeScript · [Hono](https://hono.dev) · Cloudflare Workers · Cloudflare D1
**Live URL:** `https://faculty-equipment-booking.taskflow-123.workers.dev/api`

```bash
BASE_URL=https://faculty-equipment-booking.taskflow-123.workers.dev/api
curl -s "$BASE_URL/equipment"
```

---

## Run it

**Prerequisites:** Node.js 18+, an account at [dash.cloudflare.com](https://dash.cloudflare.com),
and `npx wrangler login` once (the account already used here has D1 + Workers
write access).

```bash
npm install                 # deps: hono, wrangler, typescript

# Database — the D1 instance already exists and is wired up in wrangler.jsonc,
# so these are only needed on a fresh clone of a brand-new account:
npm run db:create           # prints a new database_id -> paste into wrangler.jsonc
npm run db:migrate:remote   # apply migrations/ to the remote D1 database
npm run db:seed:remote      # insert eq-1 / eq-2 (also clears all bookings)

npm run deploy              # build + deploy to Cloudflare -> prints the URL
```

Local development (optional — the graded URL is the deployed one):

```bash
npm run dev                 # http://127.0.0.1:8787
npm run db:migrate          # apply migrations locally
npm run db:seed             # seed locally
```

Other commands:

```bash
npm run typecheck           # tsc --noEmit
```

---

## Endpoints

Full contract: [`API_CONTRACT.md`](API_CONTRACT.md) · schema: [`ERD.md`](ERD.md)

| Method | Path | Success | Purpose |
| --- | --- | ---: | --- |
| `GET` | `/api/equipment` | 200 | List equipment |
| `GET` | `/api/bookings` | 200 | List bookings (`?equipmentId=eq-1` filters) |
| `GET` | `/api/bookings/:id` | 200 | Get one booking |
| `POST` | `/api/bookings` | 201 | Create a booking |
| `PATCH` | `/api/bookings/:id` | 200 | Partial update |
| `DELETE` | `/api/bookings/:id` | 204 | Delete a booking |
| `GET` | `/api/health` | 200 | Liveness probe |
| `GET` | `/` and `/api` | 200 | Endpoint index |

Create / update body:

```json
{
  "equipmentId": "eq-1",
  "borrowerName": "Somchai Jaidee",
  "startAt": "2026-10-20T09:00:00.000Z",
  "endAt": "2026-10-20T11:00:00.000Z",
  "purpose": "Class presentation"
}
```

Errors are always JSON: `{ "error": "message" }`.

| Status | Meaning |
| ---: | --- |
| `400` | missing/empty/malformed data, or `startAt` not before `endAt` |
| `404` | no such booking, or `equipmentId` names no equipment |
| `409` | the times overlap another booking for the same equipment |

**Validation order** (every check runs before any write):
body well-formed → equipment exists → `startAt < endAt` (timestamps parsed,
never string-compared) → overlap check.

**Overlap rule:** half-open intervals `[startAt, endAt)` —
`existing.start_at < new.end_at AND existing.end_at > new.start_at`.
Back-to-back bookings are allowed (`09:00–11:00` then `11:00–13:00`).
`PATCH` adds `AND id != ?` so a booking never conflicts with itself.

---

## Test it

Manual, against the deployment:

```bash
curl -i "$BASE_URL/equipment"
curl -i -X POST "$BASE_URL/bookings" -H "Content-Type: application/json" \
  -d '{"equipmentId":"eq-1","borrowerName":"Somchai Jaidee","startAt":"2026-10-20T09:00:00.000Z","endAt":"2026-10-20T11:00:00.000Z","purpose":"Class presentation"}'
curl -i "$BASE_URL/bookings/<id-from-the-201-above>"
curl -i -X DELETE "$BASE_URL/bookings/<id>"
```

Automated evidence suite (30 cases: CRUD, all three validations, boundary
rule, timezone normalisation, error shapes):

```bash
npm run db:seed:remote       # the suite expects an empty bookings table
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/curl-tests.ps1
# -> 30/30 cases passed, exit 0
```

It runs with `curl.exe` under PowerShell; the same requests work verbatim in
Postman. Latest full run and the case list are recorded in
[`AI_LOG.md`](AI_LOG.md) and [`QUALITY_GATE_REVIEW.md`](QUALITY_GATE_REVIEW.md).

---

## Project layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | Hono routes: equipment, bookings CRUD, errors |
| `src/validation.ts` | Body/timestamp validation, PATCH merge inputs |
| `src/bookings.ts` | Parameter-bound queries, overlap check |
| `migrations/0001_create_equipment_and_bookings.sql` | Schema |
| `seed.sql` | `eq-1` Projector A, `eq-2` Camera A |
| `scripts/curl-tests.ps1` | Evidence suite |
| `API_CONTRACT.md` / `ERD.md` | Contract and data model (written before the code) |
| `AI_LOG.md` / `QUALITY_GATE_REVIEW.md` | AI record / quality-gate findings |

---

## Notes

* **No CORS headers are sent**, deliberately: there is no browser-based
  client, so no preflight ever happens. Adding CORS later must not change any
  response shape.
* **Authentication** is out of scope — not required by the brief.
* All SQL uses bound `?` parameters; no request data is ever concatenated
  into a statement.
