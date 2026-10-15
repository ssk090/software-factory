#!/usr/bin/env bash
# Action: open the factory live view as an overlay over the focused pane.
exec herdr plugin pane open --plugin local.factory --entrypoint view --placement overlay
