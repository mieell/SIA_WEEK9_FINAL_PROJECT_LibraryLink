# LibraryLink

LibraryLink is a System Integration and Architecture final project. It has two independently runnable Express services and a RabbitMQ notification consumer.

## Services

| Component | Port | Persistent store | Responsibility |
| --- | ---: | --- | --- |
| Catalog Service | 3001 | `data/catalog.db` | Public catalog, protected book management, and allocation synchronization |
| Borrowing Service | 3002 | `data/borrowing.db` | JWT login, reservations, cross-service inventory calls, and outbox events |
| Notification Consumer | - | `data/notifications.db` | RabbitMQ consumer that records borrow and cancel confirmations |

## Requirements

- Node.js 20+ and npm
- RabbitMQ Windows service running on `amqp://localhost`

## Setup and run

1. Copy `.env.example` to `.env` and replace the placeholder secrets.
2. Run `npm install`.
3. Start the three processes in separate terminals:

```powershell
npm run start:catalog
npm run start:borrowing
npm run start:consumer
```

4. Import `postman/LibraryLink.postman_collection.json` into Postman.
5. Run `Login`, copy the returned token into the collection variable `jwt`, then execute the requests in order.

## Demonstration flow

1. `GET /books` is public.
2. A POST without JWT returns `401`.
3. Login and use the JWT to create a reservation.
4. Borrowing Service calls Catalog Service synchronously to create an allocation and decrement availability.
5. Borrowing Service publishes `reservation.created` to RabbitMQ.
6. Notification Consumer visibly logs the event and saves it in `notifications.db`.
7. Send `x-simulate-downstream-failure: true` on Create Reservation to demonstrate graceful `503` handling.
8. Send a stale `expectedVersion` in Update Book to demonstrate `409 Conflict` optimistic concurrency control.

## Architecture choices

- **Layered microservice-style design:** independently runnable Catalog and Borrowing services, each owning its own SQLite data store.
- **Point-to-Point REST:** Borrowing Service reserves/releases inventory through protected internal Catalog endpoints.
- **Broker and Publish-Subscribe:** RabbitMQ accepts reservation events from the producer and routes them to the Notification Consumer.
- **Synchronization:** active allocation records are copied to Catalog's database. Reservation creation is rejected with `409` when no copy remains; stale catalog edits are rejected using a version number.

## Verification

```powershell
npm run test:integration
```

This launches all components temporarily and verifies public access, JWT protection, the cross-service workflow, RabbitMQ consumption, a simulated `503`, and a stale-write `409`.
