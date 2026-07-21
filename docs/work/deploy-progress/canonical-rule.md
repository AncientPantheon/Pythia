# Canonical rule: deployment progress must always be visibly moving

**Applies to:** every Pantheon automaton/constructor with an on-box (blue-green) Deploy
panel. Promote to the Pantheonic Architecture library (deploy standard) — owner ratifies.

## The rule

At any instant while a deploy is running, **something in the deploy box must be visibly
moving.** If motion stops, the operator can conclude the deploy is stuck — not merely on a
slow step. A silent terminal (a long `docker build` step emits nothing for minutes) is a
UX failure: "looks stuck" is indistinguishable from "is stuck."

## The three mechanisms (all required)

1. **Server heartbeat (load-bearing).** The host deployer runs a background ticker that
   appends a heartbeat line to the deploy log every ~6s for the whole run (killed on exit).
   The log therefore ALWAYS grows, so the streamed terminal always shows new lines even
   during a silent build step. If the heartbeat stops, the deployer process itself has died
   → genuinely stuck. (Pythia: `deploy/host/pythia-deploy.sh` `start_heartbeat`/`stop_heartbeat`.)

2. **Client heartbeat animation + timer.** The panel shows a looping "pacman" that chomps
   across a dot field (pure CSS, always moving while running), a ticking elapsed timer, and
   the current build step (`Step N/M`, parsed from the log). On completion it parks and
   shows the total: *"finished in Xm YYs"* (or the failure + elapsed).

3. **Stall watchdog.** The client tracks time since the last log chunk; with a 6s server
   heartbeat, healthy deploys never exceed it. If output goes silent for >20s, the panel
   reddens + pauses the animation and shows *"no output for Ns — the host deployer may have
   stopped."* This is the honest "it IS stuck" signal.

## Auto-attach

The deploy-status endpoint reports the most recent non-terminal deploy as `active`
`{ id, status, startedAt }`. On opening the panel, the client auto-attaches its progress
display to a deploy in flight — **even one it did not trigger** (another operator, or an
agent via the spool) — so a running deploy is always observable, and the timer starts from
the real `startedAt`.

## Success signature

`Deploy finished with a total deployment time of Xm YYs.` — completion always states the
total elapsed, so a deploy's cost is visible and comparable run-to-run.
