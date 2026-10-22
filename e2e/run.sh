#!/bin/sh
# Builds this branch into a Harper 5 container next to a live HTTPS origin and runs the e2e suite.
# KEEP=1 leaves the containers running afterwards; HARPER_IMAGE overrides the Harper image.
set -eu
cd "$(dirname "$0")"

project="${E2E_PROJECT:-http-router-e2e}"
export E2E_PROJECT="$project"
compose() { docker compose -p "$project" -f docker-compose.yml "$@"; }

rm -f app/*.tgz
(cd .. && npm pack --silent --pack-destination e2e/app >/dev/null)
mv app/harperdb-http-router-*.tgz app/http-router.tgz

cleanup() { [ "${KEEP:-}" = 1 ] || compose down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT

compose up -d --build --wait
E2E_HTTP_PORT="$(compose port harper 9926 | sed 's/.*://')"
export E2E_HTTP_PORT
echo "Harper is serving on https://127.0.0.1:$E2E_HTTP_PORT"
if ! NODE_TLS_REJECT_UNAUTHORIZED=0 node --no-warnings --test e2e.test.mjs; then
	compose logs --tail 150 harper
	exit 1
fi
