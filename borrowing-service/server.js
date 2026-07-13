const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { requireJwt } = require('../shared/auth');
const { publishEvent } = require('../shared/rabbit');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'borrowing.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_name TEXT NOT NULL,
    borrower_email TEXT NOT NULL,
    book_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    notification_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS outbox_events (
    event_id TEXT PRIMARY KEY,
    routing_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT
  );
`);

const app = express();
app.use(express.json());

const catalogBaseUrl = process.env.CATALOG_BASE_URL || 'http://localhost:3001';

function reservationPayload(reservation, type) {
  return {
    eventId: crypto.randomUUID(),
    eventType: type,
    occurredAt: new Date().toISOString(),
    reservation: {
      id: reservation.id,
      borrowerName: reservation.borrower_name,
      borrowerEmail: reservation.borrower_email,
      bookId: reservation.book_id,
      status: reservation.status
    }
  };
}

async function callCatalog(pathname, options = {}) {
  try {
    const response = await fetch(`${catalogBaseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-service-key': process.env.SERVICE_KEY, ...(options.headers || {}) }
    });
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  } catch {
    const error = new Error('Catalog Service is unavailable.'); error.status = 503; throw error;
  }
}

async function publishOutbox(event) {
  try {
    await publishEvent(event.routing_key, JSON.parse(event.payload));
    db.prepare("UPDATE outbox_events SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE event_id = ?").run(event.event_id);
    return true;
  } catch (error) {
    console.error(`RabbitMQ publish failed for ${event.event_id}: ${error.message}`);
    return false;
  }
}

app.get('/health', (req, res) => res.json({ service: 'borrowing-service', status: 'ok' }));
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.DEMO_USERNAME || password !== process.env.DEMO_PASSWORD) {
    return res.status(401).json({ error: 'Invalid demo credentials.' });
  }
  const token = jwt.sign({ sub: username, role: 'librarian' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return res.json({ token, tokenType: 'Bearer', expiresIn: '1h' });
});

app.get('/reservations', requireJwt, (req, res) => res.json(db.prepare('SELECT * FROM reservations ORDER BY id DESC').all()));
app.get('/reservations/:id', requireJwt, (req, res) => {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
  return res.json(reservation);
});

app.post('/reservations', requireJwt, async (req, res) => {
  const { borrowerName, borrowerEmail, bookId } = req.body;
  if (typeof borrowerName !== 'string' || !borrowerName.trim() || typeof borrowerEmail !== 'string' || !borrowerEmail.includes('@') || !Number.isInteger(bookId)) {
    return res.status(400).json({ error: 'borrowerName, valid borrowerEmail, and integer bookId are required.' });
  }
  if (req.headers['x-simulate-downstream-failure'] === 'true') {
    return res.status(503).json({ error: 'Simulated Catalog Service failure. No reservation was created.' });
  }
  try {
    const reservationResult = db.prepare('INSERT INTO reservations (borrower_name, borrower_email, book_id) VALUES (?, ?, ?)')
      .run(borrowerName.trim(), borrowerEmail.trim().toLowerCase(), bookId);
    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationResult.lastInsertRowid);
    const catalog = await callCatalog('/internal/allocations', { method: 'POST', body: JSON.stringify({ reservationId: reservation.id, bookId, borrowerName: reservation.borrower_name }) });
    if (!catalog.response.ok) {
      db.prepare('DELETE FROM reservations WHERE id = ?').run(reservation.id);
      return res.status(catalog.response.status).json(catalog.body);
    }
    const payload = reservationPayload(reservation, 'reservation.created');
    db.prepare('INSERT INTO outbox_events (event_id, routing_key, payload) VALUES (?, ?, ?)').run(payload.eventId, 'reservation.created', JSON.stringify(payload));
    const event = db.prepare('SELECT * FROM outbox_events WHERE event_id = ?').get(payload.eventId);
    const published = await publishOutbox(event);
    db.prepare('UPDATE reservations SET notification_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(published ? 'queued' : 'pending_retry', reservation.id);
    const created = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id);
    return res.status(201).json({ reservation: created, allocation: catalog.body, message: published ? 'Reservation created and notification queued.' : 'Reservation created; notification remains in the retry outbox.' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Unable to create reservation.' });
  }
});

app.put('/reservations/:id/cancel', requireJwt, async (req, res) => {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
  if (reservation.status === 'cancelled') return res.status(409).json({ error: 'Reservation is already cancelled.' });
  try {
    const catalog = await callCatalog(`/internal/allocations/${reservation.id}/release`, { method: 'PUT', body: '{}' });
    if (!catalog.response.ok) return res.status(catalog.response.status).json(catalog.body);
    db.prepare("UPDATE reservations SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reservation.id);
    const cancelled = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id);
    const payload = reservationPayload(cancelled, 'reservation.cancelled');
    db.prepare('INSERT INTO outbox_events (event_id, routing_key, payload) VALUES (?, ?, ?)').run(payload.eventId, 'reservation.cancelled', JSON.stringify(payload));
    const published = await publishOutbox(db.prepare('SELECT * FROM outbox_events WHERE event_id = ?').get(payload.eventId));
    db.prepare('UPDATE reservations SET notification_status = ? WHERE id = ?').run(published ? 'queued' : 'pending_retry', reservation.id);
    return res.json(db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id));
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Unable to cancel reservation.' });
  }
});

app.delete('/reservations/:id', requireJwt, (req, res) => {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
  if (reservation.status !== 'cancelled') return res.status(409).json({ error: 'Cancel the reservation before deleting it.' });
  db.prepare('DELETE FROM reservations WHERE id = ?').run(req.params.id);
  return res.status(204).send();
});

app.post('/internal/retry-outbox', requireJwt, async (req, res) => {
  const pending = db.prepare("SELECT * FROM outbox_events WHERE status = 'pending' ORDER BY created_at").all();
  let published = 0;
  for (const event of pending) if (await publishOutbox(event)) published += 1;
  return res.json({ pending: pending.length, published });
});

const port = Number(process.env.BORROWING_PORT || 3002);
app.listen(port, () => console.log(`Borrowing Service listening on http://localhost:${port}`));
