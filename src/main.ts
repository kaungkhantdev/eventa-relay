import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { OutboxPoller } from './relay/outbox-poller';

/**
 * The outbox relay: eventa-api's `outbox_events` → RabbitMQ.
 *
 * An application CONTEXT, not an HTTP server — this service answers no
 * requests. It polls one table, publishes what it finds with publisher
 * confirms, and marks each row published only after the broker has it.
 *
 * ⚠️ RUN EXACTLY ONE REPLICA. `fetchBatch` takes no row lock, so a second
 * instance would select the same rows and publish every event twice. Consumers
 * dedupe on message id, but only *after* the first copy has finished — two
 * copies delivered concurrently would both be handled, which for a
 * registration means two confirmation emails to the same buyer. Scaling this
 * safely needs `FOR UPDATE SKIP LOCKED` in the reader first.
 */
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  // The one shutdown path. On SIGTERM, SIGINT or any other signal it listens
  // for, Nest runs the destroy hooks once: the poller stops its timer, the
  // publisher closes the AMQP channel, the pool ends. A signal handler here
  // that also closes the app runs them twice, and the second pool.end()
  // rejects (src/main.spec.ts).
  app.enableShutdownHooks();
  app.get(OutboxPoller).start();
}

// Run when node starts this file (`node dist/main`, `nest start`); a test
// imports bootstrap() instead.
if (require.main === module) void bootstrap();
