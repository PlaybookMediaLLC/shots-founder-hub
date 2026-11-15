# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.94.0

FROM rust:${RUST_VERSION}-bookworm AS planner
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --locked
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN sed -i '/^members = \[/,/^\]/c\members = ["apps/api", "crates/*"]' Cargo.toml
COPY crates crates
COPY postgres postgres
COPY apps/api/Cargo.toml apps/api/Cargo.toml
RUN mkdir -p apps/api/src && echo "fn main() {}" > apps/api/src/main.rs
RUN cargo chef prepare --recipe-path recipe.json

FROM rust:${RUST_VERSION}-bookworm AS build
ARG APP_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev libclang-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --locked
ENV APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=planner /app/recipe.json recipe.json
# cargo-chef does not include this non-workspace path dependency in its recipe.
COPY crates/tiptap/vendor crates/tiptap/vendor
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo chef cook --release --recipe-path recipe.json -p api
COPY Cargo.toml Cargo.lock ./
RUN sed -i '/^members = \[/,/^\]/c\members = ["apps/api", "crates/*"]' Cargo.toml
COPY crates crates
COPY postgres postgres
COPY packages/pricing/src/trial-policy.json packages/pricing/src/trial-policy.json
COPY apps/api apps/api
ARG GH_SHA
ENV GH_SHA=${GH_SHA}
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo clean -p progenitor-utils
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo build --locked --release -p api

FROM debian:bookworm-slim AS api-runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -d /nonexistent -s /usr/sbin/nologin -M appuser
COPY --from=build --chown=appuser:appgroup /app/target/release/api /usr/local/bin/api
USER appuser
WORKDIR /app
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/api"]

FROM api-runtime AS runtime
