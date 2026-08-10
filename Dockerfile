# LoopTroop as a container image.
#
# Installed from the release tarball rather than from the registry, so the image
# carries the exact bytes that were packed once and published everywhere else.
# Resolving `looptroop@x.y.z` from npm instead would make this channel wait on
# the npm channel, and a release must not have channels depending on siblings.
#
# Build locally with:
#   npm pack
#   docker build --build-arg TARBALL=looptroop-0.4.1.tgz -t looptroop .
#
# ---------------------------------------------------------------------------
# Reaching the interface from the host
# ---------------------------------------------------------------------------
# The daemon binds 127.0.0.1 by default, and inside a container that means the
# container's own loopback — `-p 3000:3000` will connect to nothing. That is the
# intended default: this is a control plane that executes code on the machine it
# runs on, so it does not become network-reachable by accident.
#
# Two ways to actually use it, in order of preference:
#
#   1. Share the host's network namespace, keeping the loopback boundary real:
#        docker run --network host -v looptroop-config:/home/node/.looptroop looptroop
#
#   2. Bind wider, on purpose. The runtime refuses a non-loopback bind unless
#      both variables are set, and refuses it without a token, so there is no
#      way to end up with an open unauthenticated control API by omission:
#        docker run -p 3000:3000 \
#          -e LOOPTROOP_ALLOW_REMOTE_API=1 \
#          -e LOOPTROOP_BACKEND_HOST=0.0.0.0 \
#          -e LOOPTROOP_API_TOKEN="$(openssl rand -hex 32)" \
#          -v looptroop-config:/home/node/.looptroop looptroop
#
# Neither is baked in. An image that shipped with the escape hatch pre-set would
# hand every user the exposed configuration as the default.
#
# ---------------------------------------------------------------------------
# Mounting a project
# ---------------------------------------------------------------------------
#   docker run --network host \
#     -v looptroop-config:/home/node/.looptroop \
#     -v /path/to/project:/workspace/project \
#     looptroop
#
# The container runs as uid 1000. If your host user is a different uid, git
# refuses the mounted checkout with "detected dubious ownership". Match the uid
# instead of relaxing safe.directory in the image for everyone — but then the
# named config volume is no longer writable either, so redirect it to somewhere
# that uid owns:
#   docker run --network host --user "$(id -u):$(id -g)" \
#     -e LOOPTROOP_CONFIG_DIR=/workspace/.looptroop \
#     -v /path/to/project:/workspace/project \
#     -v "$HOME/.looptroop:/workspace/.looptroop" \
#     looptroop
#
# Commits carry their identity per invocation via `git -c`, so no global git
# config is needed. `gh` does need credentials: pass `-e GH_TOKEN=…`.
#
# ---------------------------------------------------------------------------
# What is not in the image
# ---------------------------------------------------------------------------
# OpenCode. It needs a configured model provider and credentials, which are the
# user's, and installing it here would bake a second release train into this
# one. Point the daemon at one you run:
#   -e LOOPTROOP_OPENCODE_BASE_URL=http://host.docker.internal:4096

# Pinned to the floor in `engines` rather than to `24` so the image cannot drift
# onto a runtime the package has not been tested against.
FROM node:24.15.0-bookworm-slim AS build

ARG TARBALL
WORKDIR /build

# Fail with the reason rather than with a confusing COPY error further down.
RUN test -n "$TARBALL" || (echo "ERROR: --build-arg TARBALL=<file>.tgz is required" >&2; exit 1)

COPY ${TARBALL} ./package.tgz

# --omit=dev because that is what a user gets, and into a self-contained prefix
# so the runtime stage can take the tree without npm's cache riding along.
RUN npm install --global --omit=dev --prefix /opt/looptroop ./package.tgz \
  && rm -f package.tgz


FROM node:24.15.0-bookworm-slim AS runtime

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
