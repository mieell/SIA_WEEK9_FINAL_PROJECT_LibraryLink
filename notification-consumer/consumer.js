const path = require('path');
const fs = require('fs');
const amqp = require('amqplib');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const { EXCHANGE } = require('../shared/rabbit');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'notifications.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  event_id TEXT PRIMARY KEY,
  reservation_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

async function start() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  const queue = await channel.assertQueue('library-notifications', { durable: true });
  await channel.bindQueue(queue.queue, EXCHANGE, 'reservation.*');
  channel.prefetch(1);
  console.log('Notification Consumer waiting for reservation events...');
  channel.consume(queue.queue, (message) => {
    if (!message) return;
    try {
      const event = JSON.parse(message.content.toString());
      const existing = db.prepare('SELECT event_id FROM notifications WHERE event_id = ?').get(event.eventId);
      if (existing) { channel.ack(message); return; }
      const simulatedFailure = process.env.SIMULATE_NOTIFICATION_FAILURE === 'true';
      const status = simulatedFailure ? 'failed' : 'sent';
      const details = simulatedFailure ? 'Simulated SMS/email provider failure; event preserved in notification log.' : 'Confirmation logged by Notification Consumer.';
      db.prepare('INSERT INTO notifications (event_id, reservation_id, event_type, recipient, status, details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(event.eventId, event.reservation.id, event.eventType, event.reservation.borrowerEmail, status, details);
      console.log(`[${status.toUpperCase()}] ${event.eventType} for reservation ${event.reservation.id} -> ${event.reservation.borrowerEmail}`);
      channel.ack(message);
    } catch (error) {
      console.error(`Notification Consumer error: ${error.message}`);
      channel.nack(message, false, false);
    }
  });
}

start().catch((error) => {
  console.error(`Could not start Notification Consumer: ${error.message}`);
  process.exit(1);
});
