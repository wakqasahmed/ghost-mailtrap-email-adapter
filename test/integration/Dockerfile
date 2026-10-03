ARG GHOST_IMAGE=ghost:6.53.0-alpine
FROM ${GHOST_IMAGE}

ARG PACKAGE_TARBALL

USER root

RUN apk add --no-cache git

ARG WIRING_PATCH=ghost-6.53-email-adapter-wiring.patch
COPY patches/${WIRING_PATCH} /tmp/ghost-email-adapter.patch
COPY ${PACKAGE_TARBALL} /tmp/ghost-mailtrap-email-adapter.tgz
COPY test/integration/entrypoint.sh /usr/local/bin/mailtrap-adapter-test-entrypoint

RUN cd /var/lib/ghost/current \
    && git apply /tmp/ghost-email-adapter.patch \
    && mkdir -p /opt/ghost-mailtrap-email-adapter \
    && tar -xzf /tmp/ghost-mailtrap-email-adapter.tgz --strip-components=1 -C /opt/ghost-mailtrap-email-adapter \
    && npm install --omit=dev --prefix /opt/ghost-mailtrap-email-adapter \
    && chmod +x /usr/local/bin/mailtrap-adapter-test-entrypoint

ENTRYPOINT ["mailtrap-adapter-test-entrypoint"]
CMD ["node", "current/index.js"]
