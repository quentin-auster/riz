#!/bin/sh
# Separate database and role per service so OpenFGA and riz cannot read each other's data.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -v ofga_pw="$OPENFGA_DB_PASSWORD" -v riz_pw="$RIZ_DB_PASSWORD" <<'SQL'
CREATE ROLE openfga LOGIN PASSWORD :'ofga_pw';
CREATE DATABASE openfga OWNER openfga;
CREATE ROLE riz LOGIN PASSWORD :'riz_pw';
CREATE DATABASE riz OWNER riz;
REVOKE CONNECT ON DATABASE openfga FROM PUBLIC;
REVOKE CONNECT ON DATABASE riz FROM PUBLIC;
SQL
