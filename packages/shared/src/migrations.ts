import { fileURLToPath } from 'node:url';

/** Absolute path to the shared SQL migrations directory. */
export const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
