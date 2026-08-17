import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { Env } from '../config/env.validation';
import { type PublishMessage, PublisherPort } from './publisher.port';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type ConfirmChannel = Awaited<ReturnType<Connection['createConfirmChannel']>>;

/**
 * amqplib publisher with publisher confirms (at-least-once).
 *
 * Connects LAZILY and reconnects on its own. Both were learned the hard way:
 *
 * - amqplib emits `'error'` on the connection, and an unhandled `'error'` event
 *   is a process-level crash in Node. A heartbeat timeout — ordinary and
 *   transient on an idle connection — would otherwise kill the relay, and with
 *   it every email in the system. Handling it turns a crash into a reconnect.
 * - Connecting at boot means a broker that is briefly down stops the relay
 *   starting at all. Connecting on first use means it retries on the next tick,
 *   because the poll loop is already a retry loop.
 */
@Injectable()
export class RabbitPublisher extends PublisherPort implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitPublisher.name);
  private connection?: Connection;
  private channel?: ConfirmChannel;
  private readonly exchange: string;
  private readonly url: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.exchange = config.get('RABBITMQ_EXCHANGE', { infer: true });
    this.url = config.get('RABBITMQ_URL', { infer: true });
  }

  async publish(message: PublishMessage): Promise<void> {
    const channel = await this.connect();
    channel.publish(
      this.exchange,
      message.routingKey,
      Buffer.from(JSON.stringify(message.payload)),
      {
        messageId: message.messageId,
        contentType: 'application/json',
        persistent: true,
      },
    );
    await channel.waitForConfirms();
  }

  /** The live channel, opening one if the last was lost. */
  private async connect(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(this.url);
    // Attached before anything else can fail: an 'error' with no listener is
    // fatal to the process, not just to the connection.
    connection.on('error', (err) => this.drop('connection error', err));
    connection.on('close', () => this.drop('connection closed'));
    const channel = await connection.createConfirmChannel();
    channel.on('error', (err) => this.drop('channel error', err));
    channel.on('close', () => this.drop('channel closed'));
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    this.connection = connection;
    this.channel = channel;
    this.logger.log('connected to broker');
    return channel;
  }

  /**
   * Forget the handles so the next publish reconnects.
   *
   * Nothing is lost by dropping work in flight: a row is marked published only
   * after its confirm returns, so anything unconfirmed when the connection died
   * is still `published_at IS NULL` and goes out on the next pass.
   */
  private drop(reason: string, err?: unknown): void {
    if (!this.channel && !this.connection) return;
    this.channel = undefined;
    this.connection = undefined;
    this.logger.warn({ err }, `broker ${reason} — will reconnect`);
  }

  async onModuleDestroy(): Promise<void> {
    const [channel, connection] = [this.channel, this.connection];
    this.channel = undefined;
    this.connection = undefined;
    try {
      await channel?.close();
    } catch {
      /* already gone */
    }
    try {
      await connection?.close();
    } catch {
      /* already gone */
    }
  }
}
