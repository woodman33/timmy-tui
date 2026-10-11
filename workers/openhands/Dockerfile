# Timmy's OpenHands worker image (round R4, helper H52): python 3.12 slim, git, and the OpenHands SDK and tools
# pinned to 1.21.0. No browser and no Chromium: Timmy's worker gives the agent the terminal and the file editor only.
#
# Timmy never builds or pulls this image by itself (`docker run --pull never`). Build it once, from Timmy's package root:
#
#   docker build -t timmy-openhands:1.21.0 -f workers/openhands/Dockerfile workers/openhands
#
# The worker script (timmy_openhands.py) is not copied in: Timmy mounts a copy of it read-only at /timmy at each run,
# so a changed worker needs no new image. Timmy checks the label below before it starts a run, so an image built from
# something else under the same tag is refused.
FROM python:3.12-slim

LABEL timmy.openhands.sdk="1.21.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# pip's resolver was seen failing on this set (the lmnr and opentelemetry conflict noted in scripts/oh-runner.Dockerfile,
# the older Command Post runner); uv resolves it. Only the two OpenHands packages are pinned here; uv picks their
# dependencies, as the older runner's did. Unlike that runner, this image has no openhands-workspace (the worker runs the
# SDK's own local workspace at /work), no Playwright or Chromium, and no Node or npm: the agent cannot run npm in it.
RUN pip install --no-cache-dir uv \
    && uv pip install --system --no-cache-dir openhands-sdk==1.21.0 openhands-tools==1.21.0

WORKDIR /work
