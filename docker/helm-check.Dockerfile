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
FROM alpine/helm:4.3.2@sha256:a3b9d617c0c30a6c488cebb429c4ba83995a26dc2184599af5fd408a361b2e67

RUN apk add --no-cache bash

ENTRYPOINT ["/bin/bash", "-c"]
