-- riz metadata. OpenFGA relationship tuples are never copied here.

CREATE TABLE applications (
  id          text PRIMARY KEY,
  name        text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  environment text NOT NULL CHECK (environment ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  -- Resolved server-side per application and environment; never taken from a request.
  store_id    text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, environment),
  CHECK (id = name || '-' || environment)
);

-- Every model write is a new immutable ID; the active row is the pin. Prior rows are history.
CREATE TABLE model_bindings (
  id             bigserial PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications (id),
  model_id       text NOT NULL,
  active         boolean NOT NULL DEFAULT false,
  bound_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, model_id)
);
CREATE UNIQUE INDEX model_bindings_one_active
  ON model_bindings (application_id) WHERE active;

-- Non-secret provider settings only; credentials are not stored here.
CREATE TABLE provider_configs (
  id             bigserial PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications (id),
  provider       text NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, provider)
);

-- No foreign key: audit history must outlive and never block changes to applications.
CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  time           timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,
  action         text NOT NULL,
  application_id text,
  outcome        text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  request_id     text,
  detail         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_time ON audit_events (time DESC);
CREATE INDEX audit_events_application ON audit_events (application_id, time DESC);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END
$$;

CREATE TRIGGER audit_events_no_change
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
