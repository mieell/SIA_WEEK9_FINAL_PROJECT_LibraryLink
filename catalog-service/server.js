const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const { requireJwt, requireServiceKey } = require('../shared/auth');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'catalog.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    total_copies INTEGER NOT NULL CHECK(total_copies >= 0),
    available_copies INTEGER NOT NULL CHECK(available_copies >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS allocations (
    reservation_id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL,
    borrower_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TEXT,
    FOREIGN KEY(book_id) REFERENCES books(id)
  );
`);

if (db.prepare('SELECT COUNT(*) AS count FROM books').get().count === 0) {
  const seed = db.prepare('INSERT INTO books (title, author, total_copies, available_copies) VALUES (?, ?, ?, ?)');
  [['Clean Code', 'Robert C. Martin', 3, 3], ['The Pragmatic Programmer', 'Andrew Hunt', 2, 2], ['Database System Concepts', 'Silberschatz, Korth, Sudarshan', 1, 1]]
    .forEach((book) => seed.run(...book));
}

const app = express();
app.use(express.json());

function validBookBody(body) {
  return typeof body.title === 'string' && body.title.trim() && typeof body.author === 'string' && body.author.trim()
    && Number.isInteger(body.totalCopies) && body.totalCopies >= 0;
}

app.get('/health', (req, res) => res.json({ service: 'catalog-service', status: 'ok' }));
app.get('/books', (req, res) => res.json(db.prepare('SELECT * FROM books ORDER BY id').all()));
app.get('/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  return res.json(book);
});

app.post('/books', requireJwt, (req, res) => {
  if (!validBookBody(req.body)) return res.status(400).json({ error: 'title, author, and non-negative integer totalCopies are required.' });
  const { title, author, totalCopies } = req.body;
  const result = db.prepare('INSERT INTO books (title, author, total_copies, available_copies) VALUES (?, ?, ?, ?)')
    .run(title.trim(), author.trim(), totalCopies, totalCopies);
  return res.status(201).json(db.prepare('SELECT * FROM books WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/books/:id', requireJwt, (req, res) => {
  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Book not found.' });
  const { title = existing.title, author = existing.author, totalCopies = existing.total_copies, expectedVersion } = req.body;
  if (typeof title !== 'string' || !title.trim() || typeof author !== 'string' || !author.trim() || !Number.isInteger(totalCopies) || totalCopies < 0 || !Number.isInteger(expectedVersion)) {
    return res.status(400).json({ error: 'title, author, totalCopies, and expectedVersion are required.' });
  }
  const active = db.prepare("SELECT COUNT(*) AS count FROM allocations WHERE book_id = ? AND status = 'active'").get(req.params.id).count;
  if (totalCopies < active) return res.status(409).json({ error: 'totalCopies cannot be less than active allocations.' });
  const availableCopies = totalCopies - active;
  const result = db.prepare(`UPDATE books SET title = ?, author = ?, total_copies = ?, available_copies = ?, version = version + 1,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`).run(title.trim(), author.trim(), totalCopies, availableCopies, req.params.id, expectedVersion);
  if (result.changes === 0) return res.status(409).json({ error: 'Book was updated by another request. Refresh and retry with the latest version.' });
  return res.json(db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id));
});

app.delete('/books/:id', requireJwt, (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  if (book.available_copies !== book.total_copies) return res.status(409).json({ error: 'A book with active allocations cannot be deleted.' });
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  return res.status(204).send();
});

const allocate = db.transaction(({ reservationId, bookId, borrowerName }) => {
  const existing = db.prepare('SELECT * FROM allocations WHERE reservation_id = ?').get(reservationId);
  if (existing) return { allocation: existing, idempotent: true };
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) {
    const error = new Error('Book not found.'); error.status = 404; throw error;
  }
  if (book.available_copies < 1) {
    const error = new Error('No copies are currently available.'); error.status = 409; throw error;
  }
  db.prepare('UPDATE books SET available_copies = available_copies - 1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(bookId);
  db.prepare('INSERT INTO allocations (reservation_id, book_id, borrower_name) VALUES (?, ?, ?)').run(reservationId, bookId, borrowerName);
  return { allocation: db.prepare('SELECT * FROM allocations WHERE reservation_id = ?').get(reservationId), idempotent: false };
});

app.post('/internal/allocations', requireServiceKey, (req, res) => {
  const { reservationId, bookId, borrowerName } = req.body;
  if (!Number.isInteger(reservationId) || !Number.isInteger(bookId) || typeof borrowerName !== 'string' || !borrowerName.trim()) {
    return res.status(400).json({ error: 'reservationId, bookId, and borrowerName are required.' });
  }
  try {
    const result = allocate({ reservationId, bookId, borrowerName: borrowerName.trim() });
    return res.status(result.idempotent ? 200 : 201).json(result.allocation);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Allocation failed.' });
  }
});

app.put('/internal/allocations/:reservationId/release', requireServiceKey, (req, res) => {
  const allocation = db.prepare('SELECT * FROM allocations WHERE reservation_id = ?').get(req.params.reservationId);
  if (!allocation) return res.status(404).json({ error: 'Allocation not found.' });
  if (allocation.status === 'released') return res.json(allocation);
  const release = db.transaction(() => {
    db.prepare("UPDATE allocations SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE reservation_id = ?").run(req.params.reservationId);
    db.prepare('UPDATE books SET available_copies = available_copies + 1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(allocation.book_id);
  });
  release();
  return res.json(db.prepare('SELECT * FROM allocations WHERE reservation_id = ?').get(req.params.reservationId));
});

app.get('/internal/allocations', requireServiceKey, (req, res) => res.json(db.prepare('SELECT * FROM allocations ORDER BY created_at DESC').all()));

const port = Number(process.env.CATALOG_PORT || 3001);
app.listen(port, () => console.log(`Catalog Service listening on http://localhost:${port}`));
