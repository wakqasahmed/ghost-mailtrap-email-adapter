#!/usr/bin/env bash
# End-to-end check: a patched Ghost 6 loads this adapter and sends a real newsletter
# to a local fake of Mailtrap's batch API. Disposable containers on tmpfs; nothing persists.

set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ghost_image="${GHOST_IMAGE:-ghost:6.53.0-alpine}"
# Wiring patches are Ghost-version specific; pick the one matching the image (default 6.53).
readonly wiring_patch="${WIRING_PATCH:-ghost-6.53-email-adapter-wiring.patch}"
readonly run_id="${RANDOM}${RANDOM}"
readonly network="mailtrap-adapter-test-${run_id}"
readonly ghost_container="mailtrap-adapter-test-ghost-${run_id}"
readonly fake_container="mailtrap-adapter-test-fake-${run_id}"
readonly image_name="mailtrap-adapter-test-ghost:${run_id}"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mailtrap-adapter-test-XXXXXX")"
readonly fake_token="fake-integration-token"

cleanup() {
    docker rm --force "$ghost_container" "$fake_container" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    docker image rm --force "$image_name" >/dev/null 2>&1 || true
    rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

build_context="$temp_dir/build-context"
mkdir -p "$build_context/patches" "$build_context/test/integration"
cp "$repo_root"/patches/ghost-6.*-email-adapter-wiring.patch "$build_context/patches/"
cp "$repo_root/test/integration/entrypoint.sh" "$build_context/test/integration/"
cp "$repo_root/test/integration/Dockerfile" "$build_context/Dockerfile"
npm pack --silent --pack-destination "$build_context" "$repo_root" >/dev/null
package_tarball="$(find "$build_context" -maxdepth 1 -name 'ghost-mailtrap-email-adapter-*.tgz' -printf '%f\n' -quit)"
[[ -n "$package_tarball" ]] || { echo 'npm pack did not produce the adapter tarball.' >&2; exit 1; }

docker build --quiet --tag "$image_name" \
    --build-arg "GHOST_IMAGE=$ghost_image" \
    --build-arg "PACKAGE_TARBALL=$package_tarball" \
    --build-arg "WIRING_PATCH=$wiring_patch" \
    --file "$build_context/Dockerfile" "$build_context" >/dev/null

docker network create "$network" >/dev/null
docker run --detach --name "$fake_container" --network "$network" --network-alias fake-mailtrap \
    --volume "$repo_root/test/integration/fake-mailtrap.py:/fake-mailtrap.py:ro" \
    python:3.12-alpine python /fake-mailtrap.py >/dev/null

docker run --detach --name "$ghost_container" --network "$network" \
    --publish 127.0.0.1::2368 \
    --tmpfs /var/lib/ghost/content:uid=1000,gid=1000,mode=0755 \
    --env NODE_ENV=production \
    --env url=http://127.0.0.1:2368 \
    --env database__client=sqlite3 \
    --env database__connection__filename=/var/lib/ghost/content/data/ghost.db \
    --env adapters__email__active=mailtrap \
    --env adapters__email__mailtrap__token="$fake_token" \
    --env adapters__email__mailtrap__apiBaseUrl=http://fake-mailtrap:8080 \
    --env adapters__email__mailtrap__fromEmail=news@example.test \
    --env security__staffDeviceVerification=false \
    "$image_name" >/dev/null

# Read the log into a variable: `docker logs | grep -q` under pipefail fails whenever grep
# exits early and docker logs gets SIGPIPE, which made boot detection flaky.
booted=false
for _ in $(seq 1 240); do  # first boot initialises the database
    ghost_log="$(docker logs "$ghost_container" 2>&1 || true)"
    if [[ "$ghost_log" == *'Ghost is running'* ]]; then
        booted=true
        break
    fi
    sleep 1
done
if [[ "$booted" != true ]]; then
    docker logs --tail 80 "$ghost_container" >&2
    echo 'Ghost did not boot.' >&2
    exit 1
fi

docker exec -i "$ghost_container" node - <<'NODE'
const adapterManagerModule = require('/var/lib/ghost/current/core/server/services/adapter-manager');
const adapter = (adapterManagerModule.default || adapterManagerModule).getAdapter('email');
if (adapter.constructor.name !== 'MailtrapEmailProvider') {
    throw new Error(`Expected MailtrapEmailProvider, received ${adapter.constructor.name}`);
}
console.log(`ADAPTER_CONSTRUCTOR=${adapter.constructor.name}`);
NODE

host_port="$(docker port "$ghost_container" 2368/tcp | head -n1 | sed 's/.*://')"
# Ghost's url is 127.0.0.1:2368 inside the container; send the matching Host header from outside.
python3 "$repo_root/test/integration/send-newsletter.py" "http://127.0.0.1:${host_port}" "http://127.0.0.1:2368" || {
    docker logs --tail 80 "$ghost_container" >&2
    exit 1
}

docker exec "$fake_container" cat /tmp/requests.jsonl > "$temp_dir/requests.jsonl"
python3 - "$temp_dir/requests.jsonl" "$fake_token" <<'PY'
import json, sys
calls = [json.loads(line) for line in open(sys.argv[1])]
assert len(calls) == 1, f"expected one batch call, got {len(calls)}"
call = calls[0]
assert call["path"] == "/api/batch", call["path"]
assert call["auth"] == f"Bearer {sys.argv[2]}", "wrong Authorization header"
assert call["agent"].startswith("ghost-mailtrap-email-adapter/"), call["agent"]
body = call["body"]
assert body["base"]["category"] == "newsletter"
assert body["base"]["subject"] == "Adapter integration post", body["base"]["subject"]
to = sorted(r["to"][0]["email"] for r in body["requests"])
assert to == ["reader-one@example.test", "reader-two@example.test"], to
for request in body["requests"]:
    assert "%%{" not in request["html"] and "%%{" not in request.get("text", ""), "unreplaced Ghost token"
import re
uuids = [set(re.findall(r"uuid=([0-9a-f-]{36})", r["html"])) for r in body["requests"]]
assert all(uuids), "an unsubscribe link without a member uuid; Ghost replacements were not applied"
assert uuids[0].isdisjoint(uuids[1]), "two members share an unsubscribe uuid; personalisation failed"
print(f"BATCH_OK requests={len(body['requests'])} from={body['base']['from']}")
PY
