-- Which applications a workload may check against. A workload with no row
-- here can check nothing. Bindings carry no rights beyond `check`.
CREATE TABLE workload_bindings (
  issuer         text NOT NULL,
  workload       text NOT NULL,
  application_id text NOT NULL REFERENCES applications (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, workload, application_id)
);
