ALTER TABLE browser_instances ADD COLUMN public_id text NOT NULL;

CREATE UNIQUE INDEX browser_instances_public_id_unique_idx ON browser_instances (public_id);
