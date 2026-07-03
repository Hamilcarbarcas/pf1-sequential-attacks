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
  game.settings.register("pf1-sequential-attacks", "sequentialAttacks", {
    name: "Sequential Full Attacks",
    hint: "When enabled, full attacks are rolled one at a time, allowing retargeting and effect changes between attacks.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
});

// ---- Wrapper Registration ---- //

Hooks.once("ready", () => {
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

  console.log("pf1-sequential-attacks | Sequential Attacks wrapper registered (MIXED priority).");
});

// ---- Core Wrapper ---- //

/**
 * Wrapper around ActionUse.prototype.process().
 * If sequential attacks are enabled and this is a full attack with multiple attacks,
 * we take over and run each attack one at a time. Otherwise we fall through to the
 * original method.
 */
async function sequentialProcessWrapper(wrapped, { skipDialog = false } = {}) {
  // Bail out early if the setting is off — always chain to other wrappers
  if (!game.settings.get("pf1-sequential-attacks", "sequentialAttacks")) {
    return wrapped({ skipDialog });
  }

  const actionUse = this; // `this` is the ActionUse instance
  const action = actionUse.action;

  // Quick pre-check: only full attacks with attack rolls can be sequential.
  // If the action doesn't have attack rolls, just chain normally.
  if (!action.hasAttack) {
    return wrapped({ skipDialog });
  }

  // If the dialog was already skipped (e.g. a downstream wrapper or macro), chain normally.
  if (skipDialog) {
    return wrapped({ skipDialog });
  }

  // Consumables and class features are rarely used in sequential full attacks
  // and may be handled by other wrappers (e.g. Nevela's Automation Suite) that bypass
  // createAttackDialog(). To avoid double-dialog issues, chain directly for these types.
  // Note: spells are intentionally allowed through — NAS only intercepts them when
  // automaticBuffs is enabled; with that setting off it falls through to wrapped() anyway.
  const itemType = actionUse.item?.type;
  const itemSubType = actionUse.item?.subType;
  if (itemType === "consumable" || (itemType === "feat" && itemSubType === "classFeat")) {
    return wrapped({ skipDialog });
  }

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
  actionUse.getRollData();

  actionUse.shared.fullAttack = true;
  await actionUse.generateAttacks(true);

  // Initialize first-attack-only arrays before the dialog fires any script calls
  // (e.g. via pf1PostAttackDialog hooks), so scripts that push to them don't error.
  actionUse.shared.firstAttackBonus = [];
  actionUse.shared.firstAttackDamageBonus = [];

  // Show the dialog
  const form = await actionUse.createAttackDialog();
  if (!form) {
    console.debug("PF1 | Sequential attack cancelled in attack prompt.");
    return;
  }

  const shared = actionUse.shared;

  // Check if a pre-use script (e.g. pf1-new-script-hooks) set the reject flag
  if (shared.reject) {
    console.debug("PF1 | Sequential attack rejected by script call (shared.reject).");
    return;
  }

  // ---- Phase 2: Does this qualify for sequential? ---- //
  // Check the dialog result WITHOUT calling alterRollData yet — that method pushes
  // to shared.attackBonus/damageBonus, and calling it here would cause double-counting
  // if wrapped() later calls it again for the non-sequential path.
  const isFullAttack = form.fullAttack !== false;
  if (!isFullAttack || shared.attacks.length <= 1) {
    // Does NOT qualify for sequential. Hand off to the full wrapper chain.
    // We've already consumed the dialog and run pre-dialog steps, so we need
    // to ensure downstream wrappers (or vanilla) don't re-run the dialog
    // or re-run the idempotent setup steps. We accomplish this by:
    //   1. Monkey-patching createAttackDialog to return our cached result
    //   2. Calling wrapped() — each wrapper in the chain will re-run the
    //      idempotent setup (checkRequirements, autoSelectAmmo, getRollData,
    //      generateAttacks) which is safe, and then hit our patched dialog.
    actionUse.createAttackDialog = async () => form;
    console.debug("PF1 | Sequential mode: action does not qualify, chaining to wrapped().");
    return wrapped({ skipDialog: false });
  }

  // ---- Phase 3: Sequential mode activates ---- //
  // Now it's safe to apply the dialog results — we own the rest of the flow.
  // This necessarily skips downstream wrappers since we need per-attack control
  // over the roll-and-post cycle. For weapon attacks (the primary use case)
  // this is fine — Nevela's only runs custom logic for spells/consumables/classFeats,
  // and those rarely have multi-attack full attacks.

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
      return { err: pf1.actionUse.ERR_REQUIREMENT, code: pf1.actionUse.ERR_REQUIREMENT.INSUFFICIENT_AMMO };
    }
  }

  // Handle conditionals (once, shared across all attacks)
  await actionUse.handleConditionals();

  // Prepare charge cost
  await actionUse.prepareChargeCost();

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
      return { err: pf1.actionUse.ERR_REQUIREMENT, code: pf1.actionUse.ERR_REQUIREMENT.INSUFFICIENT_CHARGES };
    }
  }

  reqErr = await actionUse.checkAttackRequirements();
  if (reqErr > 0) return { err: pf1.actionUse.ERR_REQUIREMENT, code: reqErr };

  // Prompt measure template (once for the whole sequence)
  let measureTemplate = null;
  if (shared.useMeasureTemplate && canvas.scene) {
    measureTemplate = await actionUse.promptMeasureTemplate();
    if (measureTemplate === null) {
      console.debug("PF1 | Sequential attack cancelled during template placement.");
      return;
    }
  }

  // Collect targets
  await actionUse.getTargets();

  // ---- Phase 4: Sequential attack loop ---- //

  const allAttacks = [...shared.attacks];
  const tracker = new SequentialAttackTracker(actionUse, allAttacks);

  // Show the tracker dialog (non-blocking — we drive it with promises)
  const trackerResult = await tracker.run();

  if (!tracker.sequenceResolvedAny) {
    await measureTemplate?.delete();
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

  await actionUse.executeScriptCalls("postUse");
  Hooks.callAll("pf1PostActionUse", actionUse, shared.message ?? null);

  if (trackerResult === "cancelled") {
    console.debug('PF1 | Sequential full attack "%s (%s)" cancelled after partial resolution.', item.name, action.name);
    return actionUse;
  }

  console.debug('PF1 | Sequential full attack "%s (%s)" completed.', item.name, action.name);
  return actionUse;
}

// ---- Sequential Attack Tracker (ApplicationV2) ---- //

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class SequentialAttackTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actionUse, allAttacks) {
    super({});
    this.actionUse = actionUse;
    this.allAttacks = allAttacks;
    this.currentIndex = 0;
    this.resolvedIndices = new Set();
    this.skippedIndices = new Set();
    this.sequenceStarted = false;
    this.sequenceResolvedAny = false;
    this._completed = false;
    this._resolved = false;      // Promise settled?
    this._busy = false;          // an async action is in flight
    this._autoCloseTimer = null; // auto-close timer once the sequence completes
    this._resolve = null;        // Promise resolve callback
  }

  static DEFAULT_OPTIONS = {
    id: "pf1-sequential-attack-tracker",
    classes: ["pf1-sequential-attacks", "sequential-attack-tracker-app"],
    tag: "div",
    window: {
      title: "Sequential Attack",
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
    },
  };

  static PARTS = {
    body: { template: "modules/pf1-sequential-attacks/src/templates/attack-tracker.hbs" },
  };

  /** @override — dynamic title with the item name. */
  get title() {
    return `Sequential Attack: ${this.actionUse.item.name}`;
  }

  /**
   * Opens the tracker window and runs the sequential loop.
   * @returns {Promise<string>} "completed" or "cancelled"
   */
  async run() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this.render(true);
    });
  }

  /** @override */
  async _prepareContext(options) {
    const attacks = this.allAttacks;
    const rollData = this.actionUse.shared.rollData;

    const rows = attacks.map((atk, i) => {
      const isResolved = this.resolvedIndices.has(i);
      const isSkipped = this.skippedIndices.has(i);
      const isCurrent = i === this.currentIndex && !this._completed;

      let status = "pending";
      let icon = "fa-circle-notch";
      if (isSkipped) {
        status = "skipped";
        icon = "fa-forward";
      } else if (isResolved) {
        status = "resolved";
        icon = "fa-check-circle";
      } else if (isCurrent) {
        status = "current";
        icon = "fa-crosshairs";
      }

      const bonusTotal =
        pf1.dice.RollPF.safeRollSync(atk.attackBonus, rollData, undefined, undefined, { minimize: true }).total ?? 0;
      const bonus = bonusTotal >= 0 ? `+${bonusTotal}` : `${bonusTotal}`;

      return { label: atk.label, status, icon, bonus };
    });

    const remainingCount = attacks.length - this.currentIndex;
    const isLast = this.currentIndex === attacks.length - 1;

    return {
      itemName: this.actionUse.item.name,
      actionName: this.actionUse.action.name,
      progress: `${this._completed ? attacks.length : this.currentIndex + 1} / ${attacks.length}`,
      rows,
      completed: this._completed,
      // "Roll All Remaining" only makes sense with 2+ attacks left — with one left,
      // "Roll Final Attack" already produces the same single-attack card.
      showRollAll: !this._completed && remainingCount >= 2,
      remainingCount,
      nextLabel: isLast ? "Roll Final Attack" : "Roll Next Attack",
      nextIcon: isLast ? "fa-flag-checkered" : "fa-dice-d20",
    };
  }

  /** @override — schedule an auto-close once the whole sequence has resolved. */
  _onRender(context, options) {
    super._onRender(context, options);
    if (this._completed && !this._autoCloseTimer && !this._resolved) {
      // Small delay so the user can see the final state.
      this._autoCloseTimer = setTimeout(() => this._finish("completed"), 800);
    }
  }

  /** @override — closing before completion is treated as a cancel. */
  async close(options) {
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
      ui.notifications.error(`${errMsg} Check console.`);
      if (this.rendered) this.render();
    } finally {
      this._busy = false;
    }
  }

  // ---- Actions ---- //

  static #onRollNext(event, target) {
    return this.#runAction(target, this._resolveCurrentAttack, "Error resolving attack.");
  }

  static #onRollAll(event, target) {
    return this.#runAction(target, this._resolveAllRemaining, "Error resolving remaining attacks.");
  }

  static #onSkip(event, target) {
    this._skipCurrentAttack();
  }

  static #onEditOptions(event, target) {
    return this.#runAction(target, this._editOptions, "Error editing attack options.");
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
   * @param {number} startIdx - Index of the first attack about to be rolled. Used to decide
   *   whether the one-shot charge bonus still applies (only the very first attack benefits).
   */
  async _prepareSequenceRollData(startIdx) {
    const actionUse = this.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;

    // Refresh rollData to pick up any updated actor stats (buffs toggled between attacks, etc.)
    // Note: We do NOT call actor.prepareData() here — the vanilla flow never does, and doing so
    // causes duplicate resource warnings and can corrupt derived data (e.g. actor size).
    // Foundry automatically re-prepares actors when their data changes (buff toggles, etc.),
    // so getRollData() already picks up the latest state.
    actionUse.getRollData();
    const rollData = shared.rollData;

    // If charge was selected in the dialog, only the first attack should benefit.
    // Clear the selection and remove the charge bonus for all subsequent attacks.
    if (startIdx > 0 && shared.formData?.charge) {
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
   * Run the "use"-category script calls once for the sequence. Initializes the
   * first-attack-only bonus arrays so scripts can push to them.
   *
   * @returns {Promise<boolean>} false if a script rejected the action (sequence should abort).
   */
  async _runUseScripts() {
    const shared = this.actionUse.shared;
    shared.firstAttackBonus ??= [];
    shared.firstAttackDamageBonus ??= [];
    await this.actionUse.executeScriptCalls();
    if (shared.scriptData?.reject) return false;
    this.sequenceStarted = true;
    return true;
  }

  /**
   * Build a single ChatAttack (attack roll, damage, ammo, effect notes) for one attack.
   * Used both for one-at-a-time resolution and for assembling the all-remaining card.
   *
   * @param {object} atk - The attack entry from shared.attacks.
   * @param {number} idx - The attack's index in the full sequence (drives conditionals / attackCount).
   * @param {boolean} applyFirstAttackBonuses - Whether first-attack-only bonuses apply to this attack.
   * @returns {Promise<ChatAttack>}
   */
  async _buildChatAttack(atk, idx, applyFirstAttackBonuses) {
    const actionUse = this.actionUse;
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

    if (atk.type !== "manyshot") {
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
   * Resolve the current attack: re-prepare the actor, roll the single attack, and post its chat card.
   */
  async _resolveCurrentAttack() {
    const idx = this.currentIndex;
    const actionUse = this.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;
    const item = actionUse.item;
    const atk = this.allAttacks[idx];

    // Refresh rollData + re-apply dialog options for this attack's actor state.
    await this._prepareSequenceRollData(idx);
    const rollData = shared.rollData;

    // Preserve the routine-level shared state until the one-time use lifecycle has run.
    const origAttacks = shared.attacks;
    const origChatAttacks = shared.chatAttacks;

    const isFirstResolvedAttack = !this.sequenceStarted;
    shared.sequentialAttack = {
      index: idx,
      total: this.allAttacks.length,
      isFirst: isFirstResolvedAttack,
      isLast: idx === this.allAttacks.length - 1,
    };

    // Script calls ("use" category) run once, on the first resolved attack.
    // Running here — before addAttack — ensures that any bonus pushes from scripts
    // (e.g. shared.attackBonus.push(...)) are included in the first attack's roll.
    if (isFirstResolvedAttack) {
      if (!(await this._runUseScripts())) {
        shared.attacks = origAttacks;
        shared.chatAttacks = origChatAttacks;
        this._finish("cancelled");
        return;
      }
    }

    // Build the ChatAttack for this single attack.
    const chatAttack = await this._buildChatAttack(atk, idx, isFirstResolvedAttack);
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

    // Subtract ammo for this single attack
    const ammoCost = action.ammo.cost;
    if (ammoCost !== 0 && atk.hasAmmo) {
      await _subtractSingleAttackAmmo(actionUse, atk, ammoCost);
    }

    // Subtract charges for this attack
    if (atk.chargeCost && atk.chargeCost > 0) {
      shared.totalChargeCost = atk.chargeCost;
      await item.addCharges(-atk.chargeCost);
    }

    // Self-charged action uses (only on first resolved attack)
    if (isFirstResolvedAttack && action.isSelfCharged) {
      await action.update({ "uses.self.value": action.uses.self.value - 1 });
    }

    // Update remaining ammo display
    actionUse.updateAmmoUsage();

    // Handle Dice So Nice
    await actionUse.handleDiceSoNice();

    // Build and optionally post the chat card for this single attack
    await actionUse.getMessageData();
    if (shared.scriptData?.hideChat !== true) {
      await actionUse.postMessage();
    }
    this.sequenceResolvedAny = true;

    // Restore shared arrays
    shared.attacks = origAttacks;
    shared.chatAttacks = origChatAttacks;

    // Mark as resolved
    this.resolvedIndices.add(idx);
    this.currentIndex = idx + 1;

    // Check if we're done
    if (this.currentIndex >= this.allAttacks.length) {
      this._completed = true;
    }

    // Update the dialog
    this.render();
  }

  /**
   * Resolve all remaining (not-yet-rolled) attacks at once, posting them together in a single
   * chat card — i.e. the vanilla PF1 full-attack behaviour for whatever is left in the sequence.
   *
   * Unlike one-at-a-time resolution, the actor state is snapshotted once for the whole batch,
   * so buffs/debuffs toggled between these attacks are NOT picked up individually.
   */
  async _resolveAllRemaining() {
    const actionUse = this.actionUse;
    const shared = actionUse.shared;
    const action = actionUse.action;
    const item = actionUse.item;

    const startIdx = this.currentIndex;
    const remaining = this.allAttacks.slice(startIdx);
    if (remaining.length === 0) return;

    // Snapshot actor state once for the whole batch (single-card / vanilla behaviour).
    await this._prepareSequenceRollData(startIdx);
    const rollData = shared.rollData;

    // Preserve the routine-level shared state until the one-time use lifecycle has run.
    const origAttacks = shared.attacks;
    const origChatAttacks = shared.chatAttacks;

    // This batch covers the first resolved attack only if nothing has been rolled yet.
    const isFirstResolvedBatch = !this.sequenceStarted;
    shared.sequentialAttack = {
      index: startIdx,
      total: this.allAttacks.length,
      isFirst: isFirstResolvedBatch,
      isLast: true,
      batch: true,
      count: remaining.length,
    };

    // Script calls ("use" category) run once for the batch, only if no attack has resolved yet.
    if (isFirstResolvedBatch) {
      if (!(await this._runUseScripts())) {
        shared.attacks = origAttacks;
        shared.chatAttacks = origChatAttacks;
        this._finish("cancelled");
        return;
      }
    }

    // Build a ChatAttack for every remaining attack into one card. First-attack-only bonuses
    // apply only to the very first attack of the entire sequence (i.e. start of an untouched batch).
    const chatAttacks = [];
    for (let i = 0; i < remaining.length; i++) {
      const atk = remaining[i];
      const idx = startIdx + i;
      const applyFirstAttackBonuses = isFirstResolvedBatch && i === 0;
      chatAttacks.push(await this._buildChatAttack(atk, idx, applyFirstAttackBonuses));
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
    if (batchChargeCost > 0) shared.totalChargeCost = batchChargeCost;

    // Self-charged action uses (only if this batch includes the first resolved attack)
    if (isFirstResolvedBatch && action.isSelfCharged) {
      await action.update({ "uses.self.value": action.uses.self.value - 1 });
    }

    // Update remaining ammo display
    actionUse.updateAmmoUsage();

    // Handle Dice So Nice (shows all attacks' dice together)
    await actionUse.handleDiceSoNice();

    // Build and optionally post the single chat card for the whole batch
    await actionUse.getMessageData();
    if (shared.scriptData?.hideChat !== true) {
      await actionUse.postMessage();
    }
    this.sequenceResolvedAny = true;

    // Restore shared arrays
    shared.attacks = origAttacks;
    shared.chatAttacks = origChatAttacks;

    // Mark every remaining attack as resolved and finish the sequence.
    for (let idx = startIdx; idx < this.allAttacks.length; idx++) {
      this.resolvedIndices.add(idx);
    }
    this.currentIndex = this.allAttacks.length;
    this._completed = true;

    this.render();
  }

  /**
   * Reopen the attack dialog so the user can change options (power attack,
   * flanking, PBS, d20 override, conditionals, etc.) for remaining attacks.
   */
  async _editOptions() {
    const actionUse = this.actionUse;
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
    actionUse.getRollData();

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
   * Skip the current attack without rolling it.
   */
  _skipCurrentAttack() {
    const idx = this.currentIndex;
    this.skippedIndices.add(idx);
    this.currentIndex = idx + 1;

    if (this.currentIndex >= this.allAttacks.length) {
      this._completed = true;
    }

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
    return `Edit Attack Options: ${this.actionUse.item.name}`;
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    // Hide the committed attacks table
    html.find(".attacks").hide();

    // Replace Single Attack / Full Attack with a single "OK" button
    html.find(`button[name="attack_single"]`).remove();
    html.find(`button[name="attack_full"]`)
      .html(`<i class="fas fa-check"></i> OK`);
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
