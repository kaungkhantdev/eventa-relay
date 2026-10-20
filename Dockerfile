# eventa-relay: one Dockerfile for every image of this service.
#
#   base       Node 24 and pnpm (Corepack). Every other stage starts here.
#   deps       all dependencies, installed from the lockfile
#   dev        deps + source, runs `pnpm dev`: the target the umbrella compose uses
#   build      deps + source, runs `nest build` → dist/
#   prod-deps  production dependencies only, installed in a clean stage
#   prod       base + prod-deps + dist/, as uid 1000. This is the LAST stage.
#
# The last stage is what a build without --target produces, so a plain build
# gives the production image:
#
#   docker build -t eventa-relay .                    # production
#   docker build --target dev -t eventa-relay:dev .   # watch mode (compose)
#   docker run --rm --read-only --env-file <file> eventa-relay
#
# How this image keeps the twelve factors (https://12factor.net):
#   I    Codebase      one repo, one Dockerfile. The image built from a commit is
#                      the image every environment runs (eventa-infra promotes
#                      it by tag); environments differ only in their config.
#   II   Dependencies  a pinned base image, the pnpm version from package.json's
#                      "packageManager", `--frozen-lockfile`. The prod image
#                      holds production dependencies only; no compiler, no jest.
#   III  Config        the environment only. .dockerignore keeps every .env file
#                      out of every image, and the relay needs no file to boot:
#                      @nestjs/config reads .env only if one exists.
#   IV   Backing svcs  Postgres and RabbitMQ are URLs in env (DATABASE_URL,
#                      RABBITMQ_URL), so swapping one is a config change.
#   V    Build/run     `build` compiles; `prod` copies the output and runs it.
#                      Nothing is compiled or installed when a container starts.
#   VI   Processes     stateless: the process writes nothing to its filesystem,
#                      so it runs under `docker run --read-only` and under
#                      eventa-infra's readOnlyRootFilesystem. What is published
#                      and what is not lives in outbox_events, in Postgres.
#   VII  Port binding  nothing to bind: the relay serves no requests, so there
#                      is no PORT and no EXPOSE.
#   VIII Concurrency   one process type per image: the outbox poller. It is the
#                      exception to "scale by replicas": run EXACTLY ONE until
#                      the reader takes row locks (README, "Run exactly one
#                      replica"); eventa-infra pins replicas: 1.
#   IX   Disposability exec-form CMD, so node is PID 1 and gets SIGTERM itself;
#                      main.ts stops the poll timer and closes the app. A row is
#                      marked published only after the broker confirms it, so a
#                      pass cut short is published by the next process, not lost.
#                      Boot is `node dist/main`: no install, no compile.
#   X    Dev/prod      `dev` and `prod` share the base image, the lockfile and
#                      this file; the umbrella compose runs the same backing
#                      service kinds (Postgres, RabbitMQ) as production.
#   XI   Logs          Nest's logger writes to stdout and stderr; the platform
#                      collects them. No log files.
#   XII  Admin         the relay has no admin commands of its own. Schema
#                      migrations belong to eventa-api and run from its image.

# ─── base ────────────────────────────────────────────────────────────────────
# Debian (glibc), not Alpine (musl): native packages ship prebuilt binaries per
# libc, and the glibc ones are what CI's Ubuntu runner proves. Pinned to a full
# release so that rebuilding a commit gives the same Node; move it on purpose,
# in step with CI's node-version (24).
FROM node:24.22.0-bookworm-slim AS base

# pnpm via Corepack, which ships with Node 24. The shim reads "packageManager"
# from package.json, so the image runs the pnpm this repo pins (and CI uses)
# with no second copy of the version to keep in step. A build has nobody to
# answer a download prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app

# ─── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Fetch the pinned pnpm now, at build time, so no container downloads it.
RUN corepack install

# The container must never install dependencies by itself. Before
# `pnpm <script>`, pnpm 11 checks node_modules against the lockfile and by
# default runs `pnpm install` when they differ. Under the umbrella compose the
# project directory is the read-only checkout, so that install would fail
# half-way with a file-system error. `error` stops with
# ERR_PNPM_VERIFY_DEPS_BEFORE_RUN instead, which means: dependencies changed,
# rebuild this image.
ENV pnpm_config_verify_deps_before_run=error

# Installed the way CI installs: frozen lockfile and pnpm 11's strict
# build-script policy (no dangerouslyAllowAllBuilds), so a dependency whose
# install script pnpm-workspace.yaml has not approved fails the build with
# ERR_PNPM_IGNORED_BUILDS instead of leaving a half-built node_modules.
# The pnpm store lives in a BuildKit cache, not in the image, so a rebuild
# after a dependency change only downloads what is new.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ─── dev ─────────────────────────────────────────────────────────────────────
# Watch mode, for the umbrella eventa/docker-compose.yml. That compose
# bind-mounts the live source read-only over this snapshot, so a save on the
# host recompiles here as `pnpm dev` does on the host. The snapshot means the
# image also runs on its own. .dockerignore keeps out node_modules, dist and
# every .env file.
FROM deps AS dev
COPY . .
# No EXPOSE: the relay answers no requests.
CMD ["pnpm", "dev"]

# ─── build ───────────────────────────────────────────────────────────────────
# nest build → dist/. Only what it reads, so an edit to a document does not
# invalidate the production build. The relay has no tsconfig.build.json, so
# nest compiles with tsconfig.json; src/ is the only TypeScript copied in, so
# the entry point is dist/main.js.
FROM deps AS build
COPY nest-cli.json tsconfig.json ./
COPY src ./src
RUN pnpm build

# ─── prod-deps ───────────────────────────────────────────────────────────────
# A clean install of "dependencies" alone. Pruning the full install would work
# too; installing afresh leaves no doubt that nothing from devDependencies (or
# their hoisted transitive packages) survives into production. The first two
# steps are the same instructions on the same parent as in `deps`, so BuildKit
# runs them once for both.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# ─── prod ────────────────────────────────────────────────────────────────────
# Compiled JavaScript and production dependencies, nothing else: no source, no
# TypeScript, no pnpm store, no .env. The files stay owned by root, so the
# process can read its code and cannot change it.
FROM base AS prod
# The runtime mode the config schema validates; eventa-infra sets it too.
ENV NODE_ENV=production
# Nest's console logger colours its output unless NO_COLOR is set. A log
# collector stores those escape codes as text, so the image turns them off.
ENV NO_COLOR=1
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The node image's `node` user, by number: Kubernetes' runAsNonRoot can only
# verify a numeric user, and eventa-infra's pod securityContext runs as
# 1000:1000.
USER 1000:1000

# No EXPOSE and no HEALTHCHECK: nothing listens, and a check that only proves
# the process is running would report a relay that has stopped publishing as
# healthy. Watch outbox lag in Postgres instead (README, "Health").

# Exec form: node itself is PID 1, so SIGTERM reaches it (IX). `pnpm start:prod`
# would put pnpm in between and need it in the image.
CMD ["node", "dist/main"]
