/* Sequential Full Attack
 *
 * When enabled, full attacks are resolved one attack at a time instead of all at once.
 * A tracker dialog shows all attacks, highlighting the current one. The user clicks
 * "Next Attack" to roll each attack individually, allowing retargeting and buff/debuff
 * changes between attacks. Each resolved attack posts its own chat card.
 *
 * Uses libWrapper to wrap ActionUse.prototype.process().
 */

// ---- Setting Registration ---- //

Hooks.once("init", () => {
  // Replaces the Boolean "sequentialAttacks"; a fresh key so stored booleans from that
  // key never reach a string-choice setting (DESIGN.md §5.2).
  game.settings.register("pf1-sequential-attacks", "sequentialMode", {
    name: "SEQ.Settings.Mode.Name",
    hint: "SEQ.Settings.Mode.Hint",
    scope: "user",
    config: true,
    type: String,
    choices: {
      off: "SEQ.Settings.Mode.Off",
      ask: "SEQ.Settings.Mode.Ask",
      always: "SEQ.Settings.Mode.Always",
    },
    default: "always",
  });

  const module = game.modules.get("pf1-sequential-attacks");
  module.api = { ...(module.api ?? {}), startSequence };

  // Purely cosmetic: picks which palette the tracker window is stamped with. See
  // src/styles/sequential-attacks.css — the two themes are fully separated there.
  game.settings.register("pf1-sequential-attacks", "legacyTheme", {
    name: "SEQ.Settings.LegacyTheme.Name",
    hint: "SEQ.Settings.LegacyTheme.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
});

// ---- Wrapper Registration ---- //

// Registered at "setup", ahead of the usual "ready" registrations. libWrapper runs
// same-type, same-priority wrappers last-registered-first, so this lands innermost:
// when sequential mode takes over without chaining, only the system's own process()
// is skipped, and every other module's wrapper has already run around it.
Hooks.once("setup", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    console.warn("pf1-sequential-attacks | Sequential Attacks requires libWrapper. Feature disabled.");
    return;
  }

  libWrapper.register(
    "pf1-sequential-attacks",
    "pf1.actionUse.ActionUse.prototype.process",
    sequentialProcessWrapper,
    "MIXED"
  );

  // Attack Routine presets fill the dialog's form-only fields before its first getData().
  // A render hook is too late: V1 drops a render requested while one is in progress.
  libWrapper.register(
    "pf1-sequential-attacks",
    "pf1.applications.AttackDialog.prototype.getData",
    function (wrapped, ...args) {
      const preset = this.actionUse?.shared?._seqPreset;
      if (preset && !this._seqPrefilled) {
        this._seqPrefilled = true;
        _prefillDialog(this, preset);
      }
      return wrapped(...args);
    },
    "WRAPPER"
  );

  console.log("pf1-sequential-attacks | Sequential Attacks wrappers registered.");
});

// ---- Attack Dialog Checkbox ---- //

/**
 * Inject the Sequential Attack checkbox above the dialog's attack buttons (DESIGN.md §5.1).
 *
 * Only dialogs opened by the wrapper carry `shared._seqDialog`, so the edit-options
 * dialog and any dialog opened while the setting is Off get nothing. The input has no
 * name, so it never reaches the form data; its state lives on `shared._seqDialog`, which
 * also survives the re-render PF1 does whenever a flag such as Haste is toggled.
 */
Hooks.on("renderAttackDialog", (app, html) => {
  const shared = app.actionUse?.shared;
  if (!shared || app instanceof SequentialEditDialog) return;

  const root = html instanceof HTMLElement ? html : html[0];
  const buttonRow = root?.querySelector('button[name="attack_full"]')?.closest(".form-group");

  const capture = shared._seqCapture;
  if (capture) {
    capture.rendered = true;
    if (buttonRow) {
      const note = document.createElement("p");
      note.className = "notes seq-preset-note";
      note.textContent = game.i18n.localize("SEQ.Dialog.PresetNote");
      buttonRow.before(note);
    }
    return;
  }

  const state = shared._seqDialog;
  if (!state) return;
  state.rendered = true;
  if (!buttonRow) return;

  const row = document.createElement("div");
  row.className = "form-group seq-dialog-row";
  const label = document.createElement("label");
  label.className = "checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = state.checked;
  input.addEventListener("change", () => {
    state.checked = input.checked;
    state.touched = true;
  });
  label.append(input, ` ${game.i18n.localize(state.joining ? "SEQ.Dialog.Join" : "SEQ.Dialog.Start")}`);
  row.append(label);
  buttonRow.before(row);
});

/**
 * Write a preset's form-only fields into a not-yet-shown attack dialog's state.
 *
 * @param {AttackDialog} app
 * @param {object} preset - A stored dialog form.
 */
function _prefillDialog(app, preset) {
  for (const key of PRESET_ATTRIBUTES) {
    const value = preset[key];
    if (value !== undefined && value !== null && value !== "") app.attributes[key] = String(value);
  }
  for (const [key, value] of Object.entries(preset)) {
    if (key.startsWith("conditionals.") && app.conditionals[key]) app.conditionals[key].enabled = !!value;
  }
  if ("concentration" in preset) app.flags.concentration = !!preset.concentration;
}

// Preset capture with pf1-new-script-hooks: take the form here and reject, which stops
// that module before pf1PostAttackDialog, so Pre-Use scripts never run.
Hooks.on("pf1AttackDialogResolved", (actionUse, form) => {
  const capture = actionUse.shared?._seqCapture;
  if (!capture) return;
  capture.form = foundry.utils.deepClone(form);
  actionUse.shared.reject = true;
});

/**
 * Rebuild `shared.rollData`, then fire `pf1SequentialAttacks.refreshRollData(actionUse)`.
 *
 * getRollData() replaces the object wholesale, dropping anything a module stamped onto
 * it at pf1CreateActionUse. Vanilla builds it once per use; this module rebuilds it
 * before the dialog, before each attack and before Edit Options, so the hook gives
 * those modules a place to stamp again.
 *
 * @param {ActionUse} actionUse - The in-flight use.
 */
function _refreshRollData(actionUse) {
  actionUse.getRollData();
  Hooks.callAll("pf1SequentialAttacks.refreshRollData", actionUse);
}

// ---- Core Wrapper ---- //

/**
 * Wrapper around ActionUse.prototype.process().
 * When the dialog's Sequential Attack checkbox (or, for a skipped dialog, the rule in
 * DESIGN.md §6) says so, the use becomes a block: it joins the owner's open sequence or
 * starts a new one, and its attacks are rolled one at a time. Otherwise we fall through
 * to the original method.
 */
async function sequentialProcessWrapper(wrapped, { skipDialog = false } = {}) {
  // A use routed here by the batch-start API joins that sequence whatever the setting;
  // one from an Attack Routine's edit-preset control only collects its dialog's choices.
  const batch = this.shared.useOptions?.sequentialAttacks;
  if (batch?.capture) return _captureProcess(this, batch);
  if (batch?.tracker) return _batchProcess(this, batch, skipDialog);

  // Off is a true bail: no interception, no checkbox.
  const mode = game.settings.get("pf1-sequential-attacks", "sequentialMode");
  if (mode === "off") return wrapped({ skipDialog });

  const actionUse = this; // `this` is the ActionUse instance
  const action = actionUse.action;
  const shared = actionUse.shared;

  // Actions with no attack roll are filtered below, after generateAttacks, rather
  // than here: an attack-less action normally produces one entry and bails there,
  // but one a module has given several entries (repeated uses of a spell that
  // rolls no attack) is as sequential as any full attack.

  // Consumables and class features are rarely used in sequential full attacks
  // and may be handled by other wrappers (e.g. Nevela's Automation Suite) that bypass
  // createAttackDialog(). To avoid double-dialog issues, chain directly for these types.
  // Note: spells are intentionally allowed through — NAS only intercepts them when
  // automaticBuffs is enabled; with that setting off it falls through to wrapped() anyway.
  if (!_canJoinSequence(actionUse.item)) return wrapped({ skipDialog });

  const owner = _sequenceOwner(actionUse);

  // ---- Phase 1: Show the normal attack dialog ---- //
  // We need to consume the dialog ourselves so we can inspect the result
  // and decide whether sequential mode applies. To remain compatible with
  // other libWrapper wrappers (e.g. Nevela's Automation Suite), if sequential
  // mode does NOT apply we monkey-patch createAttackDialog() on this instance
  // to return the cached dialog result, then call wrapped() so the full
  // wrapper chain runs without re-showing the dialog.

  // Run the pre-dialog setup so the dialog has the data it needs.
  // Note: We do NOT fire pf1CreateActionUse here — it will fire in wrapped() or
  // in our sequential phase. This avoids double-firing when we chain to wrapped().
  let reqErr = await actionUse.checkRequirements();
  if (reqErr > 0) return { err: pf1.actionUse.ERR_REQUIREMENT, code: reqErr };

  await actionUse.autoSelectAmmo();
  _refreshRollData(actionUse);

  shared.fullAttack = true;
  await actionUse.generateAttacks(true);

  // An attack-less action with a single entry has nothing to sequence. Chain out
  // before the dialog is consumed, so the overwhelmingly common non-attack use is
  // untouched by this module — only the four idempotent setup calls above have run,
  // and wrapped() re-runs them safely.
  if (!action.hasAttack && shared.attacks.length <= 1) {
    return wrapped({ skipDialog });
  }

  const multi = shared.attacks.length > 1;

  // Skipped through the argument (pf1-new-script-hooks absent): there is no dialog to
  // consume, so decide now and hand off untouched when the use doesn't sequence.
  if (skipDialog && !_skippedDialogSequences(multi, owner, mode)) {
    return wrapped({ skipDialog });
  }

  // Initialize first-attack-only arrays before the dialog fires any script calls
  // (e.g. via pf1PostAttackDialog hooks), so scripts that push to them don't error.
  shared.firstAttackBonus = [];
  shared.firstAttackDamageBonus = [];

  // ---- Phase 2: Does this use join or start a sequence? (DESIGN.md §5, §6) ---- //
  // Decided WITHOUT calling alterRollData yet — that method pushes to
  // shared.attackBonus/damageBonus, and calling it here would cause double-counting
  // if wrapped() later calls it again for the non-sequential path.
  let form;
  let useSequential;
  if (skipDialog) {
    form = {};
    useSequential = true;
  } else {
    // Checkbox state, read and written by the renderAttackDialog hook. Kept off the
    // form so a dialog resolved without rendering is distinguishable from an unticked box.
    const trackerOpen = !!_openTrackerFor(owner);
    const seqDialog = {
      checked: trackerOpen || (mode === "always" && multi),
      joining: trackerOpen,
      touched: false,
      rendered: false,
    };
    shared._seqDialog = seqDialog;
    try {
      form = await actionUse.createAttackDialog();
    } finally {
      delete shared._seqDialog;
    }
    if (!form) {
      console.debug("PF1 | Sequential attack cancelled in attack prompt.");
      return;
    }

    // Check if a pre-use script (e.g. pf1-new-script-hooks) set the reject flag
    if (shared.reject) {
      console.debug("PF1 | Sequential attack rejected by script call (shared.reject).");
      return;
    }

    if (!seqDialog.rendered) {
      // Resolved without rendering: pf1-new-script-hooks' quick-roll path, or a resumed form.
      useSequential = _skippedDialogSequences(multi, owner, mode);
    } else if (form.fullAttack === false && multi && !seqDialog.touched) {
      // Single Attack on a multi-attack list, box left at its default: the default for a
      // one-attack list applies instead, so a dialog-rolled AoO doesn't open a tracker.
      useSequential = !!_openTrackerFor(owner);
    } else {
      useSequential = seqDialog.checked;
    }
  }

  if (!useSequential) {
    // Not sequential. Hand off to the full wrapper chain.
    // We've already consumed the dialog and run pre-dialog steps, so we need
    // to ensure downstream wrappers (or vanilla) don't re-run the dialog
    // or re-run the idempotent setup steps. We accomplish this by:
    //   1. Monkey-patching createAttackDialog to return our cached result
    //   2. Calling wrapped() — each wrapper in the chain will re-run the
    //      idempotent setup (checkRequirements, autoSelectAmmo, getRollData,
    //      generateAttacks) which is safe, and then hit our patched dialog.
    actionUse.createAttackDialog = async () => form;

    // Ammo selection made in the dialog lives on shared.attacks[i].ammo — the dialog
    // mutates the attack entries directly and does NOT record the choice in `form` or
    // in item.system.ammo.default (only the "set as default" control does that). But
    // wrapped() re-runs generateAttacks(), which rebuilds shared.attacks from the item's
    // DEFAULT ammo, silently discarding the user's per-attack pick (the patched dialog
    // above never re-shows the UI to re-apply it). Snapshot the selection by index and
    // patch generateAttacks so it re-applies after each regeneration in the chain.
    const usesAmmo = !!action.ammo?.type;
    const selectedAmmoIds = shared.attacks.map((atk) => atk.ammo?.id ?? null);
    if (usesAmmo && selectedAmmoIds.some(Boolean)) {
      const originalGenerate = actionUse.generateAttacks;
      actionUse.generateAttacks = function (forceFullAttack) {
        const generated = originalGenerate.call(this, forceFullAttack);
        const reapply = (attacks) => {
          const ammos = actionUse.getAmmo();
          attacks.forEach((atk, i) => {
            if (i >= selectedAmmoIds.length) return;
            const id = selectedAmmoIds[i];
            atk.ammo = id ? (ammos.find((o) => o.id === id) ?? atk.ammo) : null;
          });
          return attacks;
        };
        return generated instanceof Promise ? generated.then(reapply) : reapply(generated);
      };
      console.debug("PF1 | Sequential mode: action does not qualify, chaining to wrapped() (preserving ammo selection).");
      try {
        return await wrapped({ skipDialog: false });
      } finally {
        delete actionUse.generateAttacks; // restore the prototype method
      }
    }

    console.debug("PF1 | Sequential mode: action does not qualify, chaining to wrapped().");
    return wrapped({ skipDialog: false });
  }

  // ---- Phase 3: Sequential mode activates ---- //
  // Now it's safe to apply the dialog results — we own the rest of the flow.
  // Not chaining skips only the system's process(): this wrapper is registered
  // innermost (see Wrapper Registration), so other modules' wrappers have already run.
  const prepared = await _prepareBlock(actionUse, form);
  if (!prepared.ok) return prepared.result;

  // ---- Phase 4: Join the open sequence, or start one ---- //
  // Looked up again: the tracker may have closed while the dialog was up.
  // Either way this call resolves when the sequence ends, like any other use.
  const open = _openTrackerFor(owner);
  if (open) {
    const { block } = open.addBlock(actionUse, prepared.attacks, prepared.measureTemplate);
    open.render();
    await open.ended;
    return block.resolvedAny ? actionUse : undefined;
  }

  // The sequence starts empty and every block, this one included, enters through
  // addBlock(). This call's pending run() owns the sequence's lifetime.
  const tracker = new SequentialAttackTracker(owner);
  const { block } = tracker.addBlock(actionUse, prepared.attacks, prepared.measureTemplate);
  await tracker.run();

  return block.resolvedAny ? actionUse : undefined;
}

/**
 * process() for a use the batch-start API routed here (DESIGN.md §10.3). Joins that
 * sequence with no checkbox and no default rule, and never falls through to the normal
 * chain: a use that can't join spends nothing and reports why instead.
 *
 * @param {ActionUse} actionUse
 * @param {{tracker: SequentialAttackTracker, report: Function}} batch - From startSequence().
 * @param {boolean} skipDialog - process()'s own argument. pf1-new-script-hooks turns it false
 *   and skips inside createAttackDialog() instead, so `shared.skipDialog` can't stand in for it.
 * @returns {Promise<ActionUse|object|undefined>} What process() returns.
 */
async function _batchProcess(actionUse, batch, skipDialog) {
  const shared = actionUse.shared;
  const { tracker } = batch;
  const fail = (reason, result) => {
    batch.report({ ok: false, reason });
    return result;
  };

  if (_sequenceOwner(actionUse).uuid !== tracker.owner.uuid) return fail("owner");
  if (!_canJoinSequence(actionUse.item)) return fail("type");

  const reqErr = await actionUse.checkRequirements();
  if (reqErr > 0) return fail("requirements", { err: pf1.actionUse.ERR_REQUIREMENT, code: reqErr });

  await actionUse.autoSelectAmmo();
  _refreshRollData(actionUse);
  shared.fullAttack = true;
  await actionUse.generateAttacks(true);
  shared.firstAttackBonus = [];
  shared.firstAttackDamageBonus = [];

  // An Attack Routine preset for the action actually picked (DESIGN.md §10a).
  const preset = batch.presets?.[actionUse.action.id] ?? null;
  _applyPresetOptions(actionUse, preset);

  // With pf1-new-script-hooks the argument arrives false and its createAttackDialog()
  // wrapper returns {} for a skip after firing its hooks.
  let form;
  if (skipDialog) {
    form = _presetQuickForm(actionUse, preset);
  } else {
    shared._seqPreset = preset;
    try {
      form = await actionUse.createAttackDialog();
    } finally {
      delete shared._seqPreset;
    }
    // A pf1-new-script-hooks skip resolves {} without rendering; the preset stands in for it.
    if (form && !Object.keys(form).length && preset) form = _presetQuickForm(actionUse, preset);
  }
  if (!form) return fail("cancelled");
  if (shared.reject) return fail("rejected");

  const prepared = await _prepareBlock(actionUse, form);
  if (!prepared.ok) return fail("requirements", prepared.result);

  // The user may have closed an already-open tracker while this dialog was up.
  const added = tracker._resolved ? { ok: false, reason: "closed" } : tracker.addBlock(actionUse, prepared.attacks, prepared.measureTemplate);
  if (!added.ok) {
    await prepared.measureTemplate?.delete();
    return fail(added.reason);
  }

  batch.report({ ok: true, block: added.block });
  tracker.render(); // no-op until the tracker's first render
  await tracker.ended;
  return added.block.resolvedAny ? actionUse : undefined;
}

/**
 * process() for an Attack Routine's edit-preset control (DESIGN.md §10a): show the real
 * attack dialog, collect its choices, and stop before anything resolves. Requirements are
 * not checked, so a preset can be edited while the item is out of charges.
 *
 * With pf1-new-script-hooks the form is taken at pf1AttackDialogResolved and the use
 * rejected there, before pf1PostAttackDialog, so Pre-Use scripts never run. Without it the
 * form comes straight back from createAttackDialog(). Either way wrapped() is never called.
 *
 * @param {ActionUse} actionUse
 * @param {{capture: Function, presets?: object}} marker - From the routine's edit control.
 */
async function _captureProcess(actionUse, marker) {
  const shared = actionUse.shared;
  const preset = marker.presets?.[actionUse.action.id] ?? null;

  await actionUse.autoSelectAmmo();
  _refreshRollData(actionUse);
  shared.fullAttack = true;
  await actionUse.generateAttacks(true);
  _applyPresetOptions(actionUse, preset);

  const capture = { rendered: false, form: null };
  shared._seqPreset = preset;
  shared._seqCapture = capture;
  let form;
  try {
    form = await actionUse.createAttackDialog();
  } finally {
    delete shared._seqPreset;
    delete shared._seqCapture;
  }
  form = capture.form ?? form;

  // A Pre-Activate script that skipped or rejected the dialog leaves nothing to save.
  if (!capture.rendered) {
    if (form) ui.notifications.warn(game.i18n.format("SEQ.Warn.PresetNoDialog", { name: actionUse.item.name }));
    marker.capture(null);
    return;
  }
  marker.capture(form ? { actionId: actionUse.action.id, form: foundry.utils.deepClone(form) } : null);
}

/** Dialog checkbox names and the PF1 `useOptions` keys the dialog and alterRollData read them from. */
const PRESET_USE_OPTIONS = {
  "power-attack": "powerAttack",
  "primary-attack": "primaryAttack",
  "haste-attack": "haste",
  manyshot: "manyshot",
  "rapid-shot": "rapidShot",
  "point-blank-shot": "pointBlankShot",
  flanking: "flanking",
  highGround: "highGround",
  charge: "charge",
  "damage-ability-multiplier": "abilityMult",
  held: "held",
  "cl-check": "clCheck",
  "measure-template": "measureTemplate",
};

/** Dialog fields that live only in the form, not in `useOptions`. */
const PRESET_ATTRIBUTES = ["d20", "attack-bonus", "damage-bonus", "rollMode", "cl-offset", "sl-offset"];

/**
 * Write a preset's flags onto `shared.useOptions`, where PF1's attack dialog reads its
 * defaults at construction (adding Haste / Rapid Shot / Manyshot attacks with them) and
 * alterRollData falls back for a skipped dialog. `useOptions` is the object item.use()
 * was given, so this must run after the action is known and before the dialog is built.
 *
 * @param {ActionUse} actionUse
 * @param {object|null} preset - A stored dialog form.
 */
function _applyPresetOptions(actionUse, preset) {
  if (!preset) return;
  const useOptions = actionUse.shared.useOptions;
  for (const [formKey, optionKey] of Object.entries(PRESET_USE_OPTIONS)) {
    const value = preset[formKey];
    if (value === undefined || value === null || value === "") continue;
    useOptions[optionKey] = value;
  }
}

/**
 * Form for a preset use with no dialog: the stored form with conditionals the action no
 * longer has removed, plus the extra attacks only the dialog would have added.
 *
 * Constructing an AttackDialog without rendering it runs its constructor, which splices
 * Haste / Rapid Shot / Manyshot entries into `shared.attacks` from `useOptions` — PF1's
 * own code rather than a copy of it. The constructor also registers itself in `actor.apps`,
 * which is undone here.
 *
 * @param {ActionUse} actionUse - Already through _applyPresetOptions().
 * @param {object|null} preset
 * @returns {object}
 */
function _presetQuickForm(actionUse, preset) {
  if (!preset) return {};
  const form = foundry.utils.deepClone(preset);
  for (const key of Object.keys(form)) {
    if (key.startsWith("conditionals.") && !actionUse.action.conditionals.get(key.slice(13))) delete form[key];
  }

  const useOptions = actionUse.shared.useOptions;
  if (form.fullAttack !== false && (useOptions.haste || useOptions.rapidShot || useOptions.manyshot)) {
    const dialog = new pf1.applications.AttackDialog(actionUse);
    if (actionUse.actor?.apps) delete actionUse.actor.apps[dialog.appId];
  }
  return form;
}

/**
 * Item types the wrapper always hands to the normal chain (see the bail in
 * sequentialProcessWrapper), so they can never become a block.
 *
 * @param {Item} item
 * @returns {boolean}
 */
function _canJoinSequence(item) {
  if (item?.type === "consumable") return false;
  if (item?.type === "feat" && item?.subType === "classFeat") return false;
  return true;
}

/**
 * Whether a use whose dialog was skipped sequences (DESIGN.md §6): only a multi-attack
 * list, joining an open tracker under either mode or starting one under Always. A lone
 * quick-rolled attack (an AoO) never does.
 *
 * @param {boolean} multi - The generated list has more than one attack.
 * @param {TokenDocument|Actor|Item} owner
 * @param {string} mode - The sequentialMode setting.
 * @returns {boolean}
 */
function _skippedDialogSequences(multi, owner, mode) {
  return multi && (!!_openTrackerFor(owner) || mode === "always");
}

// ---- Block Pre-flight ---- //

/**
 * Pre-flight for one block once its dialog form is known: apply the form, filter
 * attacks by ammo and charges, check requirements, place the template, collect targets.
 *
 * @param {ActionUse} actionUse - The block's use.
 * @param {object} form - The resolved attack-dialog form.
 * @returns {Promise<{ok: true, attacks: object[], measureTemplate: object|null} | {ok: false, result: *}>}
 *   On failure, `result` is what process() returns.
 */
async function _prepareBlock(actionUse, form) {
  const shared = actionUse.shared;
  const action = actionUse.action;

  // Snapshot the bonus arrays BEFORE alterRollData pushes to them.
  // This lets the "Edit Options" button reset and cleanly re-apply.
  shared._preAlterAttackBonus = [...shared.attackBonus];
  shared._preAlterDamageBonus = [...shared.damageBonus];

  actionUse.formData = form;
  shared.formData = form;
  await actionUse.alterRollData(form);

  // Fire the pf1CreateActionUse hook now (we deferred it earlier to avoid double-firing
  // in the non-sequential path where wrapped() handles it).
  Hooks.callAll("pf1CreateActionUse", actionUse);

  const item = actionUse.item;
  const rollData = shared.rollData;

  // Filter attacks (ammo)
  if (action.ammo.type && action.ammo?.cost > 0) {
    shared.attacks = shared.attacks.filter((o) => o.hasAmmo);
    if (shared.attacks.length === 0) {
      ui.notifications.error(game.i18n.localize("PF1.AmmoDepleted"));
      return {
        ok: false,
        result: { err: pf1.actionUse.ERR_REQUIREMENT, code: pf1.actionUse.ERR_REQUIREMENT.INSUFFICIENT_AMMO },
      };
    }
  }

  // Limit attacks to 1 if Single Attack was chosen, as vanilla process() does here.
  if (!shared.fullAttack) shared.attacks = shared.attacks.slice(0, 1);

  // Handle conditionals (once, shared across all attacks)
  await actionUse.handleConditionals();

  // Prepare charge cost
  await actionUse.prepareChargeCost();

  // Capture the whole-use charge cost NOW, while rollData.chargeCost is still valid.
  // _prepareSequenceRollData() rebuilds rollData before each attack resolves and resets
  // chargeCost to 0 (getRollData: `rollData.chargeCost ||= 0`), so it can't be read at
  // resolution time. Per-attack actions instead stamp each attack's own cost onto
  // atk.chargeCost below; for everything else (spells' slots, single-charge items) this
  // whole-use cost is drained exactly ONCE for the full attack — mirroring vanilla
  // process() — in _resolveCurrentAttack / _resolveAllRemaining.
  shared._wholeChargeCost = shared.action.uses?.perAttack ? 0 : (rollData.chargeCost ?? 0);

  // Filter attacks (charges)
  if (rollData.chargeCost != 0 && shared.action.uses?.perAttack) {
    const cost = rollData.chargeCost;
    const charges = item.charges;
    for (const [index, atk] of shared.attacks.entries()) {
      if (charges >= (index + 1) * cost) atk.chargeCost = cost;
      else atk.chargeCost = null;
    }
    shared.attacks = shared.attacks.filter((o) => o.chargeCost !== null);
    if (shared.attacks.length === 0) {
      ui.notifications.error(game.i18n.localize("PF1.ChargesDepleted"));
      return {
        ok: false,
        result: { err: pf1.actionUse.ERR_REQUIREMENT, code: pf1.actionUse.ERR_REQUIREMENT.INSUFFICIENT_CHARGES },
      };
    }
  }

  const reqErr = await actionUse.checkAttackRequirements();
  if (reqErr > 0) return { ok: false, result: { err: pf1.actionUse.ERR_REQUIREMENT, code: reqErr } };

  // Prompt measure template (once per block)
  let measureTemplate = null;
  if (shared.useMeasureTemplate && canvas.scene) {
    measureTemplate = await actionUse.promptMeasureTemplate();
    if (measureTemplate === null) {
      console.debug("PF1 | Sequential attack cancelled during template placement.");
      return { ok: false, result: undefined };
    }
  }

  // Collect targets
  await actionUse.getTargets();

  return { ok: true, attacks: [...shared.attacks], measureTemplate };
}

// ---- Sequence Owner and Tracker Registry ---- //

/**
 * The document a sequence belongs to: the token for an unlinked token, so tokens
 * sharing one prototype keep separate sequences, and the actor otherwise.
 *
 * @param {ActionUse} actionUse
 * @returns {TokenDocument|Actor|Item}
 */
function _sequenceOwner(actionUse) {
  return _ownerOfActor(actionUse.actor) ?? actionUse.item;
}

/**
 * @param {Actor|null} actor
 * @returns {TokenDocument|Actor|null} The token for an unlinked actor, the actor otherwise.
 */
function _ownerOfActor(actor) {
  if (!actor) return null;
  return actor.isToken ? actor.token : actor;
}

/** Open trackers, keyed by owner uuid. Populated by run(), cleared on close. */
const openTrackers = new Map();

/**
 * The owner's open tracker, or null. A tracker that has settled but not yet finished
 * closing counts as closed, so nothing joins a sequence that is already over.
 *
 * @param {TokenDocument|Actor|Item} owner
 * @returns {SequentialAttackTracker|null}
 */
function _openTrackerFor(owner) {
  const tracker = openTrackers.get(owner.uuid);
  return tracker && !tracker._resolved ? tracker : null;
}

// ---- Sequence Block ---- //

/**
 * One action's share of a sequence: its ActionUse, its attack list, and its own
 * once-per-use bookkeeping. See DESIGN.md §2 and §7.
 */
class SequenceBlock {
  static #nextId = 0;

  constructor(actionUse, attacks, measureTemplate = null) {
    this.id = `block-${++SequenceBlock.#nextId}`;
    this.actionUse = actionUse;
    this.attacks = attacks;
    this.measureTemplate = measureTemplate;
    this.currentIndex = 0;          // head: next unresolved attack
    this.resolvedIndices = new Set();
    this.skippedIndices = new Set();
    this.scriptsRun = false;        // "use" script calls fired for this block
    this.resolvedAny = false;       // at least one attack resolved; gates postUse
  }

  get done() {
    return this.currentIndex >= this.attacks.length;
  }

  get remaining() {
    return Math.max(0, this.attacks.length - this.currentIndex);
  }
}

// ---- Sequential Attack Tracker (ApplicationV2) ---- //

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class SequentialAttackTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {TokenDocument|Actor|Item} owner - From _sequenceOwner(). One open tracker per owner.
   */
  constructor(owner) {
    // Stamp the chosen palette onto the frame. This goes through super() rather than a
    // post-construction tweak because ApplicationV2 freezes `this.options` — and because
    // it merges array options by concatenation, so this appends to DEFAULT_OPTIONS.classes
    // (which it deep-clones first) instead of replacing them.
    const theme = game.settings.get("pf1-sequential-attacks", "legacyTheme")
      ? "seq-theme-legacy"
      : "seq-theme-amber";
    // ApplicationV2 keys instances by id, so the id is per owner.
    const id = `pf1-sequential-attack-tracker-${owner.uuid.replaceAll(".", "-")}`;
    super({ id, classes: [theme] });
    this.owner = owner;
    /** @type {SequenceBlock[]} */
    this.blocks = [];
    this.activeBlockIndex = 0;     // block that Roll Next / Skip / Edit Options act on
    this.sequenceStarted = false;  // an attack has begun resolving; gates first-attack bonuses and charge
    this._multiBlock = false;      // sticky once two blocks have been held (DESIGN.md §4)
    this._completed = false;
    this._resolved = false;      // Promise settled?
    this._busy = false;          // an async action is in flight
    this._autoCloseTimer = null; // auto-close timer once the sequence completes
    this._resolve = null;        // Promise resolve callback
    /** Settles after the end-of-sequence lifecycle; joined uses await it. */
    this.ended = new Promise((resolve) => (this._resolveEnded = resolve));
  }

  static DEFAULT_OPTIONS = {
    classes: ["pf1-sequential-attacks", "sequential-attack-tracker-app"],
    tag: "div",
    window: {
      title: "SEQ.Window.Title",
      icon: "fa-solid fa-crosshairs",
      resizable: false,
      minimizable: false,
    },
    position: { width: 360, height: "auto" },
    actions: {
      rollNext: SequentialAttackTracker.#onRollNext,
      rollAll: SequentialAttackTracker.#onRollAll,
      skip: SequentialAttackTracker.#onSkip,
      editOptions: SequentialAttackTracker.#onEditOptions,
      cancel: SequentialAttackTracker.#onCancel,
      done: SequentialAttackTracker.#onDone,
      rollBlock: SequentialAttackTracker.#onRollBlock,
      editBlock: SequentialAttackTracker.#onEditBlock,
      removeBlock: SequentialAttackTracker.#onRemoveBlock,
    },
  };

  static PARTS = {
    body: { template: "modules/pf1-sequential-attacks/src/templates/attack-tracker.hbs" },
  };

  /** @override — the item name for one block, the attacker's name once there are several. */
  get title() {
    const name = this._multiBlock ? this.owner.name : this.blocks[0]?.actionUse.item.name;
    return game.i18n.format("SEQ.Title", { name: name ?? "" });
  }

  /** @type {SequenceBlock} */
  get activeBlock() {
    return this.blocks[this.activeBlockIndex];
  }

  get sequenceResolvedAny() {
    return this.blocks.some((b) => b.resolvedAny);
  }

  /**
   * Add one action's block. Every block, the first included, enters here (DESIGN.md §10).
   *
   * @param {ActionUse} actionUse - The block's use, already through _prepareBlock().
   * @param {object[]} attacks - The block's attack list.
   * @param {object|null} [measureTemplate] - Template placed for this block, if any.
   * @returns {{ok: true, block: SequenceBlock} | {ok: false, reason: string}}
   */
  addBlock(actionUse, attacks, measureTemplate = null) {
    // A sequence never mixes owners (DESIGN.md §10.5).
    if (_sequenceOwner(actionUse).uuid !== this.owner.uuid) return { ok: false, reason: "owner" };
    this._warnDuplicateExtras(actionUse);

    const block = new SequenceBlock(actionUse, attacks, measureTemplate);
    this.blocks.push(block);
    if (this.blocks.length > 1) this._multiBlock = true;

    // A finished sequence still waiting to auto-close reopens for the new block.
    if (this._completed && !this._resolved) {
      this._completed = false;
      clearTimeout(this._autoCloseTimer);
      this._autoCloseTimer = null;
    }
    if (this.activeBlock.done) this.activeBlockIndex = this.blocks.length - 1;

    return { ok: true, block };
  }

  /**
   * Haste and Rapid Shot each grant one extra attack, but every block's dialog offers them.
   * Warn when a second block claims one (DESIGN.md §7; cross-block gating is deferred).
   *
   * @param {ActionUse} actionUse - The block about to be added.
   */
  _warnDuplicateExtras(actionUse) {
    if (!actionUse.shared.fullAttack) return;
    const extras = [
      ["haste-attack", "PF1.Haste"],
      ["rapid-shot", "PF1.RapidShot"],
    ];
    for (const [key, labelKey] of extras) {
      if (!actionUse.shared.formData?.[key]) continue;
      const claimed = this.blocks.some((b) => b.actionUse.shared.fullAttack && b.actionUse.shared.formData?.[key]);
      if (claimed) {
        ui.notifications.warn(game.i18n.format("SEQ.Warn.DuplicateExtra", { extra: game.i18n.localize(labelKey) }));
      }
    }
  }

  /**
   * Open the tracker, wait for the sequence to end, then run the end-of-sequence
   * lifecycle for its blocks.
   * @returns {Promise<string>} "completed" or "cancelled"
   */
  async run() {
    openTrackers.set(this.owner.uuid, this);
    const result = await new Promise((resolve) => {
      this._resolve = resolve;
      this.render(true);
    });
    try {
      await this._endSequence(result);
    } finally {
      this._resolveEnded(result);
    }
    return result;
  }

  /**
   * Remove a block that has resolved nothing (DESIGN.md §4). It has spent nothing, so
   * removal leaves no trace beyond deleting its template.
   *
   * @param {SequenceBlock} block
   */
  async _removeBlock(block) {
    if (block.resolvedAny || block.scriptsRun || this.blocks.length < 2) return;
    const active = this.activeBlock;
    const index = this.blocks.indexOf(block);
    this.blocks.splice(index, 1);
    await block.measureTemplate?.delete();
    block.measureTemplate = null;

    // The block after a removed active one slides into its index and takes over.
    this.activeBlockIndex = active === block ? Math.min(index, this.blocks.length - 1) : this.blocks.indexOf(active);
    this._advanceIfDone();
    this.render();
  }

  /** @returns {SequenceBlock|undefined} The block a per-block control belongs to. */
  _blockFrom(target) {
    const id = target.closest("[data-block-id]")?.dataset.blockId;
    return this.blocks.find((b) => b.id === id);
  }

  /**
   * Remove templates of blocks that resolved nothing, clear targets once, then fire
   * postUse + pf1PostActionUse for each block that resolved an attack, in block order.
   *
   * @param {string} result - "completed" or "cancelled"
   */
  async _endSequence(result) {
    for (const block of this.blocks) {
      if (!block.resolvedAny) await block.measureTemplate?.delete();
    }

    if (!this.sequenceResolvedAny) {
      console.debug("PF1 | Sequential attack ended before any attacks were resolved.");
      return;
    }

    if (game.settings.get("pf1", "clearTargetsAfterAttack") && game.user.targets.size) {
      if (game.release.generation >= 13) {
        game.user._onUpdateTokenTargets([]);
      } else {
        game.user.updateTokenTargets([]);
      }
      game.user.broadcastActivity({ targets: [] });
    }

    for (const block of this.blocks) {
      if (!block.resolvedAny) continue;
      const { actionUse } = block;
      await actionUse.executeScriptCalls("postUse");
      Hooks.callAll("pf1PostActionUse", actionUse, actionUse.shared.message ?? null);
      console.debug(
        'PF1 | Sequential full attack "%s (%s)" %s.',
        actionUse.item.name,
        actionUse.action.name,
        result === "cancelled" ? "cancelled after partial resolution" : "completed"
      );
    }
  }

  /**
   * After the active block's head moves: mark the sequence complete once every block is
   * done, otherwise move off an emptied active block to the next one with attacks left.
   */
  _advanceIfDone() {
    if (this.blocks.every((b) => b.done)) {
      this._completed = true;
      return;
    }
    if (!this.activeBlock.done) return;
    const n = this.blocks.length;
    for (let step = 1; step < n; step++) {
      const i = (this.activeBlockIndex + step) % n;
      if (!this.blocks[i].done) {
        this.activeBlockIndex = i;
        return;
      }
    }
  }

  /** Sequence-level keys for `shared.sequentialAttack` (DESIGN.md §9). */
  _sequenceContext(block, isFirstInSequence) {
    return {
      blockIndex: this.blocks.indexOf(block),
      blockCount: this.blocks.length,
      isFirstInSequence,
    };
  }

  /**
   * Row data for one block's attacks.
   *
   * @param {SequenceBlock} block
   * @param {string} headStatus - Status for the block's head: "current" on the active
   *   block, "head" on the others.
   */
  _blockRows(block, headStatus) {
    const { actionUse, attacks } = block;
    const rollData = actionUse.shared.rollData;

    return attacks.map((atk, i) => {
      const isResolved = block.resolvedIndices.has(i);
      const isSkipped = block.skippedIndices.has(i);
      const isHead = i === block.currentIndex && !this._completed;

      let status = "pending";
      let icon = "fa-circle-notch";
      if (isSkipped) {
        status = "skipped";
        icon = "fa-forward";
      } else if (isResolved) {
        status = "resolved";
        icon = "fa-check-circle";
      } else if (isHead) {
        status = headStatus;
        icon = "fa-crosshairs";
      }

      // An action with no attack roll has no bonus to preview — every entry would
      // read "+0". Leave the column empty rather than printing a meaningless number.
      let bonus = "";
      if (actionUse.action.hasAttack) {
        const bonusTotal =
          pf1.dice.RollPF.safeRollSync(atk.attackBonus, rollData, undefined, undefined, { minimize: true }).total ?? 0;
        bonus = bonusTotal >= 0 ? `+${bonusTotal}` : `${bonusTotal}`;
      }

      return { label: atk.label, status, icon, bonus };
    });
  }

  /** @override */
  async _prepareContext(options) {
    const remainingCount = this.blocks.reduce((n, b) => n + b.remaining, 0);
    const isLast = remainingCount === 1;

    const context = {
      multi: this._multiBlock,
      completed: this._completed,
      // "Roll All Remaining" only makes sense with 2+ attacks left — with one left,
      // "Roll Final Attack" already produces the same single-attack card.
      showRollAll: !this._completed && remainingCount >= 2,
      remainingCount,
      nextLabel: game.i18n.localize(isLast ? "SEQ.Button.RollFinal" : "SEQ.Button.RollNext"),
      nextIcon: isLast ? "fa-flag-checkered" : "fa-dice-d20",
    };

    if (!this._multiBlock) {
      const block = this.activeBlock;
      const { actionUse, attacks } = block;
      return Object.assign(context, {
        itemName: actionUse.item.name,
        actionName: actionUse.action.name,
        progress: `${this._completed ? attacks.length : block.currentIndex + 1} / ${attacks.length}`,
        rows: this._blockRows(block, "current"),
      });
    }

    const total = this.blocks.reduce((n, b) => n + b.attacks.length, 0);
    const canRemoveAny = this.blocks.length > 1 && !this._completed;
    return Object.assign(context, {
      ownerName: this.owner.name,
      progress: `${total - remainingCount} / ${total}`,
      blocks: this.blocks.map((block) => {
        const active = block === this.activeBlock && !this._completed;
        const n = block.attacks.length;
        return {
          id: block.id,
          itemName: block.actionUse.item.name,
          actionName: block.actionUse.action.name,
          progress: `${n - block.remaining} / ${n}`,
          active,
          done: block.done,
          rows: block.done ? [] : this._blockRows(block, active ? "current" : "head"),
          canRoll: !block.done && !this._completed,
          canRemove: canRemoveAny && !block.resolvedAny && !block.scriptsRun,
        };
      }),
    });
  }

  /** @override — schedule an auto-close once the whole sequence has resolved. */
  _onRender(context, options) {
    super._onRender(context, options);
    // Blocks come and go between renders; refit the window to its content.
    if (this._multiBlock) this.setPosition({ height: "auto" });
    if (this._completed && !this._autoCloseTimer && !this._resolved) {
      // Small delay so the user can see the final state.
      this._autoCloseTimer = setTimeout(() => this._finish("completed"), 800);
    }
  }

  /** @override — closing before completion is treated as a cancel. */
  async close(options) {
    if (openTrackers.get(this.owner.uuid) === this) openTrackers.delete(this.owner.uuid);
    if (this._autoCloseTimer) {
      clearTimeout(this._autoCloseTimer);
      this._autoCloseTimer = null;
    }
    if (!this._resolved) {
      this._resolved = true;
      this._resolve?.("cancelled");
    }
    return super.close(options);
  }

  /** Settle the run() promise and close the window (idempotent). */
  _finish(result) {
    if (this._resolved) return;
    this._resolved = true;
    this._resolve?.(result);
    this.close();
  }

  /**
   * Wrap an async action so it can't be double-invoked and surfaces errors.
   * The clicked button is disabled synchronously; the work re-renders on completion.
   */
  async #runAction(target, fn, errMsg) {
    if (this._busy) return;
    this._busy = true;
    if (target) target.disabled = true;
    try {
      await fn.call(this);
    } catch (err) {
      console.error(`pf1-sequential-attacks | ${errMsg}`, err);
      ui.notifications.error(game.i18n.format("SEQ.Error.Notify", { msg: errMsg }));
      if (this.rendered) this.render();
    } finally {
      this._busy = false;
      // Re-enable the button if the action returned without re-rendering — e.g. the user
      // cancelled the Edit Options dialog, which restores state and returns as-is. Without
      // this the button stays disabled until some other action triggers a render. If a
      // render did happen, `target` is a detached node from the old DOM and this is a no-op.
      if (target) target.disabled = false;
    }
  }

  // ---- Actions ---- //

  static #onRollNext(event, target) {
    return this.#runAction(target, this._resolveCurrentAttack, game.i18n.localize("SEQ.Error.ResolveAttack"));
  }

  static #onRollAll(event, target) {
    return this.#runAction(target, this._resolveAllRemaining, game.i18n.localize("SEQ.Error.ResolveRemaining"));
  }

  static #onSkip(event, target) {
    this._skipCurrentAttack();
  }

  static #onEditOptions(event, target) {
    return this.#runAction(target, () => this._editOptions(this.activeBlock), game.i18n.localize("SEQ.Error.EditOptions"));
  }

  /** Roll a specific block's head; that block becomes the active one (DESIGN.md §4). */
  static #onRollBlock(event, target) {
    const block = this._blockFrom(target);
    if (!block || block.done) return;
    return this.#runAction(target, () => {
      this.activeBlockIndex = this.blocks.indexOf(block);
      return this._resolveCurrentAttack();
    }, game.i18n.localize("SEQ.Error.ResolveAttack"));
  }

  static #onEditBlock(event, target) {
    const block = this._blockFrom(target);
    if (!block) return;
    return this.#runAction(target, () => this._editOptions(block), game.i18n.localize("SEQ.Error.EditOptions"));
  }

  static #onRemoveBlock(event, target) {
    const block = this._blockFrom(target);
    if (!block) return;
    return this.#runAction(target, () => this._removeBlock(block), game.i18n.localize("SEQ.Error.RemoveBlock"));
  }

  static #onCancel(event, target) {
    this._completed = true;
    this._finish("cancelled");
  }

  static #onDone(event, target) {
    this._completed = true;
    this._finish("completed");
  }

  /**
   * Refresh rollData and re-apply the dialog's options so attacks rolled from this point
   * reflect the current actor state. Shared by the one-at-a-time and batch resolution paths.
   *
   * @param {SequenceBlock} block - The block about to roll.
   * @param {number} startIdx - Block-local index of the first attack about to be rolled. Used to
   *   decide whether the one-shot charge bonus still applies (only the very first attack benefits).
   */
  async _prepareSequenceRollData(block, startIdx) {
    const actionUse = block.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;

    // Refresh rollData to pick up any updated actor stats (buffs toggled between attacks, etc.)
    // Note: We do NOT call actor.prepareData() here — the vanilla flow never does, and doing so
    // causes duplicate resource warnings and can corrupt derived data (e.g. actor size).
    // Foundry automatically re-prepares actors when their data changes (buff toggles, etc.),
    // so getRollData() already picks up the latest state.
    _refreshRollData(actionUse);
    const rollData = shared.rollData;

    // If charge was selected in the dialog, only the first attack of the whole sequence
    // benefits. Clear the selection and remove the charge bonus for all subsequent attacks.
    if ((startIdx > 0 || this.sequenceStarted) && shared.formData?.charge) {
      shared.formData.charge = false;
      shared.charge = false;
      const chargeLabel = game.i18n.localize("PF1.Charge");
      const chargeTag = `[${chargeLabel}]`;
      shared.attackBonus = shared.attackBonus.filter((part) => !part?.includes?.(chargeTag));
    }

    // Re-apply the form-based alterations (power attack, d20 override, conditionals, etc.)
    // We need to re-run alterRollData with the saved form data since getRollData() resets rollData
    // but we need to preserve the state. We selectively re-apply key values.
    rollData.fullAttack = shared.fullAttack ? 1 : 0;

    // Restore d20 check override (e.g. "11" to force all attack rolls to 11)
    if (shared.formData?.["d20"]) {
      rollData.d20 = shared.formData["d20"];
    }
    if (shared.powerAttack) {
      const basePowerAttackBonus = rollData.action?.powerAttack?.damageBonus ?? 2;
      let powerAttackBonus = (1 + Math.floor(rollData.attributes.bab.total / 4)) * basePowerAttackBonus;
      const paMult = action.getPowerAttackMult({ rollData });
      powerAttackBonus = Math.floor(powerAttackBonus * paMult);
      const powerAttackPenalty = -(1 + Math.floor(rollData.attributes.bab.total / 4));
      rollData.powerAttackBonus = powerAttackBonus;
      rollData.powerAttackPenalty = powerAttackPenalty;

      // astora-mod's Combat Options resolves these through its own change targets.
      const resolved = game.astoraMod?.combatOptions?.powerAttack?.(actionUse);
      if (resolved) {
        rollData.powerAttackBonus = resolved.bonus;
        rollData.powerAttackPenalty = resolved.penalty;
      }
    } else {
      rollData.powerAttackBonus = 0;
      rollData.powerAttackPenalty = 0;
    }

    // Re-expand conditionals into rollData
    if (shared.conditionals?.length) {
      const rollDataConds = {};
      for (const condId of shared.conditionals) {
        const conditional = action.conditionals.get(condId);
        if (!conditional) continue;
        const tag = pf1.utils.createTag(conditional.name);
        for (const [modKey, modifier] of conditional.modifiers.entries()) {
          if (modifier.formula == 0) continue;
          const conditionalRoll = await pf1.dice.RollPF.safeRoll(modifier.formula, rollData, undefined, undefined, {
            allowInteractive: false,
          });
          if (conditionalRoll.err) continue;
          rollDataConds[tag] ??= {};
          rollDataConds[tag][modKey] = conditionalRoll.total;
        }
      }
      rollData.conditionals = rollDataConds;
    }

    // Collect current targets
    await actionUse.getTargets();
  }

  /**
   * Run the block's "use"-category script calls, once per block. Initializes the
   * first-attack-only bonus arrays so scripts can push to them.
   *
   * @param {SequenceBlock} block
   * @returns {Promise<boolean>} false if a script rejected the action (sequence should abort).
   */
  async _runUseScripts(block) {
    const shared = block.actionUse.shared;
    shared.firstAttackBonus ??= [];
    shared.firstAttackDamageBonus ??= [];
    await block.actionUse.executeScriptCalls();
    if (shared.scriptData?.reject) return false;
    block.scriptsRun = true;
    return true;
  }

  /**
   * Build a single ChatAttack (attack roll, damage, ammo, effect notes) for one attack.
   * Used both for one-at-a-time resolution and for assembling the all-remaining card.
   *
   * @param {SequenceBlock} block - The block the attack belongs to.
   * @param {object} atk - The attack entry from the block's attack list.
   * @param {number} idx - The attack's index in its block (drives conditionals / attackCount).
   * @param {boolean} applyFirstAttackBonuses - Whether first-attack-only bonuses apply to this attack.
   * @returns {Promise<ChatAttack>}
   */
  async _buildChatAttack(block, atk, idx, applyFirstAttackBonuses) {
    const actionUse = block.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;
    const rollData = shared.rollData;

    const conditionalParts = actionUse._getConditionalParts(atk, { index: idx });
    rollData.attackCount = idx;

    const chatAttack = new pf1.actionUse.ChatAttack(action, {
      label: atk.label,
      rollData,
      targets: game.user.targets,
      actionUse,
    });

    // Mirror PF1's own branch in generateChatAttacks: an action whose type carries
    // no attack roll gets damage and notes only. Without this, a multi-entry
    // attack-less action (repeated uses of a spell) would sprout an attack roll
    // per entry.
    if (action.hasAttack && atk.type !== "manyshot") {
      // PF1's addAttack filter removes "0" but not "(0)" — extra attacks with no configured
      // bonus formula get bonus:"(0)", which slips through and renders as "+0 [undefined]".
      // Strip outer parens from the unflaired value and skip it if it reduces to "0".
      const rawAtkBonus = atk.attackBonus;
      const atkBonusPart = (() => {
        if (!rawAtkBonus || rawAtkBonus == 0) return rawAtkBonus;
        if (typeof rawAtkBonus === 'string') {
          const bare = pf1.utils.formula.unflair(rawAtkBonus).replace(/[\s()]/g, '');
          if (bare === '0') return undefined;
        }
        return rawAtkBonus;
      })();
      await chatAttack.addAttack({
        extraParts: [
          ...shared.attackBonus,
          ...(applyFirstAttackBonuses ? (shared.firstAttackBonus ?? []) : []),
          atkBonusPart,
        ],
        conditionalParts,
      });
    }

    // Add damage
    if (action.hasDamage) {
      const extraParts = foundry.utils.deepClone(shared.damageBonus);
      if (applyFirstAttackBonuses && shared.firstAttackDamageBonus?.length) {
        extraParts.push(...shared.firstAttackDamageBonus);
      }
      const nonCritParts = [];
      const critParts = [];

      if (rollData.powerAttackBonus > 0) {
        const label = ["rwak", "twak", "rsak"].includes(action.actionType)
          ? game.i18n.localize("PF1.DeadlyAim")
          : game.i18n.localize("PF1.PowerAttack");
        const powerAttackBonus = rollData.powerAttackBonus;
        const powerAttackCritBonus = powerAttackBonus * (rollData.action?.powerAttack?.critMultiplier ?? 1);
        nonCritParts.push(`${powerAttackBonus}[${label}]`);
        critParts.push(`${powerAttackCritBonus}[${label}]`);
      }

      let flavor = null;
      if (atk.type === "manyshot") flavor = game.i18n.localize("PF1.Manyshot");
      await chatAttack.addDamage({
        flavor,
        extraParts: [...extraParts, ...nonCritParts],
        critical: false,
        conditionalParts,
      });

      if (chatAttack.hasCritConfirm) {
        await chatAttack.addDamage({
          extraParts: [...extraParts, ...critParts],
          critical: true,
          conditionalParts,
        });
      }
    }

    atk.chatAttack = chatAttack;

    // Fill in ammo details
    if (atk.hasAmmo) {
      chatAttack.setAmmo(atk.ammo.id);
      const misfire = action.misfire ?? 0;
      if (chatAttack.ammo) {
        const d20 = chatAttack.attack?.d20?.total;
        chatAttack.ammo.misfire = d20 <= misfire;
      }
    }

    // Effect notes for this attack
    if (atk.type !== "manyshot") {
      await chatAttack.addEffectNotes({ rollData });
    }

    delete rollData.attackCount;

    return chatAttack;
  }

  /**
   * Resolve the active block's head: re-prepare the actor, roll the single attack, and post its chat card.
   */
  async _resolveCurrentAttack() {
    const block = this.activeBlock;
    const idx = block.currentIndex;
    const actionUse = block.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;
    const item = actionUse.item;
    const atk = block.attacks[idx];

    // Refresh rollData + re-apply dialog options for this attack's actor state.
    await this._prepareSequenceRollData(block, idx);
    const rollData = shared.rollData;

    // Preserve the routine-level shared state until the one-time use lifecycle has run.
    const origAttacks = shared.attacks;
    const origChatAttacks = shared.chatAttacks;

    // Block-level "first" gates the block's own once-per-use costs and scripts;
    // sequence-level "first" gates the first-attack-only bonuses.
    const isFirstInBlock = !block.scriptsRun;
    const isFirstInSequence = !this.sequenceStarted;
    shared.sequentialAttack = {
      index: idx,
      total: block.attacks.length,
      isFirst: isFirstInBlock,
      isLast: idx === block.attacks.length - 1,
      ...this._sequenceContext(block, isFirstInSequence),
    };

    // Script calls ("use" category) run once per block, on its first resolved attack.
    // Running here — before addAttack — ensures that any bonus pushes from scripts
    // (e.g. shared.attackBonus.push(...)) are included in the first attack's roll.
    if (isFirstInBlock) {
      if (!(await this._runUseScripts(block))) {
        shared.attacks = origAttacks;
        shared.chatAttacks = origChatAttacks;
        this._finish("cancelled");
        return;
      }
    }
    this.sequenceStarted = true;

    // Build the ChatAttack for this single attack.
    const chatAttack = await this._buildChatAttack(block, atk, idx, isFirstInSequence);
    shared.chatAttacks = [chatAttack];

    // Save DC
    shared.save = action.save.type;
    shared.saveDC = action.getDC(rollData);

    // Reset footnotes and template data for this attack's card
    shared.templateData.footnotes = [];
    await actionUse.addFootnotes();

    // Narrow shared.attacks to just the current attack BEFORE firing hooks,
    // so that hooks iterating shared.attacks (e.g. fumble confirmation) see
    // only the current attack with its populated chatAttack.
    shared.attacks = [atk];

    // Fire pf1PreActionUse for every sequential attack so per-attack hooks
    // (fumble confirmation, damage footnotes, etc.) run for each attack.
    // Hooks can check shared.sequentialAttack for sequence context.
    const hookResult = Hooks.call("pf1PreActionUse", actionUse);
    if (hookResult === false) {
      shared.attacks = origAttacks;
      shared.chatAttacks = origChatAttacks;
      this._finish("cancelled");
      return;
    }

    // Per-Use script calls for this one attack. Vanilla runs them from its own
    // `use` pass over the finished card; this path never reaches that loop,
    // because each attack gets its own card. `shared.reject` cancels the sequence,
    // matching what it does to a whole action in vanilla.
    await _runPerUseScripts(actionUse, [chatAttack], idx, block.attacks.length);
    if (shared.reject) {
      shared.attacks = origAttacks;
      shared.chatAttacks = origChatAttacks;
      this._finish("cancelled");
      return;
    }

    // Subtract ammo for this single attack
    const ammoCost = action.ammo.cost;
    if (ammoCost !== 0 && atk.hasAmmo) {
      await _subtractSingleAttackAmmo(actionUse, atk, ammoCost);
    }

    // Subtract charges.
    if (atk.chargeCost && atk.chargeCost > 0) {
      // Per-attack action: drain this attack's own cost as it resolves.
      shared.totalChargeCost = atk.chargeCost;
      await item.addCharges(-atk.chargeCost);
    } else if (isFirstInBlock && shared._wholeChargeCost > 0) {
      // Whole-use cost (spell slot, single-charge item): drain ONCE per block, on its
      // first resolved attack — mirrors vanilla process().
      shared.totalChargeCost = shared._wholeChargeCost;
      await item.addCharges(-shared._wholeChargeCost);
    }

    // Self-charged action uses (only on the block's first resolved attack)
    if (isFirstInBlock && action.isSelfCharged) {
      await action.update({ "uses.self.value": action.uses.self.value - 1 });
    }

    // Update remaining ammo display
    actionUse.updateAmmoUsage();

    // Handle Dice So Nice
    await actionUse.handleDiceSoNice();

    // Build and optionally post the chat card for this single attack
    await _postCard(actionUse);
    block.resolvedAny = true;

    // Restore shared arrays
    shared.attacks = origAttacks;
    shared.chatAttacks = origChatAttacks;

    // Mark as resolved and advance this block's head
    block.resolvedIndices.add(idx);
    block.currentIndex = idx + 1;
    this._advanceIfDone();

    // Update the dialog
    this.render();
  }

  /**
   * Resolve every remaining attack, one chat card per block in block order — i.e. the
   * vanilla PF1 full-attack behaviour for whatever is left of each block.
   */
  async _resolveAllRemaining() {
    for (const block of this.blocks) {
      if (block.done) continue;
      await this._resolveBlockRemaining(block);
      if (this._resolved) return; // cancelled mid-batch
    }
    this._completed = true;
    this.render();
  }

  /**
   * Resolve one block's remaining attacks together in a single chat card.
   *
   * Unlike one-at-a-time resolution, the actor state is snapshotted once for the whole batch,
   * so buffs/debuffs toggled between these attacks are NOT picked up individually.
   *
   * @param {SequenceBlock} block
   */
  async _resolveBlockRemaining(block) {
    const actionUse = block.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;
    const item = actionUse.item;

    const startIdx = block.currentIndex;
    const remaining = block.attacks.slice(startIdx);
    if (remaining.length === 0) return;

    // Snapshot actor state once for the whole batch (single-card / vanilla behaviour).
    await this._prepareSequenceRollData(block, startIdx);
    const rollData = shared.rollData;

    // Preserve the routine-level shared state until the one-time use lifecycle has run.
    const origAttacks = shared.attacks;
    const origChatAttacks = shared.chatAttacks;

    // Block-level "first": nothing in this block has been rolled yet.
    // Sequence-level "first": nothing in the whole sequence has been rolled yet.
    const isFirstInBlock = !block.scriptsRun;
    const isFirstInSequence = !this.sequenceStarted;
    shared.sequentialAttack = {
      index: startIdx,
      total: block.attacks.length,
      isFirst: isFirstInBlock,
      isLast: true,
      batch: true,
      count: remaining.length,
      ...this._sequenceContext(block, isFirstInSequence),
    };

    // Script calls ("use" category) run once per block, only if it has resolved nothing yet.
    if (isFirstInBlock) {
      if (!(await this._runUseScripts(block))) {
        shared.attacks = origAttacks;
        shared.chatAttacks = origChatAttacks;
        this._finish("cancelled");
        return;
      }
    }
    this.sequenceStarted = true;

    // Build a ChatAttack for every remaining attack into one card. First-attack-only bonuses
    // apply only to the very first attack of the entire sequence.
    const chatAttacks = [];
    for (let i = 0; i < remaining.length; i++) {
      const atk = remaining[i];
      const idx = startIdx + i;
      const applyFirstAttackBonuses = isFirstInSequence && i === 0;
      chatAttacks.push(await this._buildChatAttack(block, atk, idx, applyFirstAttackBonuses));
    }
    shared.chatAttacks = chatAttacks;
    shared.attacks = remaining;

    // Save DC
    shared.save = action.save.type;
    shared.saveDC = action.getDC(rollData);

    // Footnotes (computed once across all attacks in the card)
    shared.templateData.footnotes = [];
    await actionUse.addFootnotes();

    // Fire pf1PreActionUse once for the whole card (vanilla fires it once per use).
    const hookResult = Hooks.call("pf1PreActionUse", actionUse);
    if (hookResult === false) {
      shared.attacks = origAttacks;
      shared.chatAttacks = origChatAttacks;
      this._finish("cancelled");
      return;
    }

    // Per-Use script calls, one per attack in the batch — the same count they
    // would have had resolving one at a time.
    await _runPerUseScripts(actionUse, chatAttacks, startIdx, block.attacks.length);
    if (shared.reject) {
      shared.attacks = origAttacks;
      shared.chatAttacks = origChatAttacks;
      this._finish("cancelled");
      return;
    }

    // Subtract ammo and charges per attack.
    const ammoCost = action.ammo.cost;
    let batchChargeCost = 0;
    for (const atk of remaining) {
      if (ammoCost !== 0 && atk.hasAmmo) {
        await _subtractSingleAttackAmmo(actionUse, atk, ammoCost);
      }
      if (atk.chargeCost && atk.chargeCost > 0) {
        batchChargeCost += atk.chargeCost;
        await item.addCharges(-atk.chargeCost);
      }
    }
    // Whole-use cost (non per-attack): drain ONCE, only if this batch includes the
    // block's first resolved attack — mirrors vanilla process(). Per-attack costs were
    // summed in the loop above instead.
    if (!action.uses?.perAttack && isFirstInBlock && shared._wholeChargeCost > 0) {
      batchChargeCost = shared._wholeChargeCost;
      await item.addCharges(-shared._wholeChargeCost);
    }
    if (batchChargeCost > 0) shared.totalChargeCost = batchChargeCost;

    // Self-charged action uses (only if this batch includes the block's first resolved attack)
    if (isFirstInBlock && action.isSelfCharged) {
      await action.update({ "uses.self.value": action.uses.self.value - 1 });
    }

    // Update remaining ammo display
    actionUse.updateAmmoUsage();

    // Handle Dice So Nice (shows all attacks' dice together)
    await actionUse.handleDiceSoNice();

    // Build and optionally post the single chat card for the whole batch
    await _postCard(actionUse);
    block.resolvedAny = true;

    // Restore shared arrays
    shared.attacks = origAttacks;
    shared.chatAttacks = origChatAttacks;

    // Mark every remaining attack in the block as resolved.
    for (let idx = startIdx; idx < block.attacks.length; idx++) {
      block.resolvedIndices.add(idx);
    }
    block.currentIndex = block.attacks.length;
  }

  /**
   * Reopen a block's attack dialog so the user can change options (power attack,
   * flanking, PBS, d20 override, conditionals, etc.) for its remaining attacks.
   *
   * @param {SequenceBlock} block
   */
  async _editOptions(block) {
    const actionUse = block.actionUse;
    const shared = actionUse.shared;

    // Save current state for rollback if the user cancels the dialog
    const savedAttackBonus = [...shared.attackBonus];
    const savedDamageBonus = [...shared.damageBonus];
    const savedFormData = shared.formData;
    const savedFlags = {
      powerAttack: shared.powerAttack,
      pointBlankShot: shared.pointBlankShot,
      flanking: shared.flanking,
      highGround: shared.highGround,
      charge: shared.charge,
    };

    // Reset bonus arrays to the pre-alterRollData snapshot so alterRollData
    // can cleanly push new values without duplicating previous entries.
    shared.attackBonus = [...(shared._preAlterAttackBonus ?? [])];
    shared.damageBonus = [...(shared._preAlterDamageBonus ?? [])];
    shared.powerAttack = false;
    shared.pointBlankShot = false;
    shared.flanking = false;
    shared.highGround = false;
    shared.charge = false;

    // Refresh rollData so the dialog reads fresh actor state
    _refreshRollData(actionUse);

    // Show the edit-options dialog (pre-populated, no attacks table, OK button)
    const form = await new SequentialEditDialog(actionUse, savedFormData).show();

    if (form) {
      // Force full attack — we're mid-sequence
      form.fullAttack = true;

      // Apply the new options
      shared.formData = form;
      actionUse.formData = form;
      await actionUse.alterRollData(form);

      // Re-process conditionals with the new selections
      await actionUse.handleConditionals();

      console.debug("PF1 | Sequential attack options updated mid-sequence.");
      this.render();
    } else {
      // Cancelled — restore previous state
      shared.attackBonus = savedAttackBonus;
      shared.damageBonus = savedDamageBonus;
      shared.formData = savedFormData;
      shared.powerAttack = savedFlags.powerAttack;
      shared.pointBlankShot = savedFlags.pointBlankShot;
      shared.flanking = savedFlags.flanking;
      shared.highGround = savedFlags.highGround;
      shared.charge = savedFlags.charge;
      console.debug("PF1 | Sequential attack option edit cancelled.");
    }
  }

  /**
   * Skip the active block's head without rolling it.
   */
  _skipCurrentAttack() {
    const block = this.activeBlock;
    block.skippedIndices.add(block.currentIndex);
    block.currentIndex++;
    this._advanceIfDone();
    this.render();
  }
}

// ---- Sequential Edit Options Dialog ---- //

/**
 * Subclass of the PF1 AttackDialog used mid-sequence to let the user change
 * attack options (power attack, flanking, PBS, d20 override, conditionals, etc.)
 * between sequential attacks.
 *
 * Differences from the standard dialog:
 *  - Pre-populated with the previous formData selections
 *  - Attacks table hidden (attack list is already committed)
 *  - Single "OK" button instead of Single Attack / Full Attack
 *  - Haste / Rapid Shot / Manyshot toggles don't modify the attack list
 */
class SequentialEditDialog extends pf1.applications.AttackDialog {
  constructor(actionUse, previousFormData, appOptions = {}) {
    super(actionUse, appOptions);

    const prev = previousFormData ?? {};

    // Pre-populate checkboxes from previous form data
    const flagKeys = [
      "power-attack", "primary-attack", "flanking", "highGround", "charge",
      "haste-attack", "manyshot", "rapid-shot", "point-blank-shot",
      "measure-template", "cl-check", "concentration",
    ];
    for (const key of flagKeys) {
      if (key in prev) this.flags[key] = !!prev[key];
    }

    // Pre-populate text / select inputs
    const attrKeys = [
      "d20", "attack-bonus", "damage-bonus",
      "damage-ability-multiplier", "rollMode", "held",
    ];
    for (const key of attrKeys) {
      if (prev[key] != null && prev[key] !== "") {
        this.attributes[key] = prev[key];
      }
    }

    // Pre-populate conditionals
    for (const key of Object.keys(prev)) {
      if (key.startsWith("conditionals.") && this.conditionals[key]) {
        this.conditionals[key].enabled = !!prev[key];
      }
    }
  }

  /** @override — attack list is committed; don't add/remove extra attacks. */
  _toggleExtraAttack() {}

  get title() {
    return game.i18n.format("SEQ.EditTitle", { name: this.actionUse.item.name });
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // Hide the committed attacks table
    html.find(".attacks").hide();

    // Replace Single Attack / Full Attack with a single "OK" button
    html.find(`button[name="attack_single"]`).remove();
    html.find(`button[name="attack_full"]`)
      .html(`<i class="fas fa-check"></i> ${game.i18n.localize("SEQ.Button.OK")}`);
  }
}

// ---- Batch-start API (DESIGN.md §10) ---- //

/**
 * Start several of one attacker's actions as a single sequence, or add them to the
 * attacker's open one. Each entry goes through the ordinary item.use(), one after
 * another, so each shows its own attack dialog unless `skipDialog` is set. A new tracker
 * renders once every entry has been tried, holding all of them from its first frame.
 *
 * An entry that can't join is left out with a warning (DESIGN.md §10.4); one whose
 * dialog was cancelled is left out silently.
 *
 * @param {Actor|TokenDocument|Token|string} subject - The attacker, or its uuid.
 * @param {Array<Item|string|{item: Item|string, action?: string}>} entries - Items as
 *   documents, ids on the attacker, or uuids, each optionally with an action id.
 * @param {object} [options]
 * @param {boolean} [options.skipDialog=false] - Quick-roll every entry.
 * @returns {Promise<{result: string, dropped: Array<{entry: *, reason: string}>}>} Settles
 *   when the sequence ends. `result` is "completed", "cancelled", or "empty" when nothing joined.
 */
async function startSequence(subject, entries, { skipDialog = false } = {}) {
  const attacker = _resolveAttacker(subject);
  if (!attacker) throw new Error(`pf1-sequential-attacks | startSequence: no attacker found for ${subject}`);
  const owner = _ownerOfActor(attacker.actor);

  // Registered before any dialog opens, so a manual use from the same attacker meanwhile
  // joins this sequence instead of opening a second tracker under the same id.
  let tracker = _openTrackerFor(owner);
  const isNew = !tracker;
  if (isNew) {
    tracker = new SequentialAttackTracker(owner);
    openTrackers.set(owner.uuid, tracker);
  }

  const dropped = [];
  for (const entry of entries) {
    const item = _resolveEntryItem(attacker.actor, entry);
    let reason;
    if (!item) reason = "notFound";
    else if (_ownerOfActor(item.actor)?.uuid !== owner.uuid) reason = "owner";
    else if (!item.hasAction || !_canJoinSequence(item)) reason = "type";
    else reason = await _useIntoSequence(tracker, item, entry, attacker.token, skipDialog);

    if (reason) {
      dropped.push({ entry, reason });
      if (reason !== "cancelled") {
        const name = item?.name ?? String(entry?.item ?? entry);
        console.warn(`pf1-sequential-attacks | startSequence: "${name}" left out (${reason}).`);
        const key = reason === "outside" ? "SEQ.Warn.BatchOutside" : "SEQ.Warn.BatchNotAdded";
        ui.notifications.warn(game.i18n.format(key, { name }));
      }
    }
    // An already-open tracker can be closed by the user mid-batch.
    if (tracker._resolved) break;
  }

  if (!isNew) return { result: await tracker.ended, dropped };

  if (!tracker.blocks.length) {
    if (openTrackers.get(owner.uuid) === tracker) openTrackers.delete(owner.uuid);
    tracker._resolved = true;
    tracker._resolveEnded("empty");
    return { result: "empty", dropped };
  }

  return { result: await tracker.run(), dropped };
}

/**
 * item.use() one entry into the tracker. Settles as soon as the wrapper reports; the use
 * itself stays pending until the sequence ends.
 *
 * @returns {Promise<string|null>} null when the entry joined, otherwise why it didn't:
 *   a reason reported by _batchProcess(), "cancelled" for a cancelled action picker,
 *   "outside" when the use resolved without reaching the sequence, or "error".
 */
function _useIntoSequence(tracker, item, entry, token, skipDialog) {
  return new Promise((resolve) => {
    let reported = false;
    const report = ({ ok, reason }) => {
      reported = true;
      resolve(ok ? null : reason);
    };
    const actionId = entry?.documentName ? undefined : entry?.action;
    const presets = entry?.documentName ? undefined : entry?.presets;
    item
      .use({
        actionId,
        skipDialog,
        token: token ?? undefined,
        options: { sequentialAttacks: { tracker, report, presets } },
      })
      .then((result) => {
        // Unreported means another module's wrapper resolved the use before this one ran.
        if (!reported) resolve(result === null ? "cancelled" : "outside");
      })
      .catch((err) => {
        console.error(`pf1-sequential-attacks | startSequence: "${item.name}" threw.`, err);
        if (!reported) resolve("error");
      });
  });
}

/**
 * @param {Actor|TokenDocument|Token|string} subject
 * @returns {{actor: Actor, token: TokenDocument|null}|null}
 */
function _resolveAttacker(subject) {
  if (typeof subject === "string") subject = fromUuidSync(subject);
  if (subject?.document?.documentName === "Token") subject = subject.document; // placeable
  if (subject?.documentName === "Token") return subject.actor ? { actor: subject.actor, token: subject } : null;
  if (subject?.documentName === "Actor") return { actor: subject, token: subject.token ?? null };
  return null;
}

/**
 * @param {Actor} actor - The attacker.
 * @param {Item|string|{item: Item|string, action?: string}} entry
 * @returns {Item|null}
 */
function _resolveEntryItem(actor, entry) {
  const ref = entry?.documentName ? entry : typeof entry === "object" ? entry?.item : entry;
  if (ref?.documentName === "Item") return ref;
  if (typeof ref !== "string") return null;
  return actor.items.get(ref) ?? (ref.includes(".") ? fromUuidSync(ref) : null);
}

// ---- Helper: Post one card ---- //

/**
 * Build and post the card for the attacks now on `shared.attacks`, then fire
 * `pf1SequentialAttacks.postCard(actionUse, message)`.
 *
 * `pf1PostActionUse` fires once, after the tracker closes, with only the LAST card
 * and the full attack list restored — so it can't tell which card an attack went
 * to. This hook is the per-card counterpart: `shared.attacks` still holds exactly
 * this card's attacks, in the card's own order, so an attack's index there is its
 * index in the card's `system.rolls.attacks`.
 *
 * `message` is null when the card was hidden (`hideChat`) or a
 * `pf1PreDisplayActionUse` hook blocked it — the same null `pf1PostActionUse` passes.
 *
 * @param {ActionUse} actionUse - The in-flight use.
 * @returns {Promise<ChatMessage|null>}
 */
async function _postCard(actionUse) {
  await actionUse.getMessageData();

  let message = null;
  if (actionUse.shared.scriptData?.hideChat !== true) {
    // postMessage hands back `shared` rather than a message when a pre-display hook vetoes it.
    const posted = await actionUse.postMessage();
    if (posted instanceof ChatMessage) message = posted;
  }

  Hooks.callAll("pf1SequentialAttacks.postCard", actionUse, message);
  return message;
}

// ---- Helper: Per-Use script calls ---- //

/**
 * Fire pf1-new-script-hooks' Per Use category for each card built here.
 *
 * Vanilla runs that category from its own `use` pass, looping the finished card's
 * rows. Sequential mode posts a card per attack and never reaches that loop, so it
 * drives the same category itself and the count comes out identical either way.
 *
 * Entirely optional: no-ops when the module is absent or too old to publish the API.
 *
 * @param {ActionUse} actionUse - The in-flight use.
 * @param {ChatAttack[]} chatAttacks - Rows on the card about to post.
 * @param {number} startIdx - Index of the first of them in the whole sequence.
 * @param {number} total - Attacks in the whole sequence.
 */
async function _runPerUseScripts(actionUse, chatAttacks, startIdx, total) {
  const runPerUse = game.modules.get("pf1-new-script-hooks")?.api?.runPerUse;
  if (typeof runPerUse !== "function") return;

  for (let i = 0; i < chatAttacks.length; i++) {
    await runPerUse(actionUse, {
      index: startIdx + i,
      total,
      chatAttack: chatAttacks[i],
      sequential: true,
    });
    if (actionUse.shared?.reject) return;
  }
}

// ---- Helper: Subtract ammo for a single attack ---- //

async function _subtractSingleAttackAmmo(actionUse, atk, ammoCost) {
  if (!actionUse.action.hasAttack) return;
  if (!actionUse.action.ammo.type) return;
  if (!atk.ammo) return;

  const actor = actionUse.actor;
  const ammoItem = actor.items.get(atk.ammo.id);
  if (!ammoItem) return;
  if (ammoItem.system.abundant) return;

  const newQty = (ammoItem.system.quantity || 0) - ammoCost;
  await actor.updateEmbeddedDocuments("Item", [{ _id: atk.ammo.id, "system.quantity": newQty }]);
}
