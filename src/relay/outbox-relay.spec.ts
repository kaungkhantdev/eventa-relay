import { OutboxReaderPort, type OutboxRow } from './outbox-reader.port';
import { OutboxRelay } from './outbox-relay';
import { PublisherPort } from './publisher.port';

const row: OutboxRow = {
  id: 7,
  organizationId: 1,
  routingKey: 'identity.signed_in',
  payload: { userId: 'u1' },
};

describe('OutboxRelay', () => {
  let reader: jest.Mocked<OutboxReaderPort>;
  let publisher: jest.Mocked<PublisherPort>;
  let relay: OutboxRelay;

  beforeEach(() => {
    reader = {
      fetchBatch: jest.fn(),
      markPublished: jest.fn().mockResolvedValue(undefined),
    };
    publisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    relay = new OutboxRelay(reader, publisher);
  });

  it('publishes each pending event (messageId = row id) and marks it published', async () => {
    reader.fetchBatch.mockResolvedValue([row]);

    const published = await relay.publishPending(10);

    expect(published).toBe(1);
    const [msg] = publisher.publish.mock.calls[0];
    expect(msg.routingKey).toBe('identity.signed_in');
    expect(msg.messageId).toBe('7');
    expect(msg.payload).toEqual({ userId: 'u1' });
    expect(reader.markPublished).toHaveBeenCalledWith([7]);
  });

  it('does nothing when there is no pending work', async () => {
    reader.fetchBatch.mockResolvedValue([]);
    expect(await relay.publishPending()).toBe(0);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('marks a row published only after it is published (no double-publish on failure)', async () => {
    reader.fetchBatch.mockResolvedValue([row, { ...row, id: 8 }]);
    publisher.publish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('broker down'));

    await expect(relay.publishPending()).rejects.toThrow('broker down');
    expect(reader.markPublished).toHaveBeenCalledWith([7]);
    expect(reader.markPublished).not.toHaveBeenCalledWith([8]);
  });
});
