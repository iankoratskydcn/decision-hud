#!/usr/bin/env sh
set -eu
: "${DASHBOARD_TEST_DATABASE_URL:?DASHBOARD_TEST_DATABASE_URL is required}"
exec uv run --project . python -c 'import os, time; import psycopg; url=os.environ["DASHBOARD_TEST_DATABASE_URL"]; deadline=time.time()+60
while time.time()<deadline:
    try:
        with psycopg.connect(url): print("postgres ready"); break
    except psycopg.OperationalError: time.sleep(1)
else: raise SystemExit("PostgreSQL readiness timeout")'
