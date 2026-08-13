-- ────────────────────────────────────────────────────────────────────────────
-- Bootstrap: extensions and the UUIDv7 generator.
--
-- Must run before the initial schema, which uses uuid_generate_v7() as the
-- default for every primary key.
--
-- Postgres gains a native uuidv7() in 18; this function is the stand-in until
-- the cluster is on a version that has it. Same layout (RFC 9562): 48-bit
-- big-endian Unix milliseconds, version nibble, then randomness — so ids sort
-- by creation time and index like a sequence, without leaking row counts the
-- way a serial primary key does.
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);

  -- 10 random bytes for the remainder of the value.
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);

  -- Version 7: high nibble of byte 6.
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);

  -- RFC 9562 variant: top two bits of byte 8 set to 10.
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$
LANGUAGE plpgsql
VOLATILE;

COMMENT ON FUNCTION uuid_generate_v7() IS
  'Time-ordered UUIDv7 (RFC 9562). Replace with native uuidv7() on PostgreSQL 18+.';
