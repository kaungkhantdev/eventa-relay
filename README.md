# eventa-relay

Publishes **eventa-api**'s transactional outbox to RabbitMQ.

One job: poll `outbox_events` for rows where `published_at IS NULL`, publish each
to the topic exchange with publisher confirms, and mark it published only after
the broker has acknowledged it.

## Why it is a service and not a function call

RabbitMQ cannot join a Postgres transaction. If eventa-api published directly,
there would be two orderings and both lose data: publish-then-commit sends an
email for an order that does not exist, and commit-then-publish loses the email
for an order that does. So the API writes the *intent* into `outbox_events` in
the same transaction as the order, and this service carries it across
afterwards. The trade is **"might be late"** instead of **"might be lost"** —
which is the right trade when a paid ticket is in the message.

If this service is down, nothing is lost. Rows accumulate with
`published_at IS NULL` and drain the moment it comes back.

## ⚠️ Run exactly one replica

`fetchBatch` takes **no row lock**. A second instance would select the same rows
and publish every event twice. Consumers dedupe by message id, but only *after*
the first copy finishes — two copies delivered concurrently are both handled,
which for a registration means two confirmation emails to the same buyer.

Scaling this horizontally requires `FOR UPDATE SKIP LOCKED` in
`outbox-reader.repository.ts` first, so replicas claim disjoint rows. Until then
the deployment must pin `replicas: 1`.

## Run

```bash
pnpm install
cp .env.example .env
pnpm dev            # nest start --watch
pnpm build && pnpm start:prod   # node dist/main
```

Needs Postgres and RabbitMQ — `docker compose up -d` in `../eventa-api` starts
both.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | eventa-api's database. Read `outbox_events`, set `published_at`. |
| `RABBITMQ_URL` | — | Broker to publish to. |
| `RABBITMQ_EXCHANGE` | `eventa.events` | Topic exchange. Must match the consumers'. |
| `OUTBOX_POLL_MS` | `1000` | How often to look for pending rows. |
| `OUTBOX_BATCH` | `100` | Rows per pass. |

No JWT secret, no Stripe key, no SMTP credentials — this service is given
nothing it could leak.

## Schema ownership

`src/db/schema/outbox.ts` is a **mirror**. eventa-api owns the schema and the
migrations; nothing here creates or alters a table. The mirror is safe to keep
because `outbox_events` is infrastructure rather than a domain aggregate — its
shape does not move with business rules. See
`../eventa-docs/04-architecture/entities.md`.

## Health

```sql
-- Should be ~0. Growing means the relay is down or wedged.
SELECT count(*), min(created_at) AS oldest
  FROM outbox_events WHERE published_at IS NULL;
```

That query is the signal worth alerting on — outbox lag, not process liveness.
A relay that is running but not publishing looks healthy to a liveness probe.
