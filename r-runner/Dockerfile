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

# On-demand runtime installs (plumber.R's install_missing_packages, see its
# doc comment): configure this image's default repos to Posit Package
# Manager's (P3M, formerly RSPM) binary CRAN mirror, so a package a user
# names in a customized preset installs as a precompiled binary in seconds
# rather than a source build that could take minutes and blow the <=90s
# install budget. Absolutely NEVER remotes/GitHub/arbitrary-URL installs --
# P3M's own CRAN-compatible endpoint is the only repo this image ever points
# at, for BOTH the baked-in catalog above (unpinned public CRAN, left as-is
# -- a one-time build-time cost, not latency-sensitive) and runtime installs
# below (where binary-vs-source is the whole point).
#
# Checked what rocker already configures first, per this feature's own
# review requirement, rather than guessing: rocker-versioned2's own
# setup_R.sh (the script rocker-org's Dockerfiles use to build r-ver, which
# rocker/tidyverse extends) DOES write an options(repos=...) +
# options(HTTPUserAgent=...) pair into Rprofile.site pointing at P3M, but
# ONLY when its CRAN build-arg is explicitly a P3M-shaped URL -- confirmed
# by reading that script directly (github.com/rocker-org/rocker-versioned2,
# scripts/setup_R.sh: `echo "options(repos = c(CRAN = '${CRAN}'), ...)"`,
# defaulting to plain https://cran.r-project.org when no such arg is given).
# rocker-versioned2's README states RSPM/P3M IS the project's default CRAN
# mirror for its own published tags, which makes it LIKELY rocker/tidyverse
# already has this -- but that could not be confirmed inside this EXACT
# image (rocker/tidyverse:4.4.3) without Docker, which this environment does
# not have (see README.md's verification section). Rather than ship a
# feature whose core safety property (binary-only, no compilation) rests on
# an unverified assumption, this sets it EXPLICITLY below -- appended after
# whatever the base image already wrote to the same Rprofile.site, so
# these lines are the ones actually in effect at runtime regardless of
# what the base image did or didn't already do.
#
# Codename is resolved from the image's own /etc/os-release at BUILD time
# (VERSION_CODENAME -- present on both Debian and Ubuntu, the same field
# rocker's own setup_R.sh keys off of via UBUNTU_CODENAME) rather than
# hardcoded, since the exact Debian/Ubuntu release this specific tag is
# built on could not be confirmed without pulling the image. "latest" (a
# rolling snapshot, not a dated one) is deliberate: the whole point of this
# feature is installing packages NOT already baked into the image, so a
# frozen build-time-dated snapshot would go stale exactly where it matters
# most -- a package published to CRAN after that snapshot date would never
# resolve.
#
# The Rprofile.site PATH itself is also resolved dynamically (via
# R.home("etc"), confirmed to print a clean single-line path with no
# banner noise via `Rscript -e`) rather than hardcoded to
# /usr/local/lib/R/etc -- that IS the standard R_HOME for a source-compiled
# R (which is how rocker builds R; confirmed by reading rocker-versioned2's
# install_R_source.sh, `R_HOME=${R_HOME:-"/usr/local/lib/R"}`), but resolving
# it live removes any dependency on that holding for this exact tag.
#
# The options(HTTPUserAgent=...) line is NOT cosmetic -- P3M's binary
# endpoint identifies the caller's R version/OS/arch from THIS header
# (see Posit's own docs: "Binaries: R Configuration (Linux)",
# docs.posit.co/rspm/admin/serving-binaries) and silently falls back to
# serving SOURCE packages without it, which would defeat the entire point
# of pointing at a binary mirror. (P3M can ALSO fall back to source, on its
# own server side, for some obscure package with no binary build available
# at all, even with this header set correctly -- plumber.R's install
# timeout treats that the same as any other slow install: bounded by the
# shared budget, never a hang.)
RUN . /etc/os-release && \
    codename="${VERSION_CODENAME:-focal}" && \
    r_profile_site="$(Rscript -e 'cat(file.path(R.home("etc"), "Rprofile.site"))')" && \
    printf '%s\n' \
      "options(repos = c(CRAN = \"https://packagemanager.posit.co/cran/__linux__/${codename}/latest\"), download.file.method = \"libcurl\")" \
      "options(HTTPUserAgent = sprintf(\"R/%s R (%s)\", getRversion(), paste(getRversion(), R.version[\"platform\"], R.version[\"arch\"], R.version[\"os\"])))" \
      >> "${r_profile_site}" && \
    cat "${r_profile_site}"

COPY plumber.R /app/plumber.R
WORKDIR /app

ENV PORT=8080
EXPOSE 8080

CMD ["R", "-e", "plumber::pr_run(plumber::pr('/app/plumber.R'), host='0.0.0.0', port=as.integer(Sys.getenv('PORT')))"]
