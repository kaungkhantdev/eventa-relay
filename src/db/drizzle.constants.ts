import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

/** DI token for the Drizzle database instance. Inject with `@Inject(DRIZZLE)`. */
export const DRIZZLE = Symbol('DRIZZLE');

/** DI token for the underlying pg Pool. */
export const PG_POOL = Symbol('PG_POOL');

export type Database = NodePgDatabase<typeof schema>;
