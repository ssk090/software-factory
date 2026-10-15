# Everything the factory needs, so any machine with Docker can run it.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl jq python3 perl procps ca-certificates openssh-client gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    # Docker client only: on a server the factory starts one agent container per step on the host's Docker
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz" \
       | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Agent CLIs used by router.json: Codex, Claude Code, OpenCode, pi (npm) and Cursor (its installer).
# Pinned, so a rebuild gets the CLIs that were tested. To upgrade: bump a version, rebuild, run
# tests/e2e.sh docker. Cursor's installer has no version pin.
ARG AGENT_PACKAGES="@openai/codex@0.162.1 @anthropic-ai/claude-code@2.1.300 opencode-ai@1.19.0 @earendil-works/pi-coding-agent@1.2.0"
RUN npm install -g $AGENT_PACKAGES \
    && curl -fsSL https://cursor.com/install | bash
ENV PATH="/root/.local/bin:$PATH"

COPY . /factory
WORKDIR /factory
ENTRYPOINT ["/factory/docker-entrypoint.sh"]
CMD ["daemon"]
