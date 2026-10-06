-- Migration 0001: equipment + bookings
-- Target: Cloudflare D1 (SQLite).
--
-- Two tables, one relationship:
--   EQUIPMENT 1 ---* BOOKINGS   (bookings.equipment_id -> equipment.id)

CREATE TABLE equipment (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL,
  borrower_name TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  FOREIGN KEY (equipment_id) REFERENCES equipment(id)
);

-- The overlap query filters by equipment, then compares start/end times
-- across only that item's bookings.
CREATE INDEX idx_bookings_equipment_start
  ON bookings (equipment_id, start_at);

CREATE INDEX idx_bookings_equipment_end
  ON bookings (equipment_id, end_at);
