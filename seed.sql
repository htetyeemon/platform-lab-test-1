-- Seed data. Safe to re-run: bookings are cleared before equipment so the
-- foreign key is never violated.

DELETE FROM bookings;
DELETE FROM equipment;

INSERT INTO equipment (id, name, location) VALUES
  ('eq-1', 'Projector A', 'Building 1'),
  ('eq-2', 'Camera A',    'Media Room');
