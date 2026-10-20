import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { OutboxRelay } from './outbox-relay';

/**
 * The relay's clock: one `publishPending` pass every OUTBOX_POLL_MS.
 *
 * It owns its timer and stops it in onModuleDestroy, the first hook of every
 * way the app closes: app.close(), and each signal app.enableShutdownHooks()
 * listens for. Nothing in the relay handles a signal itself. main.ts used to,
 * calling app.close() from its own SIGTERM handler beside Nest's: the two
 * shutdowns ran every destroy hook twice, the second pool.end() rejected, and
 * every graceful stop exited 1.
 *
 * AppModule's hooks run before DatabaseModule's (Nest destroys global modules
 * last), so the timer is gone before the pool ends and no pass starts against
 * a closed pool.
 */
@Injectable()
export class OutboxPoller implements OnModuleDestroy {
  private readonly logger = new Logger('Relay');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly relay: OutboxRelay,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Starts polling. A second call while it runs does nothing. */
  start(): void {
    if (this.timer) return;
    const pollMs = this.config.get('OUTBOX_POLL_MS', { infer: true });
    const batch = this.config.get('OUTBOX_BATCH', { infer: true });
    this.timer = setInterval(() => void this.tick(batch), pollMs);
    this.logger.log(`outbox relay started (poll ${pollMs}ms, batch ${batch})`);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(batch: number): Promise<void> {
    try {
      const n = await this.relay.publishPending(batch);
      if (n > 0) this.logger.log(`published ${n} event(s)`);
    } catch (err) {
      // Logged and dropped, never rethrown: an unhandled rejection in a timer
      // takes the process down, and the next tick finds exactly the same rows
      // because nothing was marked published.
      this.logger.error({ err }, 'relay tick failed');
    }
  }
}
