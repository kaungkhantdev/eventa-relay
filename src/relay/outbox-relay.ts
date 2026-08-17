import { Injectable } from '@nestjs/common';
import { OutboxReaderPort } from './outbox-reader.port';
import { PublisherPort } from './publisher.port';

/** Publishes pending outbox rows to the broker, then marks them published. */
@Injectable()
export class OutboxRelay {
  constructor(
    private readonly reader: OutboxReaderPort,
    private readonly publisher: PublisherPort,
  ) {}

  /** Publish a batch of pending events, marking each published only after it is sent. */
  async publishPending(batchSize = 100): Promise<number> {
    const rows = await this.reader.fetchBatch(batchSize);
    let published = 0;
    for (const row of rows) {
      await this.publisher.publish({
        routingKey: row.routingKey,
        messageId: String(row.id),
        payload: row.payload,
      });
      await this.reader.markPublished([row.id]);
      published++;
    }
    return published;
  }
}
