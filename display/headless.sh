# shellcheck shell=bash
# Display: headless. Steps run in the background; output goes only to log files.
# Contract (every display/*.sh implements all four):
#   display_start                       once per factory process, before any ticket
#   display_ticket_start <ticket>       before a ticket's first step
#   display_run <title> <script> <log>  run the step script, block, return its exit code
#   display_ticket_end <ticket>         after a ticket's last step
#   display_stop                        stop the visible steps of this ticket (Ctrl-C, resume)
display_start() { :; }
display_ticket_start() { :; }
# In the background with wait, so a TERM or Ctrl-C reaches the factory's trap at once (bash
# holds a trap until a foreground child ends), and the trap stops the step through display_stop.
display_run() { local rc; bash "$2" >"$3" 2>&1 & STEP_PID=$!; wait "$STEP_PID"; rc=$?; STEP_PID=; return $rc; }
display_ticket_end() { :; }
display_stop() { [ -n "${STEP_PID:-}" ] && kill_tree "$STEP_PID"; STEP_PID=; return 0; }
