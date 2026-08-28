# Multi-Action Sequential Attacks — Design

**Status:** design, not yet implemented (2026-08-22)
**Source of truth** for the multi-action feature. Update this file when decisions change.

---

## 1. Goal

Let one sequential-attack window resolve attacks from **more than one action** — the
claw/claw/bite case — and let the attacker choose the order those attacks resolve in,
subject to one restriction (§3).

Today the module wraps a single `ActionUse.prototype.process()` and everything hangs off
that one `actionUse` and its `shared`. Multi-action means **one `ActionUse` per action**
with a coordinator above them.

### Non-goals (for now)

- Saved attack groups / presets — Phase 2, see §10.
- Enforcing "one full attack per round." Nothing stops a user running the sequence twice.
- Cross-action rules validation (natural vs. manufactured, TWF legality, etc.). Bonuses are
  whatever each action already computes; the module doesn't second-guess them.

---

## 2. Terminology

- **Block** — one action's contribution to the sequence: its `ActionUse`, its attack list,
  its form data, and its own once-per-use bookkeeping. A single-action sequential attack is
  a one-block sequence.
- **Head** — a block's next unresolved attack.
- **Sequence** — the whole tracker window: an ordered list of blocks.

---

## 3. Ordering model

### The rule

> Attacks within one action resolve in their generated order. Beyond that, any attack may be
> resolved at any time.

That is the iterative constraint: you take your +11 before your +6 before your +1. Across
actions there is no constraint at all — claw, bite, claw is legal.

### How it's modelled

**N queues, and the user picks which queue to pop.** Not a flat reorderable list.

Each block keeps a cursor at its head. "Roll" on a block resolves that block's head and
advances only that cursor. Interleaving falls out for free, the within-action order is
preserved by construction, and there is no way to express an illegal order — so no
drag-and-drop, no partial-order bookkeeping, and no validation code.

### Deliberate simplification

PF1 puts haste / rapid-shot / manyshot extras into the *same* attack array as the iteratives
(`AttackDialog._toggleExtraAttack` splices them in at a fixed position). Strictly by RAW those
extras aren't iteratives and could be taken out of order within their own action. We lock the
whole block's order anyway.

Rationale: within a block the only thing order changes is which bonus lands on which target,
and the extras sit at the top of the list where you'd usually want them. Splitting a block
into "locked iteratives + floating extras" is real complexity for a marginal case. If it turns
out to matter at the table, the queue model extends to it — a block becomes two queues — without
reworking anything else.

---

## 4. UI behaviour

### One block — unchanged

If the sequence has **only ever had** one block, the tracker renders and behaves **exactly as it
does today**. No per-block chrome, no ordering affordance. A single action with six attacks must
not grow new UI.

This is a **sticky flag**, not a live count: once a sequence has held two or more blocks it keeps
multi-block chrome for the rest of its life, even if removals bring it back down to one. Deleting
a block should not reshape the window around the user mid-sequence.

### Multiple blocks

- Attacks are grouped under a per-block header (item — action name).
- Each block shows its own head highlighted and its own **Roll** button.
- Completed/skipped blocks collapse to a greyed summary row.
- **Roll Next stays**, always, as the low-friction path for anyone who doesn't care about order.

### Removing a block

Each block header carries an **X** control, shown only when the sequence has more than one
block (consistent with the single-block rule above).

**X is offered only on a block that has resolved nothing yet.** That restriction isn't
arbitrary — per §7, an unstarted block has not drained charges, not run its `use` scripts, and
not fired `pf1PreActionUse`, so removing it leaves no trace. A block that has already rolled
cannot be un-rolled: its cards are posted and its resources are spent, so it keeps no X. To
abandon the rest of a started block, skip its remaining attacks or cancel the sequence.

Removal semantics:

- Delete the block's measure template, if it placed one.
- If the removed block was active, the active block advances to the next with unresolved attacks.
- The block never fires `postUse` — it resolved nothing, so §7's "≥1 resolved attack" rule already
  excludes it.
- Removing the originating block (the one whose `process()` call owns the pending
  `tracker.run()`) is fine. The tracker owns the sequence lifetime, not any block.
- Removal never reverts the window to single-block chrome — the multi-block flag is sticky (see
  above). The X control remains available on any other unstarted block.

### "Roll Next" with multiple blocks

Roll Next resolves the head of the **active block**. The active block:

- starts as block 0,
- advances to the next block with unresolved attacks when the active one empties,
- **follows your last explicit choice** — clicking a specific block's Roll button makes that
  block active, so subsequent Roll Next presses continue there.

The alternative (Roll Next always takes the first non-empty block in order, ignoring
deviations) is more stable but more surprising after you've deviated once. Going with
follow-your-choice; revisit if it feels wrong in play.

### Roll All Remaining

Still offered. Resolves every remaining attack in every block, emitting **one chat card per
block** (§8), in block order.

### Edit Options

Becomes per-block — each block's header carries its own edit control, operating on that
block's `_preAlter*` snapshots. There is no global edit.

---

## 5. Dialog policy

**One real `pf1.applications.AttackDialog` per block, configured up front.**

Not a combined mega-dialog. `AttackDialog` is a V1 `Application` bound to a single `shared`,
and it mutates `shared.attacks` in place ([attack-dialog.mjs:19](../foundryvtt-pathfinder1-v11.x/module/applications/attack-dialog.mjs#L19),
`_toggleExtraAttack`). Hosting N of them in one window means reimplementing the form, which
silently drops every injection point into it — including:

- `pf1-new-script-hooks`' `pf1PreAttackDialog` / `pf1PostAttackDialog`
  ([dialog-hooks.mjs:47](../pf1-new-script-hooks/src/scripts/dialog-hooks.mjs#L47))
- astora-mod's target-exclusion UI (`renderAttackDialog`,
  [target-exclusion.mjs:406](../astora-mod/targeting/target-exclusion.mjs#L406))
- ckl-roll-bonuses' injected inputs

Reusing the real dialog keeps all of that working per block, for free.

**Cancelling a block's dialog means the block is not added.** No deferred/unconfigured block
state exists — a block is only ever fully configured. For the *first* block this is the
existing behaviour (cancel = no sequence at all).

### The "Sequential Attack" checkbox

The dialog carries an extra checkbox, injected by this module, which decides whether the attack
joins a sequence:

| Checkbox | Tracker open for this actor? | Result |
|---|---|---|
| checked | no | start a new sequence with this action as block 0 |
| checked | yes | add this action to that sequence as a new block |
| unchecked | either | resolve normally through the vanilla chain |

This single control covers both entry paths: starting a sequence, and adding to a live one.
There is no separate "+ Add Attack" button — you use the item the way you always do, and the
checkbox decides where the attack goes.

**Default state** = checked when a tracker is already open for this actor, otherwise per the
module setting (§5.2). That is the auto-capture behaviour: with a sequence live, your next attack
joins it by default — but the dialog still shows you that's happening and lets you opt out with
one click.

That opt-out matters. Attacks of opportunity, readied attacks, and rays are *not* part of a full
attack, and silently swallowing them into the sequence would be both rules-wrong and unrecoverable
(the card is posted, the resources are spent). A pre-checked box you can untick is the whole
safety mechanism.

### 5.1 Injection mechanics

`AttackDialog.resolveAttack` builds its return value as
`new FormDataExtended(this.element.find("form")[0]).object`
([attack-dialog.mjs:497](../foundryvtt-pathfinder1-v11.x/module/applications/attack-dialog.mjs#L497)).
So a named input injected **inside the dialog's `<form>`** appears in the resolved `form` object
for free — no subclass, no wrapper, no `pf1PostAttackDialog` round-trip. Inject on
`renderAttackDialog`, read as `form["seq-sequential"]`.

Two constraints:

- **Inject outside `.flags`.** `activateListeners` binds `_onToggleFlag` to
  `.flags input[type="checkbox"]` plus three named inputs
  ([:221-225](../foundryvtt-pathfinder1-v11.x/module/applications/attack-dialog.mjs#L221-L225)). A
  checkbox placed in the footer with a distinct name is untouched by PF1's handlers.
- **Persist the checked state on the app instance.** `_onToggleFlag` ends with `this.render()`
  ([:288](../foundryvtt-pathfinder1-v11.x/module/applications/attack-dialog.mjs#L288)), so ticking
  haste / rapid-shot / manyshot / primary-attack destroys our injected node and re-fires
  `renderAttackDialog`. Store the state as e.g. `app._seqUseSequential` and restore it on
  re-injection, or the box silently resets whenever the user touches an unrelated toggle.

`SequentialEditDialog` must hide this checkbox — mid-sequence the decision is already made.

### 5.2 Setting semantics

The `sequentialAttacks` client setting changes meaning, from "all qualifying full attacks go
sequential" to a three-state control over the checkbox:

| State | Behaviour |
|---|---|
| **Off** | Wrapper bails immediately, exactly as today. No interception, no checkbox. |
| **Ask** | Checkbox shown, default unchecked (unless a tracker is open — see above). |
| **Always** | Checkbox shown, default checked. Closest to today's `true`. |

Migration: the setting is currently `Boolean`, so this is a type change. Either register a new key
and migrate `false → "off"` / `true → "always"` on `ready`, or keep the Boolean as a master switch
and add a second Boolean for the default. The three-state version is cleaner to reason about;
noting the cost rather than deciding here.

**Blast-radius warning.** In *Ask* and *Always* the wrapper must intercept **every** attack dialog
in order to show the checkbox and read it back — including attacks the user never intends to make
sequential. When the box comes back unchecked, the wrapper hands off through the cached-dialog
path (`createAttackDialog` monkey-patch plus the ammo-preservation dance, currently
[L146-181](src/scripts/sequential-attacks.mjs#L146-L181)), which today is the *rare* path and
would become the common one. That code already carries one shipped bug's worth of scar tissue —
the v1.2.2 ammo-reset fix. Keeping **Off** as a true zero-interception bail is what limits the
damage for anyone who doesn't want the feature.

---

## 6. Building a block's ActionUse

Nothing needs to be constructed. Because the entry point is the dialog checkbox (§5), the wrapper
is **already in the call path** for every attack the user makes — the block's `ActionUse` is the
one PF1 handed us, built by `item.use()` with all its non-writable `item`/`token`/`action`
plumbing intact ([item-pf.mjs:1753-1873](../foundryvtt-pathfinder1-v11.x/module/documents/item/item-pf.mjs#L1753-L1873)).

So "add a block" is just a branch in `sequentialProcessWrapper`. It runs the same pre-flight it
already runs — `checkRequirements`, `autoSelectAmmo`, `getRollData`, `generateAttacks`,
`createAttackDialog`, `alterRollData`, `handleConditionals`, `prepareChargeCost`, ammo/charge
filtering, `checkAttackRequirements`, measure template — then, instead of constructing a tracker,
calls `tracker.addBlock(actionUse, attacks)` on the existing one and returns.

This also means multi-action items get PF1's own `ActionSelector` for free, since the user is
invoking the item normally.

Differences add mode must observe:

- **No qualification check.** The `shared.attacks.length <= 1` bail-out in the current wrapper
  exists to hand single attacks back to the vanilla chain. A one-attack block (a bite!) is
  perfectly valid, so add mode skips that check entirely and never calls `wrapped()`.
- **Respect a Single Attack choice.** The wrapper pre-generates with `generateAttacks(true)`.
  `generateAttacks` computes `full = forceFullAttack || shared.fullAttack`
  ([action-use.mjs:319](../foundryvtt-pathfinder1-v11.x/module/action-use/action-use.mjs#L319)), so if
  `form.fullAttack === false`, add mode must set `shared.fullAttack = false` and re-run
  `generateAttacks(false)`. The current code never needs this because it delegates to `wrapped()`.
- **Returns immediately.** The added `item.use()` promise resolves as soon as the block is
  registered; the sequence's lifetime is owned by the original wrapper's pending
  `await tracker.run()`. Per-block `postUse` therefore fires from the tracker, not from this call
  (§7).
- **`skipDialog` never captures.** A quick-roll has no dialog, so there is no checkbox and no
  chance to opt out — capturing it silently is exactly the AoO failure mode §5 exists to prevent.
  `skipDialog` resolves through the vanilla chain, matching the wrapper's existing bail at
  [L76-79](src/scripts/sequential-attacks.mjs#L76-L79). This doubles as a deliberate bypass
  gesture: quick-roll an attack of opportunity and it stays out of the sequence.

Blocks may be added after attacks have already resolved. Such a block simply arrives with the
sequence-global one-shots (§7) already spent.

### 6.1 Tracker registry

"Is a tracker open for this actor?" needs a lookup, and the current
`DEFAULT_OPTIONS.id = "pf1-sequential-attack-tracker"` is a **fixed string** — ApplicationV2
treats `id` as the instance key, so two actors' trackers would collide today.

Both problems have one fix: give each tracker an id derived from its owner
(`pf1-sequential-attack-tracker-<tokenOrActorId>`) and keep a module-level
`Map<ownerUuid, tracker>` populated on render and cleared on close. Key on the **token document**
for unlinked tokens, the actor otherwise — three trolls from the same prototype need three
independent sequences.

---

## 7. Once-per-use state

This is where the bugs will be. Every "once" in the current code means *once per sequence*
because sequence == use. Those now split:

| State | Scope | Currently |
|---|---|---|
| Charge cost / spell slot | **per block** | `shared._wholeChargeCost`, [L229](src/scripts/sequential-attacks.mjs#L229) |
| `use` script calls | **per block** | `_runUseScripts` |
| `postUse` + `pf1PostActionUse` | **per block**, for blocks that resolved ≥1 attack | wrapper, ~L285 |
| Self-charged action uses | **per block** | `_resolveCurrentAttack` |
| Measure template | **per block** (only blocks that want one) | wrapper, ~L251 |
| `pf1PreActionUse` | per attack (unchanged) | `_resolveCurrentAttack` |
| Charge bonus decay after attack 1 | **per sequence** | `_prepareSequenceRollData` |
| `firstAttackBonus` / `firstAttackDamageBonus` | **per sequence** | `_resolveCurrentAttack` |
| `clearTargetsAfterAttack` | **per sequence**, at the end | wrapper, ~L276 |
| Ammo | per attack (unchanged) | `_subtractSingleAttackAmmo` |

### `sequenceStarted` must split

`this.sequenceStarted` currently does double duty: it gates the use-scripts *and* the
first-attack-only bonuses. Those land on opposite sides of the table. Split into:

- `sequenceStarted` — sequence-global; drives charge decay and `firstAttack*` bonuses.
- `block.scriptsRun` — per block; gates that block's `use` script calls.

### Per-block postUse timing

Fire `postUse` + `pf1PostActionUse` for every block with ≥1 resolved attack **at sequence end**
(completed *or* cancelled), in block order — not when a block empties. Simpler, and a block that
empties early might still have been abandoned by an overall cancel.

### Haste / Rapid Shot double-dipping

Each block's dialog offers haste/rapid-shot independently; nothing stops ticking both. Cross-block
gating (grey out once claimed by another block) is the right fix. **Deferred** — v1 ships a
warning notification instead.

---

## 8. Chat cards

One card per resolved attack, as today — but a card belongs to **one** item/action (its damage,
effect notes, save DC and header all come from that action's `actionUse`). So:

- One-at-a-time: unchanged, card built from the head's own block.
- **Roll All Remaining: one card per block**, not one card total. `_resolveAllRemaining` becomes a
  loop over blocks, each running the existing batch logic against its own `actionUse`.

---

## 9. `shared.sequentialAttack` contract

Nothing outside this module currently reads it, but keep the existing keys meaning what they mean
today (block-local, matching single-block behaviour) and add sequence-level keys alongside:

```js
shared.sequentialAttack = {
  // existing — block-local
  index, total, isFirst, isLast,   // isFirst: first resolved attack of THIS block
  batch, count,                     // batch resolution only
  // new — sequence-level
  blockIndex, blockCount,
  isFirstInSequence,                // drives charge / firstAttack* bonuses
};
```

---

## 10. Build order

**Phase 1 — ad-hoc multi-action.** Block model, the §7 state split, per-block cards, per-block UI
with the X control, the tracker registry (§6.1), the dialog checkbox and setting rework (§5).
No group storage. This forces the entire multi-`ActionUse` refactor, which is the genuinely hard
part — so if the block model is wrong, it fails here rather than after group-management UI is
built on top.

Suggested order within Phase 1, riskiest first:

1. Block model + the `sequenceStarted` split (§7). Single-action behaviour must be unchanged at
   this point — that's the regression gate.
2. Tracker registry and per-actor ids (§6.1).
3. Dialog checkbox + add-mode branch (§5, §6). First point at which claw/claw/bite works.
4. Per-block UI: headers, per-block Roll, active-block rule, X control.
5. Per-block chat cards for Roll All Remaining (§8).

**Phase 2 — quality of life.** Saved groups in an actor flag
(`flags.pf1-sequential-attacks.groups`), a small ApplicationV2 to manage them, a launcher API,
UI polish, cross-block haste gating (§7).

---

## 11. Open questions

- **Setting migration shape** (§5.2): three-state string with a `ready` migration, or keep the
  Boolean master switch and add a second Boolean for the default? Leaning three-state.
- **Should the checkbox appear on non-full-attack actions?** A single-attack action can still
  legitimately start or join a sequence (a bite), so it should — but that means the checkbox shows
  on essentially every attack in *Ask*/*Always*. Acceptable, or restrict to `action.hasAttack`
  plus some heuristic?

### Settled

- **Adding the same action twice is permitted but unsupported.** Not the intended use, but
  deliberately not blocked — no validation, no warning. Blocks are keyed by a generated id
  rather than item/action id, so it already works. Each block drains its own charges and runs
  its own `use` scripts, which is the correct reading if the user really did mean two uses.
- **Blocks get an X control**, scoped as described in §4.
- **Multi-block chrome is sticky**, not a live block count (§4).
- **Entry is the dialog checkbox, not a button.** Auto-capture and explicit opt-in are the same
  mechanism; the checkbox's default state is what distinguishes them (§5). No "+ Add Attack"
  button, no item picker, no wrapper re-entrancy.
