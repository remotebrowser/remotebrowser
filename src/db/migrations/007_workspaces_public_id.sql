ALTER TABLE workspaces ADD COLUMN public_id text NOT NULL;

CREATE UNIQUE INDEX workspaces_public_id_unique_idx ON workspaces (public_id);
