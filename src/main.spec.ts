import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { AppConfigModule } from './config/config.module';
import { PG_POOL } from './db/drizzle.constants';
import { bootstrap } from './main';
import { OutboxReaderPort } from './relay/outbox-reader.port';
import { PublisherPort } from './relay/publisher.port';

/**
 * The real AppConfigModule must never load here. Its ConfigModule.forRoot()
 * reads .env and validates the environment the moment app.module.ts is
 * imported, before overrideModule() can replace it. A developer's .env
 * satisfied that; CI has none, so every test failed on DATABASE_URL.
 * AppModule imports this empty stand-in, which TestConfigModule replaces.
 */
jest.mock('./config/config.module', () => {
  const { Module } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  class AppConfigModule {}
  Module({})(AppConfigModule);
  return { AppConfigModule };
});

const POLL_MS = 5;

/** The relay's config, from here rather than from a .env or the environment. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      skipProcessEnv: true,
      load: [
        () => ({
          // Never dialled: the pool connects on first query, and the reader is
          // a stub that makes none.
          DATABASE_URL: 'postgres://relay@127.0.0.1:1/none',
          RABBITMQ_URL: 'amqp://127.0.0.1:1',
          RABBITMQ_EXCHANGE: 'eventa.events',
          OUTBOX_POLL_MS: POLL_MS,
          OUTBOX_BATCH: 10,
        }),
      ],
    }),
  ],
})
class TestConfigModule {}

async function until(done: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The process as a plain emitter, for listener bookkeeping on any event. */
const events: NodeJS.EventEmitter = process;

/**
 * A graceful stop: what `docker stop`, a rollout or a scale-down asks of the
 * relay. In the image node is PID 1, so SIGTERM reaches main.ts directly.
 *
 * main.ts enables Nest's shutdown hooks, which close the app on SIGTERM. It
 * also had a SIGTERM handler of its own that called app.close() beside them,
 * so every destroy hook ran twice. The second pool.end() rejects ("Called end
 * on pool more than once"), and whichever shutdown got that rejection ended
 * the process with exit code 1: an unhandled rejection, or Nest's own
 * ERROR_DURING_SHUTDOWN and process.exit(1).
 */
describe('the relay on SIGTERM', () => {
  let app: TestingModule;
  let reader: { fetchBatch: jest.Mock; markPublished: jest.Mock };
  let poolEnd: jest.SpyInstance;
  let kill: jest.SpyInstance;
  let exit: jest.SpyInstance;
  let listenersBefore: Map<string | symbol, unknown[]>;
  let stopped: boolean;

  beforeEach(async () => {
    stopped = false;
    listenersBefore = new Map(
      events.eventNames().map((name) => [name, events.listeners(name)]),
    );
    reader = {
      fetchBatch: jest.fn().mockResolvedValue([]),
      markPublished: jest.fn().mockResolvedValue(undefined),
    };
    app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(AppConfigModule)
      .useModule(TestConfigModule)
      .overrideProvider(OutboxReaderPort)
      .useValue(reader)
      .overrideProvider(PublisherPort)
      .useValue({ publish: jest.fn() })
      .compile();
    poolEnd = jest.spyOn(app.get<Pool>(PG_POOL), 'end');
    jest
      .spyOn(NestFactory, 'createApplicationContext')
      .mockImplementation(async () => {
        await app.init();
        return app;
      });
    // Nest re-raises the signal once its hooks are done, and exits 1 when one
    // throws. Neither may reach the test runner's own process.
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (!stopped) await app.close();
    // Whatever the run left listening on the process: the old main.ts left
    // its SIGINT handler behind after a SIGTERM.
    for (const name of events.eventNames()) {
      const before = listenersBefore.get(name) ?? [];
      for (const listener of events.listeners(name)) {
        if (!before.includes(listener)) {
          events.removeListener(name, listener as (...args: unknown[]) => void);
        }
      }
    }
    jest.restoreAllMocks();
  });

  /** Starts the relay, lets it poll, sends SIGTERM and waits for Nest to finish. */
  async function startThenStop(): Promise<void> {
    await bootstrap();
    await until(() => reader.fetchBatch.mock.calls.length > 0);
    // As node delivers a signal: the listener gets its name.
    process.emit('SIGTERM', 'SIGTERM');
    stopped = true;
    await until(() => kill.mock.calls.length + exit.mock.calls.length > 0);
    // Anything still settling on the way out.
    await sleep(POLL_MS * 4);
  }

  it('closes the database pool once, and the close succeeds', async () => {
    await startThenStop();

    expect(poolEnd).toHaveBeenCalledTimes(1);
    await expect(poolEnd.mock.results[0].value).resolves.toBeUndefined();
  });

  it('never exits 1: it hands SIGTERM back to the default handler', async () => {
    await startThenStop();

    expect(exit).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('stops polling', async () => {
    await startThenStop();
    const polls = reader.fetchBatch.mock.calls.length;

    await sleep(POLL_MS * 6);

    expect(reader.fetchBatch.mock.calls.length).toBe(polls);
  });
});
