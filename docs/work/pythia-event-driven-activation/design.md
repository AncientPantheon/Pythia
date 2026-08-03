# pythia-event-driven-activation — Design

## Problem (operator-reported, live)

The `dual-link-activate` cronoton was meant to be **scheduleless and event-driven** — fire ONLY on a
link event (a consumer's two Apollo halves become verified), never on a timer. In practice it wasn't:
what got built was event-driven *payload resolution* (the `serverResolver: "dual-link-activate"` tag
means the resolver pulls the ready pair at fire time), but the **fire TRIGGER** was left on Khronoton's
schedule tick — the loop only fires a row when its `next_fire_at` is due. So a verified pair sat in the
tracker until the cronoton's schedule came around (hours, if the interval was long), and manual "Fire"
from the admin is a one-off, not the intended autonomy. The operator correctly rejected "just set a
2-minute schedule" as polling, not event-driven.

## Approach

Wire the **link event itself** to fire the cronoton immediately, in-process:

- `PendingActivationTracker` gains an `onPairReady` hook, invoked the instant a pair transitions to
  fully-proven (the second `recordProof`), plus a pure `hasReadyPair()` check. The hook call is
  wrapped so a subscriber error can never break proof recording.
- A new `dualLinkActivateTrigger.ts` (automaton core) subscribes: on the event it fires the
  scheduleless cronoton via the SAME `executeNow` path the admin Fire button uses (find the row by
  `findCodexCronotonIdByServerResolver("dual-link-activate")` → `executeNow` → resolve → safety-simulate
  → submit `A_LinkDualApiKey` → settle). A **single-flight drain loop** drains every ready pair
  one-by-one, gated on `hasReadyPair()` so an empty queue never fires a blank tx, and stops on the first
  non-success so a failing tx isn't a busy-loop and the pair stays ready for the next event.
- `register.ts` wires it at engine start (skipped under `KHRONOTON_DISABLED`).

The cronoton becomes **scheduleless**: it exists only as the on-chain template (pact code + gas payer);
the event fires it. Khronoton's tick no longer needs to fire it at all.

**Keyless preserved.** The keyless request path (`connectorVerify.ts`) only calls `recordProof` — it
never imports the automaton core. The tracker calls a callback (no automaton import). Only the
automaton side (`register.ts` → `dualLinkActivateTrigger.ts`) reaches signing. Pythia's request path
still never holds a key or signs; a verified proof *triggers* the sealed-codex fire, it doesn't perform
it. This is the same trust boundary as before — only the trigger moved from the scheduler to the event.

Alternatives rejected: a short recurring schedule (polling, not event-driven — operator rejected);
firing straight from the resolver (the resolver only supplies the payload at fire time, it isn't a
trigger); a push from `connectorVerify` (would import the automaton core into the keyless path).

## Acceptance criteria

- [x] A pair becoming fully proven fires `A_LinkDualApiKey` immediately, with no schedule and no tick
      dependency (`dualLinkActivateTrigger.test.ts` + `pendingActivationTracker.test.ts`).
- [x] The `onPairReady` hook fires exactly once per pair (on the completing proof), never on a single
      half or a re-proof; a throwing subscriber never breaks `recordProof`.
- [x] `hasReadyPair()` gates the trigger so an empty queue never fires a blank `A_LinkDualApiKey`.
- [x] The drain is single-flight (concurrent events don't double-fire the same row) and stops on the
      first non-success (the pair stays ready, retried on the next event).
- [x] Keyless invariant intact (the keyless scanner + isolation scan stay green).

## Out of scope

- Any on-chain / Pact change.
- Removing the manual admin Fire button or the tick loop (both remain; the cronoton is simply
  scheduleless, so the tick has nothing due to fire and the event is the trigger).

## Operator note

The `dual-link-activate` cronoton must exist (the template) but needs **NO schedule** — leave it
scheduleless/manual. Verifying a pair now fires it on the spot.
