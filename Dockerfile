# Everything the factory needs, so any machine with Docker can run it. The same image is the
# sandbox: in SANDBOX=docker each ticket's agent commands run in a container of it.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq python3 perl procps ca-certificates openssh-client gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    # Docker client only: on a server the factory starts one sandbox container per ticket on the host's Docker
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz" \
       | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    # Pi Durable needs Node 22.19 or newer
    && node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 19)) { console.error(`node ${process.versions.node} is too old`); process.exit(1); }'

# The factory's core: Pi Durable and pi-ai, pinned by durable/package-lock.json.
COPY durable/package.json durable/package-lock.json /factory/durable/
RUN cd /factory/durable && npm ci --omit=dev --no-audit --no-fund

COPY . /factory
WORKDIR /factory
RUN ln -s /factory/durable/bin/ff /usr/local/bin/ff
ENTRYPOINT ["/factory/docker-entrypoint.sh"]
CMD ["serve"]
