# Changelog

<!--
  Release process: before tagging v<x.y.z>, rename the "Unreleased" heading
  below to "## [<x.y.z>] - <YYYY-MM-DD>". The release workflow extracts the
  section whose heading matches the pushed tag and uses it as the GitHub
  release body. If no matching section exists, the release fails.
-->

## [Unreleased]

### Added
- **Use Legacy Theme** setting (per-client). Restores the tracker window's original blue/green/gold colour scheme.

### Changed
- Tracker window restyled to match companion modules: amber accent on dark panels, a status rail on the current attack, and an amber-gradient primary button. Purely cosmetic — attack resolution is unchanged.
- All user-facing text (setting, tracker window, buttons, dialog titles, error notifications) is now localizable via `game.i18n` (English `lang/en.json` included).

### Fixed
- **Edit Options** stayed greyed out after cancelling the edit dialog, until another attack was rolled or skipped. Tracker buttons now re-enable whenever an action finishes without redrawing the window.

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
