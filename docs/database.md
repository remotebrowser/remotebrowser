# Database

Remote Browser requires a Postgres database, version 14 or newer.

Set `DATABASE_URL` to a standard Postgres connection string, for example `postgres://user:password@host:5432/dbname`. This variable is required in production, and the app will not start without it. The schema migrations in `src/db/migrations/` run automatically on startup. You only need an empty, reachable database and the correct connection string; no manual migration step is required.

Most managed Postgres hosts use a TLS certificate that is not publicly trusted. In production, the app accepts such certificates by default, with no extra setting. If your database accepts only a plain, unencrypted connection (for example, over a private network you already trust), set `DATABASE_SSL_MODE=disable` to turn TLS off completely.
