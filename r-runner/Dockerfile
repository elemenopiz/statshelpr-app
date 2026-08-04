# r-runner/Dockerfile
#
# Cloud Run service that executes R scripts for the statshelpr Worker (see
# docs/cloud-run-r-migration.md section 2). One R process per container --
# Cloud Run absorbs concurrent load by running more containers, not by
# threading inside R (see README.md, --concurrency 1).
#
# Base image tag verified to exist on Docker Hub as of 2026-07-23 via
# https://hub.docker.com/v2/repositories/rocker/tidyverse/tags/?name=4&page_size=25 :
#   rocker/tidyverse:4.4.3 -- an R 4.4.x point release first published
#   2026-03-11, so it has several months of real-world usage behind it. The
#   newer 4.6.x line was also present (4.6.1, published 2026-07-22 -- the day
#   before this file was written) but was passed over here for having no
#   meaningful soak time yet; nothing in this image's package list needs
#   anything newer than R 4.4. tidyverse, ggplot2, and broom are already
#   compiled into this base image.
FROM rocker/tidyverse:4.4.3

# R package catalog for the runner. This is the source of truth for what the
# extension's library picker can select and actually have run — KEEP IN SYNC
# with apps/extension/src/r-packages.ts's INSTALLED_CATALOG. The base image
# (rocker/tidyverse) already ships tidyverse, ggplot2, broom, MASS, and knitr,
# so those are NOT reinstalled here; the intro-stats core (mosaic/moderndive/
# infer) is added below. MatchIt and effectsize are also added: the tutor's
# stats-reference prompt (packages/solver-core/src/core/stats-reference.ts)
# already directs the model to use both (matching on confounders in L12;
# eta_squared() effect size in L15), so without them here the model would
# generate code against a package that was never installed. INFRA (openssl/
# base64enc for the data-file handling, plumber for the HTTP layer) rounds
# out the vector.
#
# Kept deliberately to the small intro-stats core we actually use, NOT a broad
# cross-curriculum catalog. Broadening the pre-baked set (so the picker could
# offer more packages across courses/universities) was considered and DEFERRED
# — revisit only when real usage shows demand. A package the user types that
# isn't installed here is flagged in the picker and simply won't run.
#
# System libraries the STATS packages need (openssl/xml2/curl/fontconfig/
# freetype/harfbuzz/fribidi/png/tiff/jpeg-devel) are already compiled into
# rocker/tidyverse to support tidyverse's own deps (httr/curl/xml2/ragg etc.)
# — but plumber's dependency chain (plumber -> sodium) additionally needs
# libsodium headers, which the base image does NOT ship. Without the apt-get
# below, sodium fails to configure ("fatal error: sodium.h: No such file or
# directory"), plumber fails with it, and the stopifnot() guard fails the
# build — exactly what happened on the first real Cloud Build (2026-07-23).
RUN apt-get update && apt-get install -y --no-install-recommends libsodium-dev && rm -rf /var/lib/apt/lists/*

#
# install.packages() does NOT make `docker build` fail just because one
# package failed to install -- by default it prints a warning and moves on,
# which would otherwise leave a broken image that only fails once the first
# request needs the missing package. stopifnot(...) below asserts every
# requested package actually landed in the library, so a broken install fails
# the build loudly instead.
RUN R -e "pkgs <- c('mosaic', 'moderndive', 'infer', 'MatchIt', 'effectsize', 'openssl', 'base64enc', 'plumber'); install.packages(pkgs, repos = 'https://cloud.r-project.org', Ncpus = 4); stopifnot(all(pkgs %in% rownames(installed.packages())))"

COPY plumber.R /app/plumber.R
WORKDIR /app

ENV PORT=8080
EXPOSE 8080

CMD ["R", "-e", "plumber::pr_run(plumber::pr('/app/plumber.R'), host='0.0.0.0', port=as.integer(Sys.getenv('PORT')))"]
