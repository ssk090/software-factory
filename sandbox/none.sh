# shellcheck shell=bash
# Sandbox: none. Each step runs directly on this machine.
# Contract (every sandbox/*.sh implements both):
#   sandbox_check                  return non-zero (and log why) if this sandbox cannot run
#   sandbox_cmd <name> <cwd> <cmd> print a bash script that runs <cmd> in <cwd> within
#                                  $AGENT_TIMEOUT and exits with its exit code. $PROMPT is set.
#                                  $AGENT_AUTH / $AGENT_ENV list the agent's login files and keys.
sandbox_check() { :; }

sandbox_cmd() {
  printf 'cd %q && exec perl -e %q %q bash -c %q\n' "$2" 'alarm shift; exec @ARGV' "$AGENT_TIMEOUT" "$3"
}
