---
name: openclaw-status-live
description: Live openclaw gateway + channel status. Use when diagnosing service issues, after restarts, or before acting on gateway-dependent changes.
paths:
  - "src/gateway/**"
  - "src/channels/**"
  - "extensions/**"
---

# OpenClaw Status — Live

## Current Gateway Status

!`openclaw gateway status --deep --require-rpc 2>&1 | head -30`

## Channel Status

!`openclaw channels status --probe 2>&1 | head -40`

## Recent Gateway Log

!`tail -n 40 /tmp/openclaw-gateway.log 2>/dev/null || echo "no local gateway log"`

---

Rules when acting on this output:

- If gateway is down, fix the gateway first — do not layer application-level fixes on top of a dead gateway.
- `--require-rpc` failures are probe failures; treat as hard errors.
- Channel `status=disabled` is often intentional (extension not enabled) — verify before alarming.
