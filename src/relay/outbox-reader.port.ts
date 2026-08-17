export interface OutboxRow {
  id: number;
  organizationId: number;
  routingKey: string;
  payload: unknown;
}

/** Reads pending outbox rows and marks them published. */
export abstract class OutboxReaderPort {
  abstract fetchBatch(limit: number): Promise<OutboxRow[]>;
  abstract markPublished(ids: number[]): Promise<void>;
}
