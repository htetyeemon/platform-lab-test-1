# API Contract — Faculty Shared-Equipment Booking API

Written **before** implementation, as required by the lab brief.
Implementation must match this document; if code and contract disagree, the
contract wins.

---

## 1. Basics

| | |
| --- | --- |
| Base URL (`BASE_URL`) | The **deployed Cloudflare Worker link**: `https://faculty-equipment-booking.taskflow-123.workers.dev/api` |
| Style | REST, JSON in / JSON out |
| Content type | `application/json; charset=utf-8` on every response with a body |
| Auth | None (not required by the brief) |
| CORS | Disabled — there is no browser client, so no preflight is ever sent |

All tests in this lab are run with `curl` against the **deployed** URL — there
is no `localhost` step. `wrangler dev` exists only as a development aid; the
URL that is graded is the `*.workers.dev` one. Substitute the real hostname
printed by `npm run deploy` wherever `BASE_URL` appears below.

### Identifiers

* `equipmentId` values are **strings** supplied by the service: `eq-1`, `eq-2`, …
* `booking` ids are **UUID v4 strings** minted by the service with
  `crypto.randomUUID()`. Clients never choose them; they are returned in the
  `201` body of `POST` and are what `/bookings/:id` accepts.

### Timestamps

* Request: any ISO-8601 instant (`2026-10-20T09:00:00.000Z`,
  `2026-10-20T16:00:00+07:00`, or date-only `2026-10-20`).
* Stored and returned: **always normalised to UTC** in the exact form
  `YYYY-MM-DDTHH:mm:ss.sssZ` (what `Date#toISOString` produces).
* Comparison is therefore lexicographic on a single fixed format — no
  timezone can make two instants compare wrongly.

---

## 2. Resources

### 2.1 Equipment — `GET /api/equipment`

List every bookable item. **Success: `200`.**

```json
[
  { "id": "eq-1", "name": "Projector A", "location": "Building 1" },
  { "id": "eq-2", "name": "Camera A", "location": "Media Room" }
]
```

Bare JSON array, ordered by `id`. Equipment is read-only through this API:
records are created by seeding the database, not by a `POST`.

| Condition | Status |
| --- | --- |
| OK | `200` |
| Anything unexpected | `500` |

### 2.2 Bookings

| Method | Path | Success | Purpose |
| --- | --- | ---: | --- |
| `GET` | `/api/bookings` | `200` | List bookings |
| `GET` | `/api/bookings/:id` | `200` | Get one booking |
| `POST` | `/api/bookings` | `201` | Create a booking |
| `PATCH` | `/api/bookings/:id` | `200` | Update a booking |
| `DELETE` | `/api/bookings/:id` | `204` | Delete a booking |

#### Booking representation

```json
{
  "id": "20271491-51c6-4429-a809-0b72ede5f7b1",
  "equipmentId": "eq-1",
  "borrowerName": "Somchai Jaidee",
  "startAt": "2026-10-20T09:00:00.000Z",
  "endAt": "2026-10-20T11:00:00.000Z",
  "purpose": "Class presentation"
}
```

Required fields: `id`, `equipmentId`, `borrowerName`, `startAt`, `endAt`,
`purpose` — exactly the payload fields plus the server-assigned `id`.

#### `GET /api/bookings` → `200`

Bare JSON array, ordered by `startAt` then `id`. Empty array when nothing is
booked.

Optional filter: `?equipmentId=eq-1` returns only that item's bookings
(unknown id → `200` with `[]`, because no resource is being dereferenced).

#### `GET /api/bookings/:id` → `200`

Single booking. Unknown or malformed id → `404`.

#### `POST /api/bookings` → `201`

Request body:

```json
{
  "equipmentId": "eq-1",
  "borrowerName": "Somchai Jaidee",
  "startAt": "2026-10-20T09:00:00.000Z",
  "endAt": "2026-10-20T11:00:00.000Z",
  "purpose": "Class presentation"
}
```

All five fields are **required**. Response body is the created booking; the
`Location` header points at `/api/bookings/<id>`.

#### `PATCH /api/bookings/:id` → `200`

Body is a **partial** version of the payload above; any subset of the five
fields may be sent, but at least one of them must be present. The patch is
merged into the stored row and the **whole** merged row is re-validated
(`equipmentId` exists, `startAt < endAt`, no overlap). The merged row is
returned. `id` is server-owned and cannot be changed.

```json
{ "endAt": "2026-10-20T12:00:00.000Z" }
```

#### `DELETE /api/bookings/:id` → `204`

Empty body (`204` must not carry one).

### 2.3 Service routes — `GET /`, `GET /api`, `GET /api/health`

Added after deployment, when a bare `GET /api` returned `404` and a browser
opened on the base URL showed nothing useful. All three return `200`.

| Path | Body |
| --- | --- |
| `GET /` and `GET /api` | Discovery index: `{ "name", "endpoints": { "equipment", "bookings", "booking", "health" }, "methods": [...] }` |
| `GET /api/health` | `{ "status": "ok" }` |

They carry no booking or equipment data, exist only so the deployment is
self-describing, and are excluded from the CRUD rules above. Every other
unrouted path still returns `404` with `{"error":"Not found"}`.

---

## 3. Errors

Every failure — including Hono's own 404 for an unrouted path — is JSON:

```json
{ "error": "A message understandable to a user or developer" }
```

No error body ever contains anything else (no stack traces, no SQL).

### Status codes

| Code | Used when |
| ---: | --- |
| `200` | Successful `GET` / `PATCH` |
| `201` | Successful `POST` |
| `204` | Successful `DELETE` |
| `400` | Missing, empty, malformed or illogical data (see list below) |
| `404` | The booking or equipment named by the request does not exist |
| `409` | The requested time range overlaps an existing booking |
| `500` | Unexpected fault; message stays generic |

### Error catalogue

**`400` — invalid data**

| Message | Trigger |
| --- | --- |
| `Request body must be valid JSON` | body is not parseable JSON, or empty |
| `Request body must be a JSON object` | body parses to an array/number/string/null |
| `equipmentId is required` / `equipmentId must be a non-empty string` | missing or wrong type |
| `borrowerName is required` / `borrowerName must be a non-empty string` | missing, wrong type, or whitespace-only |
| `purpose is required` / `purpose must be a non-empty string` | missing, wrong type, or whitespace-only |
| `startAt must be before endAt` | `startAt` or `endAt` missing, not a string, unparseable — **or** `startAt >= endAt`. Both instants are parsed into `Date` objects first; raw strings are never compared |
| `Request body must include at least one of: equipmentId, borrowerName, startAt, endAt, purpose` | `PATCH` with no recognised field |

**`404` — not found**

| Message | Trigger |
| --- | --- |
| `Booking not found` | unknown `:id` on `GET` / `PATCH` / `DELETE` |
| `Equipment not found` | `equipmentId` in a `POST`/`PATCH` body names no such equipment |
| `Not found` | no route matches the path |

> **Why `404` for an unknown `equipmentId`:** the field is a reference to
> another resource. A missing/empty/typed-wrong value is *invalid data* →
> `400`; a well-formed value that names nothing is *a resource that is not
> found* → `404`, exactly like `GET /bookings/no-such-id`.

**`409` — conflict**

| Message | Trigger |
| --- | --- |
| `Equipment is already booked during this time` | new/updated range overlaps an existing booking for the same equipment |

---

## 4. Business rules

1. **`equipmentId` must exist** — checked against the `equipment` table on
   every `POST` and `PATCH`.
2. **`startAt` must be strictly before `endAt`** — both values are parsed
   with `new Date()` and compared as dates (never as raw strings); missing,
   unparseable or reversed ranges are rejected
   (`startAt must be before endAt`).
3. **No overlapping bookings for the same equipment.** Intervals are treated
   as **half-open `[startAt, endAt)`**:

   ```
   overlaps  ⇔  newStart < existingEnd  AND  newEnd > existingStart
   ```

   * `09:00–11:00` + `10:00–12:00` → **409**
   * `09:00–11:00` + `11:00–13:00` → **201** (back-to-back is allowed)
   * `09:00–11:00` + `07:00–09:00` → **201** (touching is allowed)
   * Different equipment never conflicts, no matter the times.

   **Chosen boundary rule:** touching bookings are *not* a conflict. The lab
   does not state a preference, and half-open intervals are what a handover
   needs — the projector is free again the instant the previous booking ends,
   and a checker can see from the SQL that `11:00 > 11:00` is false.
4. A `PATCH` re-runs rules 1–3 against the merged row, **excluding the
   booking being edited** (otherwise every patch would conflict with itself).

---

## 5. Out of scope

Authentication, equipment create/update/delete endpoints, pagination, and
CORS. None are required by the brief; adding them later must not change any
response shape documented above.
