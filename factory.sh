#!/usr/bin/env bash
# Kept so an existing `ff` link to factory.sh keeps working. The factory is durable/ (Pi Durable);
# its command line is durable/bin/ff.
exec "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/durable/bin/ff" "$@"
