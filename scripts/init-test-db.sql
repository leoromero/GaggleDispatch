-- Runs once on first container start (docker-entrypoint-initdb.d).
--
-- Two test databases, deliberately separate:
--   gaggle_test       — general scratch
--   gaggle_exec_test  — the executor's store conformance suite, which wipes
--                       every table it owns between tests. It needs a database
--                       nothing else writes to; sharing one with another
--                       branch's schema produced table-name collisions.
CREATE DATABASE gaggle_test OWNER gaggle;
CREATE DATABASE gaggle_exec_test OWNER gaggle;
