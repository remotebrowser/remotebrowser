-- The guest OS a browser was launched on (src/vm/os.js). Every browser before
-- this ran on Debian 13. The default is only for those rows: a launch always
-- names its OS.
ALTER TABLE browser_instances ADD COLUMN os text NOT NULL DEFAULT 'debian-13';

ALTER TABLE browser_instances ALTER COLUMN os DROP DEFAULT;

-- When the browser was launched, in milliseconds since the epoch. Unknown for
-- the browsers from before this, so null.
ALTER TABLE browser_instances ADD COLUMN creation_timestamp bigint;
