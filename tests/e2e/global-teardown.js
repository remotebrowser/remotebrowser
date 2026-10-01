import { rmSync } from 'node:fs';

// Remove the throwaway PGlite directory this run created, if any.
export default function globalTeardown() {
  if (process.env.PGLITE_DATA_DIR_CLEANUP === '1') {
    rmSync(process.env.PGLITE_DATA_DIR, { recursive: true, force: true });
  }
}
