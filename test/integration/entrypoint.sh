#!/bin/sh

set -eu

adapter_path=/var/lib/ghost/content/adapters/email/mailtrap
mkdir -p "$(dirname "$adapter_path")"
cp -a /opt/ghost-mailtrap-email-adapter "$adapter_path"
chown -R node:node /var/lib/ghost/content/adapters

exec docker-entrypoint.sh "$@"
