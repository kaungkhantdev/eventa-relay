import { z } from 'zod';

/**
 * Environment schema — the relay refuses to start on an invalid env.
 *
 * Deliberately tiny. This service reads one table and writes to one exchange,
 * so it needs a database, a broker, and how hard to poll. It holds no JWT
 * secret, no Stripe key, no SMTP credentials: nothing here can leak what it
 * was never given.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
  RABBITMQ_EXCHANGE: z.string().default('eventa.events'),

  /** How often to look for unpublished rows, and how many to take at once. */
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH: z.coerce.number().int().positive().default(100),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
