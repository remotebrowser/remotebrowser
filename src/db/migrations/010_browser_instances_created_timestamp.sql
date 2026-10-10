ALTER TABLE browser_instances
  ADD COLUMN created_timestamp bigint NOT NULL DEFAULT (floor(extract(epoch FROM now()) * 1000))::bigint;
