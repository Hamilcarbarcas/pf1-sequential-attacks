/* Replace Attack (DESIGN.md §14)
 *
 * What can stand in for one attack of a sequence, and the roll-bonuses bonus that adds to it.
 *
 * Two sources of candidates:
 *  - pf1-combat-maneuvers: any maneuver whose activation is "attack" (trip, disarm, sunder
 *    by default), offered on melee weapon attacks only.
 *  - The "Replaces Attack" roll-bonuses bonus: the source item names one of its own actions,
 *    or a combat maneuver, and that replacement is offered on the attacks the bonus targets.
 *
 * Both are optional. Without either module this file offers nothing and the tracker hides
 * its Replace Attack button.
 */

const MODULE_ID = "pf1-sequential-attacks";
const RB_MODULE_ID = "ckl-roll-bonuses";
const MANEUVER_PREFIX = "maneuver:";

/** The registered bonus class and roll-bonuses' API, once its ready hook has handed them over. */
let BonusClass = null;
let rbApi = null;

/** The combat maneuvers API, or null when that module is off. */
const maneuverApi = () => game.pf1CombatManeuvers ?? null;

/**
 * Whether any replacement source exists at all, which decides whether the tracker shows the
 * button (disabled when the current attack has no candidates).
 *
 * @param {Actor} actor
 * @returns {boolean}
 */
export function replaceAvailable(actor) {
  if (maneuverApi()) return true;
  return !!(BonusClass && actor?.itemFlags?.boolean?.[BonusClass.key]?.sources?.length);
}

/**
 * An attack entry's own bonus formula, or "" when it adds nothing. PF1's addAttack drops "0"
 * but not "(0)", which extra attacks with no configured bonus carry.
 *
 * @param {string|number|undefined} bonus
 * @returns {string}
 */
export function cleanBonus(bonus) {
  if (bonus === undefined || bonus === null || bonus === "") return "";
  const text = String(bonus);
  const bare = pf1.utils.formula.unflair(text).replace(/[\s()]/g, "");
  return bare === "" || bare === "0" ? "" : text;
}

/** Join two attack bonus formulas, either of which may be empty. */
export function joinBonus(a, b) {
  const parts = [cleanBonus(a), cleanBonus(b)].filter(Boolean);
  return parts.join(" + ");
}

/** A maneuver activation, picked for the action economy in use. */
function economyActivation(activation) {
  if (!activation) return null;
  return game.settings.get("pf1", "unchainedActionEconomy") ? activation.unchained ?? activation : activation;
}

/**
 * Previewed attack modifier for a replacement: the action's own first attack plus the replaced
 * entry's bonus, minimized like the combat tab. Blank for an action with no attack roll.
 *
 * @param {ItemAction|undefined} action
 * @param {string} replacedBonus
 * @returns {string}
 */
function previewBonus(action, replacedBonus) {
  if (!action?.hasAttack) return "";
  try {
    const rollData = action.getRollData();
    const [first] = action.getAttacks({ full: false, rollData, resolve: true, bonuses: true, conditionals: true });
    let total = Number(first?.bonus) || 0;
    if (replacedBonus) {
      total += pf1.dice.RollPF.safeRollSync(replacedBonus, rollData, undefined, undefined, { minimize: true }).total ?? 0;
    }
    return total >= 0 ? `+${total}` : `${total}`;
  } catch (err) {
    console.error(`${MODULE_ID} | replace attack: previewing "${action?.name}" failed:`, err);
    return "";
  }
}

/**
 * A combat maneuver candidate. The item is the materialized one when the actor has it, else
 * a throwaway built when the candidate is used, or for the picker's preview.
 */
function maneuverCandidate(api, actor, id, replacedBonus, preview, via = null) {
  const entry = api.registry.get(id);
  if (!entry) return null;
  const real = api.findManeuverItem(actor, id);
  const item = () => api.findManeuverItem(actor, id) ?? api.synthesize(actor, id);
  return {
    key: `${MANEUVER_PREFIX}${id}`,
    label: real?.name ?? entry.label,
    img: real?.img ?? entry.img,
    hint: via ?? "",
    bonus: preview ? previewBonus(item()?.actions?.contents?.[0], replacedBonus) : "",
    use: (options) => item()?.use(options),
  };
}

/**
 * Every replacement for one attack of a block, maneuvers first, then bonus sources in sheet
 * order. Keys are unique; a maneuver offered both by default and by a bonus appears once.
 *
 * @param {ActionUse} actionUse - The block's use.
 * @param {object} atk - The attack being replaced.
 * @param {object} [options]
 * @param {boolean} [options.preview=false] - Fill in each candidate's attack modifier. Off for
 *   the button's enabled check, which would otherwise build a throwaway item per maneuver on
 *   every render.
 * @returns {Array<{key: string, label: string, img: string, hint: string, bonus: string, use: Function}>}
 */
export function replacementCandidates(actionUse, atk, { preview = false } = {}) {
  const actor = actionUse?.actor;
  if (!actor || !atk) return [];
  const replacedBonus = cleanBonus(atk.attackBonus);
  const out = [];
  const seen = new Set();
  const push = (candidate) => {
    if (!candidate || seen.has(candidate.key)) return;
    seen.add(candidate.key);
    out.push(candidate);
  };

  // Maneuvers that RAW allows "in place of a melee attack": the activation says so.
  const api = maneuverApi();
  const noManeuvers = !!actor.system?.config?.noManeuvers;
  if (api && !noManeuvers && actionUse.action?.actionType === "mwak" && atk.type !== "manyshot") {
    for (const entry of api.registry.all()) {
      const real = api.findManeuverItem(actor, entry.id);
      const activation = real ? real.actions?.contents?.[0]?.activation : economyActivation(entry.activation);
      if (activation?.type !== "attack") continue;
      push(maneuverCandidate(api, actor, entry.id, replacedBonus, preview));
    }
    // Hand-made maneuvers (no registry entry) qualify the same way.
    for (const item of api.getManeuvers(actor)) {
      if (api.getManeuverId(item)) continue;
      const action = item.actions?.contents?.[0];
      if (action?.activation?.type !== "attack") continue;
      push({
        key: `item:${item.id}:${action.id}`,
        label: item.name,
        img: item.img,
        hint: "",
        bonus: preview ? previewBonus(action, replacedBonus) : "",
        use: (options) => item.use({ ...options, actionId: action.id }),
      });
    }
  }

  // Replaces Attack bonuses that target this block.
  if (BonusClass && rbApi?.utils?.handleBonusesFor) {
    try {
      rbApi.utils.handleBonusesFor(
        actionUse,
        (_bonusType, source) => push(bonusCandidate(source, actor, replacedBonus, api, noManeuvers, preview)),
        { specificBonusType: BonusClass }
      );
    } catch (err) {
      console.error(`${MODULE_ID} | replace attack: resolving bonus sources failed:`, err);
    }
  }

  return out;
}

/** The candidate one Replaces Attack source offers, or null when it names nothing usable. */
function bonusCandidate(source, actor, replacedBonus, api, noManeuvers, preview) {
  const value = `${source.getFlag(RB_MODULE_ID, `${BonusClass.key}-action`) ?? ""}`.trim();
  if (value.startsWith(MANEUVER_PREFIX)) {
    if (!api || noManeuvers) return null;
    return maneuverCandidate(api, actor, value.slice(MANEUVER_PREFIX.length), replacedBonus, preview, source.name);
  }
  const action = (value && source.actions?.get(value)) || source.actions?.contents?.[0];
  if (!action) return null;
  const label = source.actions.size > 1 ? `${source.name}: ${action.name}` : source.name;
  return {
    key: `item:${source.id}:${action.id}`,
    label,
    img: source.img,
    hint: "",
    bonus: preview ? previewBonus(action, replacedBonus) : "",
    use: (options) => source.use({ ...options, actionId: action.id }),
  };
}

/* -------------------------------------------- */
/*  Roll-bonuses registration                   */
/* -------------------------------------------- */

/** Select choices: the item's own actions, then every registered combat maneuver. */
function actionChoices(item) {
  const choices = (item.actions?.contents ?? []).map((a) => ({ key: a.id, label: a.name }));
  const api = maneuverApi();
  if (api) {
    for (const entry of api.registry.all()) {
      choices.push({
        key: `${MANEUVER_PREFIX}${entry.id}`,
        label: game.i18n.format("SEQ.Bonus.ManeuverChoice", { name: entry.label }),
      });
    }
  }
  return choices;
}

/** Display name for a stored choice, for the sheet hint. */
function choiceLabel(item, value) {
  if (value.startsWith(MANEUVER_PREFIX)) {
    const entry = maneuverApi()?.registry.get(value.slice(MANEUVER_PREFIX.length));
    return entry ? entry.label : "";
  }
  const action = (value && item.actions?.get(value)) || item.actions?.contents?.[0];
  return action?.name ?? "";
}

/**
 * Build and register the bonus class against roll-bonuses' live API.
 *
 * @param {object} api - The roll-bonuses API handed to the ready hook.
 */
function registerBonus(api) {
  const BaseBonus = api?.sources?.BaseBonus;
  const inputs = api?.inputs;
  if (!BaseBonus || !api.utils?.registerSource || !api.utils?.handleBonusesFor || !inputs?.keyValueSelect) {
    console.error(`${MODULE_ID} | roll-bonuses API not usable; the Replaces Attack bonus is unavailable.`);
    return;
  }

  class ReplaceAttackBonus extends BaseBonus {
    /** @override */
    static get sourceKey() {
      return "seq-replace-attack";
    }

    /** @override */
    static get journal() {
      return "";
    }

    /** @override */
    static get label() {
      return game.i18n.localize("SEQ.Bonus.Label");
    }

    /** @override */
    static get tooltip() {
      return game.i18n.localize("SEQ.Bonus.Tooltip");
    }

    /**
     * @override
     * @param {ItemPF} source
     * @returns {string[]}
     */
    static getHints(source) {
      const value = `${source.getFlag(RB_MODULE_ID, `${this.key}-action`) ?? ""}`.trim();
      const name = choiceLabel(source, value);
      return [name ? game.i18n.format("SEQ.Bonus.Hint", { name }) : game.i18n.localize("SEQ.Bonus.HintNone")];
    }

    /**
     * Presence and payload. roll-bonuses reads presence off the boolean flag.
     *
     * @override
     * @param {ItemPF} item
     * @param {{action?: string}} [config] - An action id on the item, or "maneuver:<id>".
     */
    static async configure(item, { action = "" } = {}) {
      await item.update({
        system: { flags: { boolean: { [this.key]: true } } },
        flags: { [RB_MODULE_ID]: { [`${this.key}-action`]: action } },
      });
    }

    /**
     * @override
     * @param {object} options
     * @param {HTMLElement} options.html
     * @param {boolean} options.isEditable
     * @param {ItemPF} options.item
     */
    static showInputOnItemSheet({ html, isEditable, item }) {
      inputs.keyValueSelect(
        {
          choices: actionChoices(item),
          item,
          journal: this.journal,
          key: `${this.key}-action`,
          label: game.i18n.localize("SEQ.Bonus.Action"),
          parent: html,
          tooltip: this.tooltip,
        },
        { canEdit: isEditable, inputType: "bonus" }
      );
    }
  }

  try {
    api.utils.registerSource(ReplaceAttackBonus);
    ReplaceAttackBonus.init?.();
    BonusClass = ReplaceAttackBonus;
    rbApi = api;
  } catch (err) {
    console.error(`${MODULE_ID} | registering the Replaces Attack bonus failed:`, err);
  }
}

// roll-bonuses fires this once, during init, after exposing its API.
Hooks.once(`${RB_MODULE_ID}.ready`, registerBonus);
