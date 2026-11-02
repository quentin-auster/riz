#!/bin/sh
# Registers a new application in the local compose stack where alice, and only alice, can
# read document:d1. Prints the application ID. Uses the dev-only admin token.
set -eu

API="${RIZ_API_URL:-http://localhost:8080}"
AUTH="authorization: Bearer dev-admin-token"

app=$(curl -sf -X POST "$API/v1/applications" -H "$AUTH" -H "content-type: application/json" \
  -d "{\"name\":\"example$(date +%s)$$\",\"environment\":\"prod\"}" |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p') || true
# A pipeline's status is sed's, so a failed curl shows up here as an empty ID.
[ -n "$app" ] || { echo "seed: could not register an application at $API" >&2; exit 1; }

curl -sf -X POST "$API/v1/relationships" -H "$AUTH" -H "content-type: application/json" \
  -d "{\"application\":\"$app\",\"relationships\":[
    {\"subject\":\"user:alice\",\"relation\":\"viewer\",\"object\":\"project:p1\"},
    {\"subject\":\"project:p1\",\"relation\":\"project\",\"object\":\"document:d1\"}]}"

echo "$app"
