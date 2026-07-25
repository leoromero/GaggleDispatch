-- Runs once on first container start (docker-entrypoint-initdb.d).
-- Gives the store conformance suite a database of its own so `bun test` never
-- truncates tables a running gaggle is using.
CREATE DATABASE gaggle_test OWNER gaggle;
