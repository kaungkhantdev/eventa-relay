import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// MIRROR of eventa-api's `outbox_events`. eventa-api OWNS the schema and
// migrations; nothing here creates or alters a table. Keep in sync with
// ../eventa-docs/04-architecture/entities.md.
//
// This is the only table this service touches, and it touches two columns:
// it reads rows where `published_at IS NULL`, and it sets `published_at`.
// Unlike a domain table the shape is infrastructure and effectively frozen —
// which is what makes a mirror safe here.
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: bigint({ mode: 'number' }).notNull(),
    aggregateType: text().notNull(),
    aggregateId: text().notNull(),
    routingKey: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** NULL means still owed. Set once the broker has confirmed it. */
    publishedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    /** Not before this time — lets a producer delay a message. */
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: only the unpublished rows are indexed, so the poll stays cheap
    // however large the published history grows.
    index('ix_outbox_unpublished')
      .on(t.publishedAt)
      .where(sql`published_at is null`),
  ],
);
