/**
 * Input validation for the bookings resource.
 *
 * Mirrors the lab's validation flow, in this order:
 *
 *   1. body shape + required text fields          -> 400   (parseBookingBody)
 *   2. equipmentId exists                         -> 404   (route, needs DB)
 *   3. startAt < endAt, timestamps PARSED         -> 400   (parseTimeRange)
 *   4. no overlap with an existing booking        -> 409   (route, needs DB)
 *
 * Steps 2 and 4 need the database, so they live in the route; this module
 * owns everything that can be decided from the body alone. Nothing from a
 * request body reaches SQL until it has passed through here.
 */

export type BookingFields = {
  equipmentId: string;
  borrowerName: string;
  purpose: string;
};

export type TimeRange = {
  /** Normalised to `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC). */
  startAt: string;
  /** Normalised to `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC). */
  endAt: string;
};

export type BookingInput = BookingFields & TimeRange;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Malformed JSON and empty bodies are the caller's error, not a 500. */
export async function readJson(
  c: { req: { json(): Promise<unknown> } },
): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TEXT_FIELDS = ['equipmentId', 'borrowerName', 'purpose'] as const;

type FieldResult = string | { error: string };

function readText(body: Record<string, unknown>, field: (typeof TEXT_FIELDS)[number]): FieldResult {
  const value = body[field];
  if (value === undefined || value === null) return { error: `${field} is required` };
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: `${field} must be a non-empty string` };
  }
  return value.trim();
}

function hasError(value: FieldResult): value is { error: string } {
  return typeof value === 'object';
}

/**
 * Step 1 — is the body a JSON object carrying every required text field?
 *
 * Returns the raw body alongside the trimmed fields so the caller can hand it
 * straight to `parseTimeRange` without re-checking that it is an object.
 * Unknown keys are ignored: a client sending `createdAt` is not an error, it
 * simply has no effect.
 */
export function parseBookingBody(
  raw: unknown,
): Parsed<{ fields: BookingFields; body: Record<string, unknown> }> {
  if (raw === undefined) return { ok: false, error: 'Request body must be valid JSON' };
  if (!isPlainObject(raw)) return { ok: false, error: 'Request body must be a JSON object' };

  const fields = { equipmentId: '', borrowerName: '', purpose: '' } as BookingFields;

  for (const field of TEXT_FIELDS) {
    const value = readText(raw, field);
    if (hasError(value)) return { ok: false, error: value.error };
    fields[field] = value;
  }

  return { ok: true, value: { fields, body: raw } };
}

/**
 * Anything that is not a string is treated as an unparseable instant, so
 * `null`, a number or an object can never become 1970-01-01 by accident.
 */
function toInstant(value: unknown): Date {
  return typeof value === 'string' ? new Date(value) : new Date(NaN);
}

/**
 * Step 3 — startAt must be strictly before endAt.
 *
 * The timestamps are **parsed into Date objects**, never compared as raw
 * strings, exactly as the lab asks. `startAt === endAt` is rejected: an
 * instant-long booking has no use, and it keeps the overlap rule below
 * unambiguous.
 *
 * Failure is signalled by returning null, and the route answers with the
 * contract's fixed message.
 */
export function parseTimeRange(body: Record<string, unknown>): TimeRange | null {
  const start = toInstant(body.startAt);
  const end = toInstant(body.endAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    return null;
  }

  // Storing the normalised form is what makes every later comparison safe:
  // fixed width, fixed format, always UTC — so both JavaScript and SQLite can
  // compare them as plain strings and get chronological order.
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

/** The fixed message for a missing, unparseable or reversed time range. */
export const TIME_RANGE_ERROR = 'startAt must be before endAt';

/** Fields a PATCH body may carry — the same five the contract documents. */
export const PATCH_FIELDS = [
  'equipmentId',
  'borrowerName',
  'purpose',
  'startAt',
  'endAt',
] as const;

export const PATCH_HINT =
  'Request body must include at least one of: equipmentId, borrowerName, startAt, endAt, purpose';

/**
 * Part 8 — body validation for PATCH.
 *
 * PATCH is partial: any subset of the five fields may appear, but at least
 * one must, and every field that *is* present must satisfy the same rules as
 * a create (non-empty string, parseable timestamp). Fields that are absent
 * keep their stored values — that merge happens in the route, after the
 * booking row has been read.
 *
 * Returns only the fields the caller supplied; the route decides what to
 * inherit from the existing row.
 */
export function parsePatchBody(
  raw: unknown,
): Parsed<{ body: Record<string, unknown>; fields: Partial<BookingFields> }> {
  if (raw === undefined) return { ok: false, error: 'Request body must be valid JSON' };
  if (!isPlainObject(raw)) return { ok: false, error: 'Request body must be a JSON object' };

  // `in` (not `!== undefined`) so an explicit null is treated as supplied and
  // fails validation, instead of silently inheriting the stored value.
  if (!PATCH_FIELDS.some((field) => field in raw)) {
    return { ok: false, error: PATCH_HINT };
  }

  const fields: Partial<BookingFields> = {};
  for (const field of TEXT_FIELDS) {
    if (!(field in raw)) continue;

    const value = readText(raw, field);
    if (hasError(value)) return { ok: false, error: value.error };
    fields[field] = value;
  }

  return { ok: true, value: { body: raw, fields } };
}

