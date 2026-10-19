# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
- **Several actions in one sequence.** With a tracker open, use another attack from the same actor and it joins the tracker (claw, claw, bite). Each action gets its own header with Roll, Edit Options and Remove controls; its attacks keep their order, but you can switch between actions freely. Roll Next continues with the action you rolled last, and Roll All Remaining posts one card per action. Each action spends its own charges and runs its own script calls. A warning appears if Haste or Rapid Shot is ticked on more than one action.
- **Sequential attack checkbox** in the attack dialog, which decides whether the attack starts or joins a sequence. Untick it for an attack that isn't part of the full attack.
- **Attack Routines.** A new category at the top of the combat tab for saved sets of attacks. Drag attacks from the sheet onto a routine, reorder them, and set preset dialog options per attack through the real attack dialog without rolling anything. Using a routine starts every attack as one sequence, either quick-rolled with the presets or through each dialog filled in from them. Routines can appear with the actor's quick actions on the sheet and token HUD, and can be dragged to the hotbar.
- **`startSequence(subject, entries, options)` API** for module developers, at `game.modules.get("pf1-sequential-attacks").api`. Starts several of one attacker's actions as a single sequence (or adds them to its open one), each through its normal attack dialog or quick-rolled. Entries that can't join are left out with a warning and spend nothing.
- **Use Legacy Theme** setting (per-client). Restores the tracker window's original blue/green/gold colour scheme.
- **Per-Use script calls fire once per attack.** With pf1-new-script-hooks v1.6.0 or later installed, its **Per Use** category runs for each attack as that attack's card is built — the seam for a per-projectile animation, since `shared.targets` has already been refreshed to whatever *that* attack is aimed at. The count and index sequence match what an ordinary one-card full attack produces, so the same script works with sequential mode on or off. Entirely optional: with that module absent, nothing happens. `shared.reject` from such a script cancels the sequence.
- **`pf1SequentialAttacks.postCard(actionUse, message)` hook** for module developers. Fires after each card posts, whether it holds one attack or a Roll All Remaining batch. While it runs, `shared.attacks` holds exactly that card's attacks, in the card's order, so an index into it matches the card's `system.rolls.attacks`. `pf1PostActionUse` still fires once at the end of the sequence, as before, with the last card. `message` is `null` when the card was hidden.
- **`pf1SequentialAttacks.refreshRollData(actionUse)` hook** for module developers. Fires each time sequential mode rebuilds `shared.rollData` (before the attack dialog, before each attack, and before Edit Options), so values a module stamped there at `pf1CreateActionUse` can be stamped again.
- Actions that roll **no attack** can now be sequenced, when something gives them more than one entry in the attack list — a module that makes a magic-missile-style spell resolve several times, for example. Such an action is walked one use at a time like any full attack, so it can be retargeted between uses. Actions that roll no attack and produce a single entry are untouched and hand off to the normal flow exactly as before.

### Changed
- **Sequential Full Attacks** is replaced by **Sequential Attacks**, with three modes: **Always** (default; the checkbox starts ticked for full attacks), **Ask** (starts unticked), and **Off**. It is saved per user instead of per browser, so a player's choice follows them to any device. Choices saved under the old setting are not carried over: everyone starts on Always.
- Quick-rolled full attacks now go sequential under Always (and join an open tracker under either mode), with or without pf1-new-script-hooks installed. A quick-rolled single attack always resolves normally.
- Tracker window restyled to match companion modules: amber accent on dark panels, a status rail on the current attack, and an amber-gradient primary button. Purely cosmetic — attack resolution is unchanged.
- All user-facing text (setting, tracker window, buttons, dialog titles, error notifications) is now localizable via `game.i18n` (English `lang/en.json` included).
- Power Attack numbers on attacks after the first now defer to astora-mod's Combat Options when it is installed and on, so a changed penalty or damage bonus holds for the whole sequence. Without it nothing changes.

### Fixed
- **Edit Options** stayed greyed out after cancelling the edit dialog, until another attack was rolled or skipped. Tracker buttons now re-enable whenever an action finishes without redrawing the window.
- The per-attack card built an attack roll unconditionally. An action whose type carries no attack roll now gets damage and effect notes only, matching the system's own behaviour.
- The tracker's bonus column printed `+0` on every row for an action with no attack roll. It is now blank in that case.
- Other modules' wrappers on the system's action-use pipeline were skipped whenever sequential mode took over a full attack, and libWrapper warned that this module "did not chain the wrapper". The wrapper now registers earlier, so it runs after every other module's wrapper and skips only the system's own handling.
- Starting a second sequential full attack while another tracker was open replaced the first tracker's window, leaving that sequence stuck with no way to finish it. Each actor (each token, for unlinked tokens) now gets its own tracker, so several can be open at once.

## [1.2.2] - 2026-07-04

### Fixed
- Ammo selected in the attack dialog was reset to the item's default when a ranged attack didn't qualify for sequential mode (a single attack, or "Single Attack" chosen). The per-attack ammo choice is now preserved when handing off to the normal attack flow.

## [1.2.1] - 2026-06-30

### Fixed
- Missing folder reference in `module.json`.

## [1.2.0] - 2026-06-30

### Added
- **Roll All Remaining.** Button to roll every unresolved attack together in a single chat card when two or more remain.
- **Spell support.** Spells are now allowed through the sequential-attack flow.
- **First-attack-only bonuses.** Script calls can push to `shared.firstAttackBonus` and `shared.firstAttackDamageBonus`.

### Changed
- Script call handling reworked to run earlier, before `addAttack`.
- GUI migrated to ApplicationV2 with a Handlebars template.
- Scripts now loaded as ES modules.

### Fixed
- "+0 [undefined]" rendering issue with extra attacks.

## [1.1.0] - 2026-03-28

### Added
- Edit-options button on the dialog for mid-sequence updates.

### Changed
- Dialog colors adjusted for better visibility.

### Fixed
- Reworked attack splitting to fix duplication and script-call issues.
- Check-override implementation.
- Rejection is now checked before the tracker is shown.

## [1.0.2] - 2026-02-27

### Fixed
- Additional bugfix.

## [1.0.1] - 2026-02-27

### Fixed
- libWrapper implementation bugfix.

## [1.0.0] - 2026-02-27

### Added
- Initial release as an installable FoundryVTT v13 module.
- `styles/` included in the release zip.
