# Helm plus bash, for the chart checks in `compose.ci.yaml` and `scripts/check.sh`.
#
# The upstream `alpine/helm` image is Alpine and has no bash, and `test/render.sh` uses
# bash herestrings deliberately — they keep the output of a `helm template` in a variable
# instead of running the command again for every assertion. One small layer buys that back
# without asking every contributor to install bash on their machine.
# Tag `alpine/helm:4.2.4` resolved to this index digest; the digest covers every
# platform, so the build works on amd64 and arm64 alike. Re-resolve when the Helm
# version the chart is checked against changes, and keep it equal to the tarball
# `ci.yml` installs so a local check and CI run the same binary.
FROM alpine/helm:4.3.1@sha256:e3f8d5c462d75470fbb1fce79ad5c20063657096d1f98c0fcea869e2600e2e5e

RUN apk add --no-cache bash

ENTRYPOINT ["/bin/bash", "-c"]
