/**
 * PF1 Sequential Attacks
 * Splits multi-attack actions into individually triggerable attack buttons.
 */

const MODULE_ID = "pf1-sequential-attacks";

// Tracks a pending single-attack request so the pf1PreActionUse hook can allow it through.
let _pendingSingleAttack = null;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing PF1 Sequential Attacks`);

  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable Sequential Attacks",
    hint: "When enabled, actions with multiple attacks present each attack as an individual button in chat instead of rolling all at once.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
});

/**
 * Returns the attackParts array from a PF1 ItemAction, supporting both
 * v11+ (system property) and older (data property) data layouts.
 *
 * @param {object} action  A PF1 ItemAction instance
 * @returns {Array}        Array of [bonus, label] pairs for extra attacks
 */
function getAttackParts(action) {
  return action?.system?.attackParts ?? action?.data?.attackParts ?? [];
}

/**
 * Returns true when the action has more than one attack (i.e. has attack parts).
 *
 * @param {object} action  A PF1 ItemAction instance
 * @returns {boolean}
 */
function hasMultipleAttacks(action) {
  return getAttackParts(action).length > 0;
}

/**
 * Builds a flat list of attack descriptors for the sequential card.
 * Index 0 is always the base attack; subsequent indices map to attackParts.
 *
 * @param {object} action  A PF1 ItemAction instance
 * @returns {Array<{index: number, label: string, bonus: string}>}
 */
function buildAttackList(action) {
  const parts = getAttackParts(action);
  const attacks = [{ index: 0, label: "Attack", bonus: "" }];
  parts.forEach(([bonus, label], i) => {
    attacks.push({
      index: i + 1,
      label: label || `Attack ${i + 2}`,
      bonus: bonus || "",
    });
  });
  return attacks;
}

/**
 * Creates a sequential attack chat card listing all individual attacks as buttons.
 *
 * @param {object} action  A PF1 ItemAction instance
 * @param {object} actor   The actor using the action
 */
async function createSequentialAttackCard(action, actor) {
  const attacks = buildAttackList(action);
  const templateData = {
    attacks,
    actionName: action.name || actor.name,
    actorId: actor.id,
    itemId: action.item?.id,
    actionId: action.id,
    moduleId: MODULE_ID,
  };

  const content = await renderTemplate(
    `modules/${MODULE_ID}/templates/sequential-attack-card.hbs`,
    templateData
  );

  return ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: {
      [MODULE_ID]: {
        sequential: true,
        actorId: actor.id,
        itemId: action.item?.id,
        actionId: action.id,
      },
    },
  });
}

/**
 * Intercepts PF1 action use for multi-attack actions and shows the sequential card instead.
 * Single sequential attacks (triggered from the card buttons) are allowed through.
 */
Hooks.on("pf1PreActionUse", (actionUse) => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;

  const action = actionUse.action;

  // Allow the call through when this is a sequential single-attack request.
  if (_pendingSingleAttack?.actionId === action?.id) return;

  if (!hasMultipleAttacks(action)) return;

  // Show the sequential card and suppress the default all-at-once roll.
  createSequentialAttackCard(action, actionUse.actor);
  return false;
});

/**
 * Wires up the attack buttons when a sequential attack chat card is rendered.
 */
Hooks.on("renderChatMessage", (message, html) => {
  if (!message.getFlag(MODULE_ID, "sequential")) return;

  html.find("[data-seq-action='roll']").on("click", async (event) => {
    event.preventDefault();

    const btn = event.currentTarget;
    const attackIndex = parseInt(btn.dataset.index ?? "0");

    const actorId = message.getFlag(MODULE_ID, "actorId");
    const itemId = message.getFlag(MODULE_ID, "itemId");
    const actionId = message.getFlag(MODULE_ID, "actionId");

    const actor = game.actors.get(actorId);
    const item = actor?.items.get(itemId);
    const action = item?.actions?.get(actionId);

    if (!action) {
      ui.notifications.warn(`${MODULE_ID} | Could not find the action to roll.`);
      return;
    }

    // Mark the button as used immediately to prevent double-clicks.
    btn.disabled = true;
    btn.classList.add("pf1-seq--used");

    const origParts = foundry.utils.deepClone(getAttackParts(action));

    // Narrow attackParts to just the one attack that should fire:
    //   index 0 → base attack only (no extra parts)
    //   index N → the Nth extra attack part only
    if (attackIndex > origParts.length) {
      console.warn(`${MODULE_ID} | Attack index ${attackIndex} out of range (${origParts.length} parts).`);
      btn.disabled = false;
      btn.classList.remove("pf1-seq--used");
      return;
    }
    const singlePart = attackIndex === 0 ? [] : [origParts[attackIndex - 1]];

    // Signal that the next pf1PreActionUse call for this action is intentional.
    _pendingSingleAttack = { actionId };

    try {
      // Temporarily narrow the in-memory attackParts so PF1 only rolls this one attack.
      if (action.system) {
        action.system.attackParts = singlePart;
      } else if (action.data) {
        action.data.attackParts = singlePart;
      }

      await action.use({ skipDialog: true });
    } catch (err) {
      console.error(`${MODULE_ID} | Error rolling sequential attack:`, err);
      btn.disabled = false;
      btn.classList.remove("pf1-seq--used");
    } finally {
      // Always restore the original attackParts and clear the pending flag.
      if (action.system) {
        action.system.attackParts = origParts;
      } else if (action.data) {
        action.data.attackParts = origParts;
      }
      _pendingSingleAttack = null;
    }
  });
});
