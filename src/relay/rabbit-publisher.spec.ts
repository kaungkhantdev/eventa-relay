import { EventEmitter } from 'node:events';
import type { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { Env } from '../config/env.validation';
import { RabbitPublisher } from './rabbit-publisher';

jest.mock('amqplib');

const EXCHANGE = 'eventa.events';

/** A channel that records publishes and can emit lifecycle events like the real one. */
class FakeChannel extends EventEmitter {
  publish = jest.fn();
  waitForConfirms = jest.fn().mockResolvedValue(undefined);
  assertExchange = jest.fn().mockResolvedValue(undefined);
  close = jest.fn().mockResolvedValue(undefined);
}

class FakeConnection extends EventEmitter {
  readonly createConfirmChannel: jest.Mock;
  readonly close = jest.fn().mockResolvedValue(undefined);

  constructor(readonly channel: FakeChannel) {
    super();
    this.createConfirmChannel = jest.fn().mockResolvedValue(channel);
  }
}

function harness() {
  const channel = new FakeChannel();
  const connection = new FakeConnection(channel);
  jest.mocked(amqp.connect).mockResolvedValue(connection as never);
  const config = {
    get: (key: keyof Env) =>
      key === 'RABBITMQ_EXCHANGE' ? EXCHANGE : 'amqp://localhost',
  } as unknown as ConfigService<Env, true>;
  return { publisher: new RabbitPublisher(config), connection, channel };
}

const message = {
  routingKey: 'registration.confirmed',
  messageId: '42',
  payload: { orderId: 'o-1' },
};

beforeEach(() => jest.clearAllMocks());

describe('RabbitPublisher', () => {
  it('connects on first publish, not at construction', async () => {
    const { publisher, channel } = harness();
    expect(amqp.connect).not.toHaveBeenCalled();

    await publisher.publish(message);

    expect(amqp.connect).toHaveBeenCalledTimes(1);
    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('reuses one connection across publishes', async () => {
    const { publisher } = harness();

    await publisher.publish(message);
    await publisher.publish(message);

    expect(amqp.connect).toHaveBeenCalledTimes(1);
  });

  it('waits for the broker to confirm before reporting success', async () => {
    const { publisher, channel } = harness();

    await publisher.publish(message);

    expect(channel.waitForConfirms).toHaveBeenCalledTimes(1);
  });

  /**
   * The one that matters. amqplib emits `'error'` on the connection, and in Node
   * an `'error'` event with no listener terminates the PROCESS. A heartbeat
   * timeout is an ordinary transient on an idle connection — it took the whole
   * relay down, and with it every email in the system, until this was handled.
   */
  it('survives a connection error instead of crashing the process', async () => {
    const { publisher, connection } = harness();
    await publisher.publish(message);

    expect(() =>
      connection.emit('error', new Error('Heartbeat timeout')),
    ).not.toThrow();
  });

  it('reconnects on the next publish after the connection is lost', async () => {
    const { publisher, connection } = harness();
    await publisher.publish(message);

    connection.emit('error', new Error('Heartbeat timeout'));
    await publisher.publish(message);

    expect(amqp.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects after the channel closes too', async () => {
    const { publisher, channel } = harness();
    await publisher.publish(message);

    channel.emit('close');
    await publisher.publish(message);

    expect(amqp.connect).toHaveBeenCalledTimes(2);
  });
});
