# LoopTroop as a container image.
#
# Installed from the release tarball rather than from the registry, so the image
# carries the exact bytes that were packed once and published everywhere else.
# Resolving `looptroop@x.y.z` from npm instead would make this channel wait on
# the npm channel, and a release must not have channels depending on siblings.
#
# Build locally with:
#   npm pack
#   version="$(node -p 'require("./package.json").version')"
#   docker build \
#     --build-arg TARBALL="looptroop-${version}.tgz" \
#     --build-arg VERSION="${version}" \
#     --build-arg REVISION="$(git rev-parse HEAD)" \
#     -t looptroop .
#
# The version is read rather than typed for the same reason CI reads it: a
# literal here goes stale on the next release and nothing would notice. VERSION
# and REVISION only fill in the OCI labels, but they are not optional in
# practice: scripts/smoke-container.mjs asserts both are populated, because an
# image that cannot say which commit it came from is one nobody can debug in
# production.
#
# ---------------------------------------------------------------------------
# It does not start without an OpenCode server
# ---------------------------------------------------------------------------
# A bare `docker run` of this image exits instead of starting. That is not a
# defect in the build: OpenCode is deliberately absent (see below), `live` is the
# default mode, and the daemon treats a missing OpenCode as fatal before it binds
# a port — a half-started daemon that cannot run a single coding operation is
# worse than one that refuses. So every run needs one of:
#
#   -e LOOPTROOP_OPENCODE_BASE_URL=http://host.docker.internal:4096
#       Point it at a server you run. This is the real configuration.
#
#   -e LOOPTROOP_OPENCODE_MODE=mock
#       No OpenCode at all. Enough to look around the interface and to run
#       `doctor`; no coding work will execute.
#
# Neither is baked in: an image that defaulted to mock would look healthy while
# being unable to do the one thing it is for.
#
# ---------------------------------------------------------------------------
# Reaching the interface from the host
# ---------------------------------------------------------------------------
# The daemon binds 127.0.0.1 by default, and inside a container that means the
# container's own loopback — a published port will connect to nothing. That is
# the intended default: this is a control plane that executes code on the machine
# it runs on, so it does not become network-reachable by accident.
#
# Two ways to actually use it, in order of preference:
#
#   1. Share the host's network namespace, keeping the loopback boundary real:
#        docker run --network host \
#          -e LOOPTROOP_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
#          -v looptroop-config:/home/node/.looptroop looptroop
#
#      Linux only. On Docker Desktop for Mac and Windows the containers run in a
#      VM, so `--network host` is that VM's loopback and not yours; use option 2.
#
#   2. Bind wider, on purpose. The runtime refuses a non-loopback bind unless
#      both variables are set, and refuses it without a token, so there is no
#      way to end up with an open unauthenticated control API by omission:
#        docker run -p 127.0.0.1:3000:3000 \
#          -e LOOPTROOP_ALLOW_REMOTE_API=1 \
#          -e LOOPTROOP_BACKEND_HOST=0.0.0.0 \
#          -e LOOPTROOP_API_TOKEN="$(openssl rand -hex 32)" \
#          -e LOOPTROOP_OPENCODE_BASE_URL=http://host.docker.internal:4096 \
#          -v looptroop-config:/home/node/.looptroop looptroop
#
#      `-p 127.0.0.1:3000:3000`, not `-p 3000:3000`: the short form publishes on
#      every host interface, which on a laptop on a shared network hands the port
#      to everyone on it. The container binds 0.0.0.0 because it has to reach
#      across the container boundary; the host side stays on loopback.
#
#      LOOPTROOP_API_TOKEN is what authorises that wider bind. It is not the
#      token the API accepts — the daemon mints its own credentials at startup
#      and records them owner-only. Read the one that works with:
#        docker exec <container> sh -c 'cat "$LOOPTROOP_CONFIG_DIR/daemon.json"'
#
# Neither is baked in. An image that shipped with the escape hatch pre-set would
# hand every user the exposed configuration as the default.
#
# ---------------------------------------------------------------------------
# Mounting a project
# ---------------------------------------------------------------------------
# At its own absolute path, not a tidy one. LoopTroop hands OpenCode the
# worktree path under <project>/.looptroop/worktrees/, and an OpenCode running
# outside this container has to be able to open that exact string.
#   docker run --network host \
#     -e LOOPTROOP_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
#     -v looptroop-config:/home/node/.looptroop \
#     -v "$PROJECT":"$PROJECT" -w "$PROJECT" \
#     looptroop
#
# The container runs as uid 1000. If your host user is a different uid, git
# refuses the mounted checkout with "detected dubious ownership". Match the uid
# instead of relaxing safe.directory in the image for everyone — but then the
# named config volume is no longer writable either, so redirect it to somewhere
# that uid owns:
#   docker run --network host --user "$(id -u):$(id -g)" \
#     -e HOME=/tmp \
#     -e LOOPTROOP_CONFIG_DIR=/workspace/.looptroop \
#     -e LOOPTROOP_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
#     -v "$PROJECT":"$PROJECT" -w "$PROJECT" \
#     -v "$HOME/.looptroop:/workspace/.looptroop" \
#     looptroop
#
# HOME=/tmp because /home/node belongs to uid 1000, and anything that looks for a
# home directory should not find one it cannot write to.
#
# Commits carry their identity per invocation via `git -c`, so no global git
# config is needed. `gh` does need credentials: pass `-e GH_TOKEN=…`, which the
# push also uses through `gh auth git-credential` — git does not read GH_TOKEN
# on its own, and nothing else here supplies a credential.
#
# ---------------------------------------------------------------------------
# What is not in the image
# ---------------------------------------------------------------------------
# OpenCode. It needs a configured model provider and credentials, which are the
# user's, and installing it here would bake a second release train into this
# one. Point the daemon at one you run, as above.

# Pinned to the floor in `engines` rather than to `24` so the image cannot drift
# onto a runtime the package has not been tested against, and by digest as well
# as by tag: a tag is a mutable pointer, so two builds of the same commit can
# otherwise disagree about what they were built on. The digest is the multi-arch
# index, so one value serves both amd64 and arm64. Renovate updates it.
FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

ARG TARBALL
WORKDIR /build

# Fail with the reason rather than with a confusing COPY error further down.
RUN test -n "$TARBALL" || (echo "ERROR: --build-arg TARBALL=<file>.tgz is required" >&2; exit 1)

COPY ${TARBALL} ./package.tgz

# --omit=dev because that is what a user gets, and into a self-contained prefix
# so the runtime stage can take the tree without npm's cache riding along.
RUN npm install --global --omit=dev --prefix /opt/looptroop ./package.tgz \
  && rm -f package.tgz


FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

# Passed by the build so the image can say what it is without a second source of
# truth for the version. Declared here rather than at the top because build args
# are per-stage.
ARG VERSION
ARG REVISION

# `source` is what makes GHCR attach this package to the repository and inherit
# its README, so it is load-bearing rather than decorative. The rest is what a
# registry UI and `docker inspect` show, and what an operator reads off a running
# container to find out exactly which build it is.
LABEL org.opencontainers.image.title="LoopTroop" \
  org.opencontainers.image.description="Local AI coding orchestration for repo-scale work: LLM-council planning, Ralph-loop recovery, isolated OpenCode worktrees, and human-gated PR delivery." \
  org.opencontainers.image.source="https://github.com/looptroop-ai/LoopTroop" \
  org.opencontainers.image.url="https://www.looptroop.ovh/" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${REVISION}"

# git is a hard requirement — LoopTroop works in worktrees, and `doctor` fails
# without it. gh is what the pull-request phase drives, so an image without it
# would complete the work and then be unable to ship it. ca-certificates for
# HTTPS to model providers, openssh-client for git remotes over ssh.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ca-certificates \
    curl \
    git \
    gnupg \
    openssh-client \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install --no-install-recommends -y gh \
  && apt-get purge -y gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/looptroop /opt/looptroop
RUN ln -s /opt/looptroop/bin/looptroop /usr/local/bin/looptroop

# What tells the CLI it is in a container, so `doctor` reports the container
# channel and offers `docker pull` rather than `npm install -g` — a command that
# would upgrade a tree the next `docker run` throws away. Nothing outside an
# image sets this. It also outranks the channel recorded in the config volume,
# which can have been written by an npm install before the volume was mounted
# here; see resolveInstallInfo in server/lib/installChannel.ts.
ENV LOOPTROOP_CONTAINER=1

# The `node` user ships with the base image at uid 1000. Running as root would
# mean every file the agent writes into a mounted project lands root-owned on
# the host, and this process runs a coding agent with full local execution.
ENV LOOPTROOP_CONFIG_DIR=/home/node/.looptroop
RUN mkdir -p "$LOOPTROOP_CONFIG_DIR" \
  && chown -R node:node "$LOOPTROOP_CONFIG_DIR" \
  && chmod 700 "$LOOPTROOP_CONFIG_DIR"

# Where projects are expected to be mounted, so a bare `docker run` has a
# sensible working directory instead of `/`.
WORKDIR /workspace
RUN chown node:node /workspace

USER node

# The config directory holds daemon.json, which carries the API token, and the
# database. Without a volume, every restart is a fresh install.
VOLUME ["/home/node/.looptroop"]

EXPOSE 3000

# Runs inside the container's own namespace, so it reaches a loopback bind and a
# wider one alike. `--version` would only prove the shim runs; this asks the
# daemon whether it is serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${LOOPTROOP_BACKEND_PORT:-3000}/api/health" || exit 1

# Foreground, not the detached `start`: a daemon that forks and returns would
# exit the container immediately, and the supervising job here belongs to
# Docker. Overridable — `docker run … looptroop doctor` still works.
ENTRYPOINT ["looptroop"]
CMD ["start", "--foreground"]
