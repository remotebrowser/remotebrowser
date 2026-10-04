import { rmSync } from 'node:fs';

// Removes the throwaway PGlite dirs this run created, one per app instance.
export default function globalTeardown() {
  let dirs = [];
  try {
    dirs = JSON.parse(process.env.E2E_PGLITE_DIRS || '[]');
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
