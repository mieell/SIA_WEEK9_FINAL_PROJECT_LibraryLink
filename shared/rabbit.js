const amqp = require('amqplib');

const EXCHANGE = 'library.events';

async function publishEvent(routingKey, payload) {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  try {
    const channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
      messageId: payload.eventId
    });
    await channel.close();
  } finally {
    await connection.close();
  }
}

module.exports = { EXCHANGE, publishEvent };
