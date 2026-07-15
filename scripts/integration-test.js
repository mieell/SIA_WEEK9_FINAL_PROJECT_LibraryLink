const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const node = process.execPath;
const children = [];

function start(script, label) {
  const child = spawn(node, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${label}] ${data}`));
  children.push(child);
}

function stop() {
  children.forEach((child) => child.kill());
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error(`Service did not become healthy: ${url}`);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

async function main() {
  start('catalog-service/server.js', 'catalog');
  start('borrowing-service/server.js', 'borrowing');
  start('notification-consumer/consumer.js', 'consumer');
  await Promise.all([waitFor('http://localhost:3001/health'), waitFor('http://localhost:3002/health')]);

  const publicBooks = await request('http://localhost:3001/books');
  if (publicBooks.status !== 200 || publicBooks.body.length === 0) throw new Error('Public catalog endpoint failed.');

  const login = await request('http://localhost:3002/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'librarian', password: 'LibraryLinkDemo2026' })
  });
  if (login.status !== 200 || !login.body.token) throw new Error('JWT login failed.');
  const auth = { authorization: `Bearer ${login.body.token}`, 'content-type': 'application/json' };

  const rejected = await request('http://localhost:3002/reservations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ borrowerName: 'Unauthenticated User', borrowerEmail: 'unauth@example.com', bookId: 1 })
  });
  if (rejected.status !== 401) throw new Error(`Expected 401 for unsecured write, received ${rejected.status}.`);

  const reservation = await request('http://localhost:3002/reservations', {
    method: 'POST', headers: auth, body: JSON.stringify({ borrowerName: 'Kristine Dela Cruz', borrowerEmail: 'kristine@example.com', bookId: 1 })
  });
  if (reservation.status !== 201) throw new Error(`Reservation flow failed: ${reservation.status} ${JSON.stringify(reservation.body)}`);

  const down = await request('http://localhost:3002/reservations', {
    method: 'POST', headers: { ...auth, 'x-simulate-downstream-failure': 'true' }, body: JSON.stringify({ borrowerName: 'Failure Demo', borrowerEmail: 'failure@example.com', bookId: 1 })
  });
  if (down.status !== 503) throw new Error(`Expected 503 simulated downstream failure, received ${down.status}.`);

  const current = await request('http://localhost:3001/books/1');
  const update = await request('http://localhost:3001/books/1', {
    method: 'PUT', headers: auth, body: JSON.stringify({ title: current.body.title, author: current.body.author, totalCopies: current.body.total_copies, expectedVersion: current.body.version })
  });
  if (update.status !== 200) throw new Error('Expected successful catalog update.');
  const stale = await request('http://localhost:3001/books/1', {
    method: 'PUT', headers: auth, body: JSON.stringify({ title: current.body.title, author: current.body.author, totalCopies: current.body.total_copies, expectedVersion: current.body.version })
  });
  if (stale.status !== 409) throw new Error(`Expected stale update conflict, received ${stale.status}.`);

  await sleep(1000);
  const notificationDb = new Database(path.join(root, 'data', 'notifications.db'));
  const notification = notificationDb.prepare('SELECT * FROM notifications WHERE reservation_id = ?').get(reservation.body.reservation.id);
  notificationDb.close();
  if (!notification || notification.status !== 'sent') throw new Error('RabbitMQ notification was not consumed and persisted.');

  console.log('\nPASS: public read, JWT protection, cross-service reservation, RabbitMQ consumer, simulated 503, and optimistic-lock 409 all verified.');
}

main().then(() => { stop(); process.exit(0); }).catch((error) => { console.error(`\nFAIL: ${error.message}`); stop(); process.exit(1); });
