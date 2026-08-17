import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';
import { OutboxRelay } from './relay/outbox-relay';

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
async function bootstrap(): Promise<void> {
  const logger = new Logger('Relay');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const relay = app.get(OutboxRelay);
  const pollMs = config.get('OUTBOX_POLL_MS', { infer: true });
  const batch = config.get('OUTBOX_BATCH', { infer: true });

  const tick = async (): Promise<void> => {
    try {
      const n = await relay.publishPending(batch);
      if (n > 0) logger.log(`published ${n} event(s)`);
    } catch (err) {
      // Logged and dropped, never rethrown: an unhandled rejection in a timer
      // takes the process down, and the next tick finds exactly the same rows
      // because nothing was marked published.
      logger.error({ err }, 'relay tick failed');
    }
  };

  const timer = setInterval(() => void tick(), pollMs);
  const shutdown = () => {
    clearInterval(timer);
    void app.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  logger.log(`outbox relay started (poll ${pollMs}ms, batch ${batch})`);
}

void bootstrap();
