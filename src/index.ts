/**
 * Faculty Shared-Equipment Booking API — Cloudflare Worker (Hono + D1).
 *
 * Status codes follow API_CONTRACT.md:
 *   200  GET / PATCH success        400  invalid input
 *   201  POST created               404  booking or equipment not found
 *   204  DELETE success (no body)   409  overlapping booking for same equipment
 *   500  unexpected fault (generic message, never leaks SQL)
 *
 * Every error body is `{ "error": "<message>" }`.
 * Every query binds its values with `?` — no request data in SQL text.
 */

import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import {
  CONFLICT_ERROR,
  deleteBooking,
  equipmentExists,
  findConflict,
  getBooking,
  insertBooking,
  toBooking,
  updateBooking,
  type BookingRow,
} from './bookings';
import {
  parseBookingBody,
  parsePatchBody,
  parseTimeRange,
  readJson,
  TIME_RANGE_ERROR,
  type BookingFields,
  type BookingInput,
} from './validation';

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

const BOOKING_NOT_FOUND = { error: 'Booking not found' } as const;
const EQUIPMENT_NOT_FOUND = { error: 'Equipment not found' } as const;
const INTERNAL_ERROR = { error: 'Internal server error' } as const;

// ---------------------------------------------------------------------------
// Equipment — read-only, records come from seed.sql (Part 3).
// ---------------------------------------------------------------------------
app.get('/api/equipment', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, location FROM equipment ORDER BY id',
  ).all<{ id: string; name: string; location: string }>();

  return c.json(results ?? []);
});

// ---------------------------------------------------------------------------
// PART 4 — GET /api/bookings
//
// Optional `?equipmentId=eq-1` filter (documented in the contract). An unknown
// id simply matches nothing and returns 200 [] — no resource is dereferenced,
// so there is nothing to 404 on.
// ---------------------------------------------------------------------------
app.get('/api/bookings', async (c) => {
  const equipmentId = c.req.query('equipmentId');

  const { results } = equipmentId
    ? await c.env.DB.prepare(
        'SELECT * FROM bookings WHERE equipment_id = ? ORDER BY start_at, id',
      )
        .bind(equipmentId)
        .all<BookingRow>()
    : await c.env.DB.prepare('SELECT * FROM bookings ORDER BY start_at, id').all<BookingRow>();

  return c.json((results ?? []).map(toBooking));
});

// ---------------------------------------------------------------------------
// PART 5 — GET /api/bookings/:id
//
// `WHERE id = ?` + .bind(id): parameter binding, never string concatenation.
// Unknown or malformed id -> 404 with the contract's JSON body.
// ---------------------------------------------------------------------------
app.get('/api/bookings/:id', async (c) => {
  const row = await getBooking(c.env.DB, c.req.param('id'));
  if (!row) return c.json(BOOKING_NOT_FOUND, 404);

  return c.json(toBooking(row));
});

// ---------------------------------------------------------------------------
// PART 6 + 7 — POST /api/bookings
//
// The three validations, in the order the lab's flow diagram specifies:
//
//   POST booking
//         ↓
//   body well-formed?            NO -> 400
//         ↓ YES
//   equipment exists?            NO -> 404  {"error":"Equipment not found"}
//         ↓ YES
//   startAt < endAt (parsed)?    NO -> 400  {"error":"startAt must be before endAt"}
//         ↓ YES
//   overlaps an existing booking? YES -> 409 {"error":"Equipment is already booked during this time"}
//         ↓ NO
//   INSERT (crypto.randomUUID() id, six bound parameters) -> 201
//
// Every check runs before the INSERT, so a rejected request writes nothing.
// ---------------------------------------------------------------------------
app.post('/api/bookings', async (c) => {
  const parsed = parseBookingBody(await readJson(c));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const { fields, body } = parsed.value;

  // Validation 1 — the referenced equipment must exist.
  //   SELECT id FROM equipment WHERE id = ?
  // The DB foreign key would catch this too, but a readable 404 beats a raw
  // SQLITE_CONSTRAINT 500.
  if (!(await equipmentExists(c.env.DB, fields.equipmentId))) {
    return c.json(EQUIPMENT_NOT_FOUND, 404);
  }

  // Validation 2 — startAt < endAt, with both timestamps parsed into Dates
  // (never string-compared). Also rejects unparseable / missing instants.
  const range = parseTimeRange(body);
  if (range === null) return c.json({ error: TIME_RANGE_ERROR }, 400);

  const input: BookingInput = { ...fields, ...range };

  // Validation 3 — THE BIG ONE: no overlap for the same equipment.
  const clash = await findConflict(c.env.DB, input);
  if (clash) return c.json({ error: CONFLICT_ERROR }, 409);

  // Part 7 — all validation passed: create the row.
  const row = await insertBooking(c.env.DB, input);
  if (!row) return c.json(INTERNAL_ERROR, 500);

  return c.json(toBooking(row), 201, {
    Location: `/api/bookings/${row.id}`,
  });
});

// ---------------------------------------------------------------------------
// PART 8 — PATCH /api/bookings/:id
//
// Partial update: the body's fields are merged onto the stored row, and the
// merged result is put through the SAME three validations as a create —
// otherwise an update could sneak a conflict past the rule.
//
//   booking exists?        NO -> 404 Booking not found
//   body partial & valid?  NO -> 400
//   equipment exists?      NO -> 404 Equipment not found
//   startAt < endAt?       NO -> 400 startAt must be before endAt
//   overlaps ANOTHER booking? YES -> 409 (query carries `AND id != ?` so the
//                                     booking never conflicts with itself)
//   UPDATE -> 200 with the stored row
// ---------------------------------------------------------------------------
app.patch('/api/bookings/:id', async (c) => {
  const id = c.req.param('id');

  const existing = await getBooking(c.env.DB, id);
  if (!existing) return c.json(BOOKING_NOT_FOUND, 404);

  const parsed = parsePatchBody(await readJson(c));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const { body, fields } = parsed.value;

  // Merge: supplied fields win, everything else keeps its stored value.
  const merged: BookingFields = {
    equipmentId: fields.equipmentId ?? existing.equipment_id,
    borrowerName: fields.borrowerName ?? existing.borrower_name,
    purpose: fields.purpose ?? existing.purpose,
  };

  // Validation 1 — same check as POST, on the merged equipmentId (an update
  // may move a booking onto a different item).
  if (!(await equipmentExists(c.env.DB, merged.equipmentId))) {
    return c.json(EQUIPMENT_NOT_FOUND, 404);
  }

  // Validation 2 — timestamps: re-parse if supplied, else reuse the stored
  // (already normalised) pair.
  const range = parseTimeRange({
    startAt: 'startAt' in body ? body.startAt : existing.start_at,
    endAt: 'endAt' in body ? body.endAt : existing.end_at,
  });
  if (range === null) return c.json({ error: TIME_RANGE_ERROR }, 400);

  const input: BookingInput = { ...merged, ...range };

  // Validation 3 — overlap against every OTHER booking for that equipment.
  // `id != ?` is what stops this row from conflicting with itself.
  const clash = await findConflict(c.env.DB, input, id);
  if (clash) return c.json({ error: CONFLICT_ERROR }, 409);

  const row = await updateBooking(c.env.DB, id, input);
  if (!row) return c.json(BOOKING_NOT_FOUND, 404);

  return c.json(toBooking(row));
});

// ---------------------------------------------------------------------------
// PART 9 — DELETE /api/bookings/:id
//
// `DELETE FROM bookings WHERE id = ?` (bound). meta.changes tells us whether
// a row actually went away: 0 rows -> 404, otherwise 204 with no body.
// ---------------------------------------------------------------------------
app.delete('/api/bookings/:id', async (c) => {
  const removed = await deleteBooking(c.env.DB, c.req.param('id'));
  if (!removed) return c.json(BOOKING_NOT_FOUND, 404);

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Discovery — the bare link (and `/api`) would otherwise be a bare 404, which
// reads as "broken" in a browser. Points at the real routes instead.
// ---------------------------------------------------------------------------
const INDEX = {
  name: 'Faculty Shared-Equipment Booking API',
  endpoints: {
    equipment: '/api/equipment',
    bookings: '/api/bookings',
    booking: '/api/bookings/:id',
    health: '/api/health',
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
} as const;

app.get('/', (c) => c.json(INDEX));
app.get('/api', (c) => c.json(INDEX));

// ---------------------------------------------------------------------------
// Health + uniform JSON errors for everything else.
// ---------------------------------------------------------------------------
app.get('/api/health', (c) => c.json({ status: 'ok' }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error', err);
  return c.json(INTERNAL_ERROR, 500);
});

export default app;
