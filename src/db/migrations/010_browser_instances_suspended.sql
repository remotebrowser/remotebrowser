ALTER TABLE browser_instances DROP CONSTRAINT browser_instances_status_check;

ALTER TABLE browser_instances ADD CONSTRAINT browser_instances_status_check
  CHECK (status IN ('starting', 'running', 'error', 'terminated', 'suspended'));
