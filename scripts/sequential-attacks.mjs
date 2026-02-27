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
    "WRAPPER"
  );

  console.log("pf1-sequential-attacks | Sequential Attacks wrapper registered (WRAPPER priority).");
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

  // Spells, consumables, and class features are rarely used in sequential full attacks
  // and may be handled by other wrappers (e.g. Nevela's Automation Suite) that bypass
  // createAttackDialog(). To avoid double-dialog issues, chain directly for these types.
  const itemType = actionUse.item?.type;
  const itemSubType = actionUse.item?.subType;
  if (itemType === "spell" || itemType === "consumable" || (itemType === "feat" && itemSubType === "classFeat")) {
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

  // Show the dialog
  const form = await actionUse.createAttackDialog();
  if (!form) {
    console.debug("PF1 | Sequential attack cancelled in attack prompt.");
    return;
  }

  const shared = actionUse.shared;

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

  if (trackerResult === "cancelled") {
    // Clean up any placed templates
    await measureTemplate?.delete();
    console.debug("PF1 | Sequential attack cancelled by user.");
    return;
  }

  // Deselect targets after all attacks
  if (game.settings.get("pf1", "clearTargetsAfterAttack") && game.user.targets.size) {
    if (game.release.generation >= 13) {
      game.user._onUpdateTokenTargets([]);
    } else {
      game.user.updateTokenTargets([]);
    }
    game.user.broadcastActivity({ targets: [] });
  }

  console.debug('PF1 | Sequential full attack "%s (%s)" completed.', item.name, action.name);
  return actionUse;
}

// ---- Sequential Attack Tracker (Dialog) ---- //

class SequentialAttackTracker {
  constructor(actionUse, allAttacks) {
    this.actionUse = actionUse;
    this.allAttacks = allAttacks;
    this.currentIndex = 0;
    this.resolvedIndices = new Set();
    this.skippedIndices = new Set();
    this.dialog = null;
    this._resolve = null; // Promise resolve callback
  }

  /**
   * Opens the tracker dialog and runs the sequential loop.
   * @returns {Promise<string>} "completed" or "cancelled"
   */
  async run() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._renderDialog();
    });
  }

  _renderDialog() {
    const content = this._buildHTML();

    if (this.dialog) {
      // Update existing dialog content
      const inner = this.dialog.element?.find?.(".sequential-attack-tracker");
      if (inner?.length) {
        inner.replaceWith(this._buildTrackerBody());
        this._activateListeners(this.dialog.element);
        return;
      }
    }

    this.dialog = new Dialog(
      {
        title: `Sequential Attack: ${this.actionUse.item.name}`,
        content,
        buttons: {},
        close: () => {
          // If closed before completing all attacks, treat as cancel
          if (!this._completed) {
            this._resolve("cancelled");
          }
        },
      },
      {
        classes: ["sequential-attack-dialog"],
        width: 340,
        height: "auto",
        resizable: false,
      }
    );

    this.dialog.render(true);

    // Wait for the dialog to actually render before attaching listeners
    Hooks.once("renderDialog", (app) => {
      if (app === this.dialog) {
        this._activateListeners(app.element);
      }
    });
  }

  _buildHTML() {
    return this._buildTrackerBody();
  }

  _buildTrackerBody() {
    const attacks = this.allAttacks;
    let html = `<div class="sequential-attack-tracker">`;
    html += `<div class="seq-attack-header">`;
    html += `<span class="seq-attack-title">${this.actionUse.item.name} — ${this.actionUse.action.name}</span>`;
    const nextAttack = this._completed ? attacks.length : this.currentIndex + 1;
    html += `<span class="seq-attack-progress">${nextAttack} / ${attacks.length}</span>`;
    html += `</div>`;

    html += `<div class="seq-attack-list">`;
    for (let i = 0; i < attacks.length; i++) {
      const atk = attacks[i];
      const isResolved = this.resolvedIndices.has(i);
      const isSkipped = this.skippedIndices.has(i);
      const isCurrent = i === this.currentIndex && !this._completed;

      let statusClass = "seq-pending";
      let icon = `<i class="fas fa-circle-notch"></i>`;
      if (isSkipped) {
        statusClass = "seq-skipped";
        icon = `<i class="fas fa-forward"></i>`;
      } else if (isResolved) {
        statusClass = "seq-resolved";
        icon = `<i class="fas fa-check-circle"></i>`;
      } else if (isCurrent) {
        statusClass = "seq-current";
        icon = `<i class="fas fa-crosshairs"></i>`;
      }

      const bonusTotal = pf1.dice.RollPF.safeRollSync(atk.attackBonus, this.actionUse.shared.rollData, undefined, undefined, { minimize: true }).total ?? 0;
      const bonusStr = bonusTotal >= 0 ? `+${bonusTotal}` : `${bonusTotal}`;
      html += `<div class="seq-attack-row ${statusClass}">`;
      html += `  <span class="seq-attack-icon">${icon}</span>`;
      html += `  <span class="seq-attack-label">${atk.label}</span>`;
      html += `  <span class="seq-attack-bonus">${bonusStr}</span>`;
      html += `</div>`;
    }
    html += `</div>`;

    // Buttons
    html += `<div class="seq-attack-buttons">`;
    if (!this._completed) {
      const isLast = this.currentIndex === attacks.length - 1;
      const btnLabel = isLast ? "Roll Final Attack" : "Roll Next Attack";
      const btnIcon = isLast ? "fas fa-flag-checkered" : "fas fa-dice-d20";
      html += `<button type="button" class="seq-next-btn"><i class="${btnIcon}"></i> ${btnLabel}</button>`;
      html += `<button type="button" class="seq-skip-btn"><i class="fas fa-forward"></i> Skip</button>`;
      html += `<button type="button" class="seq-cancel-btn"><i class="fas fa-times"></i> Cancel</button>`;
    } else {
      html += `<button type="button" class="seq-close-btn"><i class="fas fa-check"></i> Done</button>`;
    }
    html += `</div>`;

    html += `</div>`;
    return html;
  }

  _activateListeners(html) {
    html.find(".seq-next-btn").off("click").on("click", async (ev) => {
      ev.preventDefault();
      const btn = $(ev.currentTarget);
      btn.prop("disabled", true).addClass("seq-btn-working");

      try {
        await this._resolveCurrentAttack();
      } catch (err) {
        console.error("pf1-sequential-attacks | Error resolving sequential attack:", err);
        ui.notifications.error("Error resolving attack. Check console.");
      } finally {
        btn.prop("disabled", false).removeClass("seq-btn-working");
      }
    });

    html.find(".seq-skip-btn").off("click").on("click", (ev) => {
      ev.preventDefault();
      this._skipCurrentAttack();
    });

    html.find(".seq-cancel-btn").off("click").on("click", (ev) => {
      ev.preventDefault();
      this._completed = true;
      this._resolve("cancelled");
      this.dialog.close();
    });

    html.find(".seq-close-btn").off("click").on("click", (ev) => {
      ev.preventDefault();
      this._completed = true;
      this.dialog.close();
      this._resolve("completed");
    });
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

    // Refresh rollData to pick up any updated actor stats (buffs toggled between attacks, etc.)
    // Note: We do NOT call actor.prepareData() here — the vanilla flow never does, and doing so
    // causes duplicate resource warnings and can corrupt derived data (e.g. actor size).
    // Foundry automatically re-prepares actors when their data changes (buff toggles, etc.),
    // so getRollData({ cache: false }) already picks up the latest state.
    actionUse.getRollData();
    const rollData = shared.rollData;

    // If charge was selected in the dialog, only the first attack should benefit.
    // Clear the selection and remove the charge bonus for all subsequent attacks.
    if (idx > 0 && shared.formData?.charge) {
      shared.formData.charge = false;
      shared.charge = false;
      const chargeLabel = game.i18n.localize("PF1.Charge");
      const chargeTag = `[${chargeLabel}]`;
      shared.attackBonus = shared.attackBonus.filter((part) => !part?.includes?.(chargeTag));
    }

    // Re-apply the form-based alterations (power attack, conditionals, etc.)
    // We need to re-run alterRollData with the saved form data since getRollData() resets rollData
    // but we need to preserve the state. We selectively re-apply key values.
    rollData.fullAttack = shared.fullAttack ? 1 : 0;
    if (shared.powerAttack) {
      const basePowerAttackBonus = rollData.action?.powerAttack?.damageBonus ?? 2;
      let powerAttackBonus = (1 + Math.floor(rollData.attributes.bab.total / 4)) * basePowerAttackBonus;
      const paMult = action.getPowerAttackMult({ rollData });
      powerAttackBonus = Math.floor(powerAttackBonus * paMult);
      const powerAttackPenalty = -(1 + Math.floor(rollData.bab / 4));
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

    // ---- Roll this single attack ---- //

    // Temporarily isolate shared data to a single attack
    const origAttacks = shared.attacks;
    const origChatAttacks = shared.chatAttacks;
    shared.attacks = [atk];
    shared.chatAttacks = [];

    const conditionalParts = actionUse._getConditionalParts(atk, { index: idx });
    rollData.attackCount = idx;

    // Create ChatAttack
    const chatAttack = new pf1.actionUse.ChatAttack(action, {
      label: atk.label,
      rollData,
      targets: game.user.targets,
      actionUse,
    });

    if (atk.type !== "manyshot") {
      await chatAttack.addAttack({
        extraParts: [...shared.attackBonus, atk.attackBonus],
        conditionalParts,
      });
    }

    // Add damage
    if (action.hasDamage) {
      const extraParts = foundry.utils.deepClone(shared.damageBonus);
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

    shared.chatAttacks = [chatAttack];
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

    // Save DC
    shared.save = action.save.type;
    shared.saveDC = action.getDC(rollData);

    // Effect notes for this attack
    if (atk.type !== "manyshot") {
      await chatAttack.addEffectNotes({ rollData });
    }

    // Reset footnotes and template data for this attack's card
    shared.templateData.footnotes = [];
    await actionUse.addFootnotes();

    // Fire the pre-action-use hook (per attack)
    // Modules can return false to skip this attack's chat card
    const hookResult = Hooks.call("pf1PreActionUse", actionUse);

    if (hookResult !== false) {
      // Script calls
      await actionUse.executeScriptCalls();

      if (!shared.scriptData?.reject) {
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

        // Self-charged action uses (only on first attack)
        if (idx === 0 && action.isSelfCharged) {
          await action.update({ "uses.self.value": action.uses.self.value - 1 });
        }

        // Update remaining ammo display
        actionUse.updateAmmoUsage();

        // Handle Dice So Nice
        await actionUse.handleDiceSoNice();

        // Build and post the chat card for this single attack
        await actionUse.getMessageData();
        await actionUse.postMessage();

        // Post-use script calls
        await actionUse.executeScriptCalls("postUse");

        Hooks.callAll("pf1PostActionUse", actionUse, shared.message ?? null);
      }
    }

    // Restore shared arrays
    shared.attacks = origAttacks;
    shared.chatAttacks = origChatAttacks;

    // Cleanup per-attack rollData
    delete rollData.attackCount;

    // Mark as resolved
    this.resolvedIndices.add(idx);
    this.currentIndex = idx + 1;

    // Check if we're done
    if (this.currentIndex >= this.allAttacks.length) {
      this._completed = true;
    }

    // Update the dialog
    this._updateDialog();
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

    this._updateDialog();
  }

  _updateDialog() {
    if (!this.dialog?.element?.length) return;

    const container = this.dialog.element.find(".sequential-attack-tracker");
    if (container.length) {
      container.replaceWith(this._buildTrackerBody());
      this._activateListeners(this.dialog.element);

      // Auto-close if completed
      if (this._completed) {
        // Small delay so user can see the final state
        setTimeout(() => {
          if (this.dialog?.element?.length) {
            this._resolve("completed");
            this.dialog.close();
          }
        }, 800);
      }
    }
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
