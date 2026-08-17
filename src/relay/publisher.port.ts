export interface PublishMessage {
  routingKey: string;
  messageId: string;
  payload: unknown;
}

/** Publishes a message to the broker (topic exchange). */
export abstract class PublisherPort {
  abstract publish(message: PublishMessage): Promise<void>;
}
