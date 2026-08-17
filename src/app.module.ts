import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { OutboxReaderPort } from './relay/outbox-reader.port';
import { OutboxReader } from './relay/outbox-reader.repository';
import { OutboxRelay } from './relay/outbox-relay';
import { PublisherPort } from './relay/publisher.port';
import { RabbitPublisher } from './relay/rabbit-publisher';

/**
 * The whole service: read eventa-api's outbox, publish to RabbitMQ, mark done.
 *
 * Two providers behind ports, so the relay itself depends on neither Postgres
 * nor amqplib and stays unit-testable without either running.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule],
  providers: [
    OutboxRelay,
    { provide: OutboxReaderPort, useClass: OutboxReader },
    { provide: PublisherPort, useClass: RabbitPublisher },
  ],
})
export class AppModule {}
