ALTER TABLE users ADD COLUMN public_id text NOT NULL;

CREATE UNIQUE INDEX users_public_id_unique_idx ON users (public_id);
