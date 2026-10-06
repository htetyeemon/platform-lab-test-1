/**
 * Data access for `bookings`.
 *
 * Every query in this file takes its values as bound parameters (`?`). No
 * request-derived string is ever interpolated into SQL text — the lab forbids
 * it and it is the injection hole this design avoids.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { BookingInput } from './validation';

/** Rows come back snake_case from SQLite... */
export type BookingRow = {
  id: string;
  equipment_id: string;
  borrower_name: string;
  start_at: string;
  end_at: string;
  purpose: string;
};

/** ...the API contract speaks camelCase. */
export type Booking = {
  id: string;
  equipmentId: string;
  borrowerName: string;
  startAt: string;
  endAt: string;
  purpose: string;
};

export function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    borrowerName: row.borrower_name,
    startAt: row.start_at,
    endAt: row.end_at,
    purpose: row.purpose,
  };
}

export async function getBooking(db: D1Database, id: string): Promise<BookingRow | null> {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<BookingRow>();
}

/** Rule 1 — the referenced equipment must actually exist. */
export async function equipmentExists(db: D1Database, equipmentId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM equipment WHERE id = ?')
    .bind(equipmentId)
    .first<{ id: string }>();
  return row !== null;
}

/**
 * Rule 3 (THE BIG ONE) — does another booking for the same equipment overlap
 * the requested time range?
 *
 * Two intervals overlap exactly when:
 *
 *     existing.start_at <  new.end_at
 *     AND
 *     existing.end_at   >  new.start_at
 *
 * Intervals are therefore half-open `[start_at, end_at)`: back-to-back
 * bookings (09:00-11:00 then 11:00-13:00) do NOT clash — `11:00 > 11:00` is
 * false — which leaves a clean handover moment.
 *
 * When `excludeId` is given (PATCH), `AND id != ?` removes the booking being
 * edited from the search. Without it every update would conflict with itself
 * and no booking could ever be changed.
 *
 * All values are bound, never concatenated.
 */
export async function findConflict(
  db: D1Database,
  input: BookingInput,
  excludeId?: string,
): Promise<{ id: string } | null> {
  if (excludeId === undefined) {
    return db
      .prepare(
        `SELECT id FROM bookings
          WHERE equipment_id = ?
            AND start_at < ?
            AND end_at   > ?
          LIMIT 1`,
      )
      .bind(input.equipmentId, input.endAt, input.startAt)
      .first<{ id: string }>();
  }

  return db
    .prepare(
      `SELECT id FROM bookings
        WHERE equipment_id = ?
          AND id != ?
          AND start_at < ?
          AND end_at   > ?
        LIMIT 1`,
    )
    .bind(input.equipmentId, excludeId, input.endAt, input.startAt)
    .first<{ id: string }>();
}

/** Fixed 409 message from the contract. */
export const CONFLICT_ERROR = 'Equipment is already booked during this time';

const INSERT_SQL = `INSERT INTO bookings
    (id, equipment_id, borrower_name, start_at, end_at, purpose)
  VALUES (?, ?, ?, ?, ?, ?)
  RETURNING id, equipment_id, borrower_name, start_at, end_at, purpose`;

/**
 * Part 7 — create the booking. Six values, six `?` placeholders, all bound.
 *
 * The id comes from `crypto.randomUUID()`: server-minted, so a client can
 * never choose (or overwrite) an id, and unique without a counter or a
 * retry loop. `RETURNING` reads the row back straight from the database, so
 * the 201 body is what was actually stored rather than an echo of the input.
 *
 * Database errors propagate to the app-level handler, which answers with a
 * generic JSON 500 and never leaks SQL.
 */
export async function insertBooking(db: D1Database, input: BookingInput): Promise<BookingRow | null> {
  return db
    .prepare(INSERT_SQL)
    .bind(
      crypto.randomUUID(),
      input.equipmentId,
      input.borrowerName,
      input.startAt,
      input.endAt,
      input.purpose,
    )
    .first<BookingRow>();
}

const UPDATE_SQL = `UPDATE bookings
    SET equipment_id = ?,
        borrower_name = ?,
        start_at = ?,
        end_at = ?,
        purpose = ?
  WHERE id = ?
  RETURNING id, equipment_id, borrower_name, start_at, end_at, purpose`;

/**
 * Part 8 — persist the merged row. The route has already run every
 * validation against those exact values, so this writes all five fields as
 * one unit rather than patching columns piecemeal.
 *
 * Returns null when `WHERE id = ?` matched nothing: the row was deleted
 * between the read and this write, which is a 404 rather than a 500.
 */
export async function updateBooking(
  db: D1Database,
  id: string,
  input: BookingInput,
): Promise<BookingRow | null> {
  return db
    .prepare(UPDATE_SQL)
    .bind(
      input.equipmentId,
      input.borrowerName,
      input.startAt,
      input.endAt,
      input.purpose,
      id,
    )
    .first<BookingRow>();
}

/**
 * Part 9 — delete. `meta.changes` is the number of rows the statement
 * actually removed, which is how "no such booking" becomes a 404.
 */
export async function deleteBooking(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
