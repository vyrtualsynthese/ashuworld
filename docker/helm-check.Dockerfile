# Helm plus bash, for the chart checks in `compose.ci.yaml` and `scripts/check.sh`.
#
# The upstream `alpine/helm` image is Alpine and has no bash, and `test/render.sh` uses
# bash herestrings deliberately — they keep the output of a `helm template` in a variable
# instead of running the command again for every assertion. One small layer buys that back
# without asking every contributor to install bash on their machine.
FROM alpine/helm:latest

RUN apk add --no-cache bash

ENTRYPOINT ["/bin/bash", "-c"]
