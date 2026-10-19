/* Attack Routines
 *
 * Named, ordered lists of links to attack items on an actor, shown as a category at the
 * top of the PF1 combat tab. Using a routine starts every linked attack as one sequence
 * through the module's startSequence() API. Entries are shortcuts, never items: nothing
 * here creates, changes or deletes an item. See DESIGN.md §10a.
 */

const MODULE_ID = "pf1-sequential-attacks";
const FLAG = "routines";
const TEMPLATE = "modules/pf1-sequential-attacks/src/templates/attack-routines.hbs";
const SHEET_TEMPLATE = "modules/pf1-sequential-attacks/src/templates/routine-sheet.hbs";
const DRAG_ROUTINE = "pf1-sequential-attacks.routine";
const DRAG_ENTRY = "pf1-sequential-attacks.entry";
const COLLAPSE_KEY = "pf1-sequential-attacks.collapsedRoutines";
const FALLBACK_IMG = "icons/svg/sword.svg";

// ---- Storage ---- //

/**
 * @param {Actor} actor
 * @returns {object[]} A copy of the actor's routines, safe to mutate.
 */
function getRoutines(actor) {
  return foundry.utils.deepClone(actor?.getFlag(MODULE_ID, FLAG) ?? []);
}

/**
 * Read, change and write the actor's routines. Arrays in a document update replace the
 * stored array wholesale, so the whole list is written each time.
 *
 * @param {Actor} actor
 * @param {(routines: object[]) => (boolean|void)} change - Return false to skip the write.
 */
async function updateRoutines(actor, change) {
  const routines = getRoutines(actor);
  if (change(routines) === false) return;
  await actor.setFlag(MODULE_ID, FLAG, routines);
}

/** Change one routine in place; a missing routine skips the write. */
function updateRoutine(actor, routineId, change) {
  return updateRoutines(actor, (routines) => {
    const routine = routines.find((r) => r.id === routineId);
    if (!routine) return false;
    return change(routine);
  });
}

function _findEntry(routines, routineId, entryId) {
  const routine = routines.find((r) => r.id === routineId);
  const index = routine?.entries.findIndex((e) => e.id === entryId) ?? -1;
  return { routine, index, entry: index >= 0 ? routine.entries[index] : null };
}

// ---- Collapse state (per user and client, never on the actor) ---- //

function _collapsedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function _setCollapsed(key, collapsed) {
  try {
    const set = _collapsedSet();
    if (collapsed) set.add(key);
    else set.delete(key);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    // Storage unavailable: collapse still works until the sheet re-renders.
  }
}

// ---- Using a routine ---- //

/**
 * Use a routine: start every entry as one sequence (DESIGN.md §10a "Using a routine").
 * Quick roll uses each entry's default action and preset with no prompts; otherwise every
 * prompt fires as normal, the action picker included, with presets filling the dialogs.
 *
 * @param {string} routineId
 * @param {object} [options]
 * @param {Actor|TokenDocument|Token|null} [options.subject] - Who uses it. Without one, the
 *   controlled tokens are searched, then the actor named by `actorId`.
 * @param {string|null} [options.actorId] - Fallback actor, as stored in hotbar macros.
 * @param {boolean|null} [options.shift] - Shift held; read from the keyboard when omitted.
 * @returns {Promise<object|null>} startSequence()'s result, or null when nothing ran.
 */
async function useRoutine(routineId, { subject = null, actorId = null, shift = null } = {}) {
  const found = _findRoutine(routineId, subject, actorId);
  if (!found) {
    ui.notifications.warn(game.i18n.localize("SEQ.Warn.RoutineNotFound"));
    return null;
  }
  const { routine, who } = found;
  if (!routine.entries.length) {
    ui.notifications.warn(game.i18n.format("SEQ.Warn.RoutineEmpty", { name: routine.name }));
    return null;
  }

  // Shift flips the routine's own quick-roll choice, as it flips PF1's skip-prompt setting.
  const shiftHeld = shift ?? game.keyboard?.isModifierActive?.("Shift") ?? false;
  const skipDialog = !!routine.quickRoll !== shiftHeld;
  const entries = routine.entries.map((entry) => ({
    item: entry.itemId,
    action: skipDialog ? entry.actionId || undefined : undefined,
    presets: entry.presets ?? {},
  }));

  return game.modules.get(MODULE_ID).api.startSequence(who, entries, { skipDialog });
}

/**
 * @returns {{routine: object, who: Actor|TokenDocument}|null}
 */
function _findRoutine(routineId, subject, actorId) {
  const candidates = [];
  if (subject) candidates.push(subject?.document ?? subject);
  else {
    for (const token of canvas?.tokens?.controlled ?? []) candidates.push(token.document);
    const actor = actorId ? game.actors.get(actorId) : null;
    if (actor) candidates.push(actor);
  }
  for (const who of candidates) {
    const actor = who?.documentName === "Token" ? who.actor : who;
    const routine = getRoutines(actor).find((r) => r.id === routineId);
    if (routine) return { routine, who };
  }
  return null;
}

// ---- Presets ---- //

/**
 * Edit an entry's preset: a real item.use() in capture mode shows the real attack dialog
 * (after PF1's action picker for an item with several actions), and the module's wrapper
 * hands back the choices without anything resolving (DESIGN.md §10a "Presets").
 *
 * @param {Actor} actor
 * @param {string} routineId
 * @param {string} entryId
 * @param {TokenDocument|null} token
 */
async function editPreset(actor, routineId, entryId, token) {
  const { entry } = _findEntry(getRoutines(actor), routineId, entryId);
  const item = entry ? actor.items.get(entry.itemId) : null;
  if (!item) return;

  const result = await new Promise((resolve) => {
    let captured = false;
    const capture = (value) => {
      captured = true;
      resolve(value);
    };
    item
      .use({ skipDialog: false, token: token ?? undefined, options: { sequentialAttacks: { capture, presets: entry.presets ?? {} } } })
      .then(() => {
        // Unreported means another module's wrapper resolved the use before this one ran.
        if (!captured) {
          ui.notifications.warn(game.i18n.format("SEQ.Warn.PresetOutside", { name: item.name }));
          resolve(null);
        }
      })
      .catch((err) => {
        console.error(`${MODULE_ID} | Preset capture for "${item.name}" threw.`, err);
        if (!captured) resolve(null);
      });
  });
  if (!result) return;

  await updateRoutines(actor, (routines) => {
    const { entry: target } = _findEntry(routines, routineId, entryId);
    if (!target) return false;
    target.actionId = result.actionId;
    target.presets = { ...(target.presets ?? {}), [result.actionId]: result.form };
  });
}

// ---- Combat tab ---- //

/**
 * Whether an item can be a routine entry: the same rule startSequence() applies, checked
 * at drop time so a routine never holds an entry that would always be dropped.
 */
function _canBeEntry(item) {
  if (!item?.hasAction) return false;
  if (item.type === "consumable") return false;
  if (item.type === "feat" && item.subType === "classFeat") return false;
  return true;
}

/**
 * Row data for one entry, matching PF1's combat rows. Charges, ammo and type come from
 * the sheet's own item preparation; Attacks / Damage / Range from the entry's action, which
 * may not be the item's default.
 */
function _entryView(sheet, actor, entry) {
  const item = actor.items.get(entry.itemId);
  if (!item) {
    return { id: entry.id, missing: true, name: game.i18n.localize("SEQ.Routine.Missing"), img: FALLBACK_IMG };
  }

  const data = sheet._prepareItem?.(item) ?? {};
  const action = (entry.actionId && item.actions?.get(entry.actionId)) || item.defaultAction;

  let attackSummary = "";
  if (action?.hasAttack) {
    try {
      const rollData = action.getRollData();
      const bonuses = action
        .getAttacks({ full: true, resolve: true, conditionals: true, bonuses: true, rollData })
        .map((atk) => atk.bonus);
      const highest = Math.max(...bonuses);
      attackSummary = `${bonuses.length} (${highest < 0 ? highest : `+${highest}`}${bonuses.length > 1 ? "/…" : ""})`;
    } catch (err) {
      console.warn(`${MODULE_ID} | Attack summary for "${item.name}" failed.`, err);
    }
  }

  return {
    id: entry.id,
    name: item.name,
    img: item.img,
    actionName: item.actions?.size > 1 ? action?.name : null,
    // For astora-mod's Usage column, from the entry's own action rather than the default.
    activation: action ? item.getLabels?.({ actionId: action.id })?.activation ?? "" : "",
    action,
    hasAttack: !!action?.hasAttack,
    attackSummary,
    hasDamage: !!action?.hasDamage,
    hasRange: !!action?.hasRange,
    isCharged: data.isCharged,
    charges: data.charges,
    maxCharges: data.maxCharges,
    noMaxCharges: data.noMaxCharges,
    usesAmmo: data.usesAmmo && action?.ammo?.cost > 0,
    ammoRemaining: data.ammoRemaining,
    hasPreset: !!(action && entry.presets?.[action.id]),
  };
}

/** The routine's own image, else its first linked item's, else a sword. */
function _routineImg(actor, routine) {
  if (routine.img) return routine.img;
  for (const entry of routine.entries) {
    const img = actor.items.get(entry.itemId)?.img;
    if (img) return img;
  }
  return FALLBACK_IMG;
}

Hooks.on("renderActorSheetPF", async (sheet, html) => {
  const actor = sheet.actor;
  if (!actor) return;
  const root = html instanceof HTMLElement ? html : html[0];

  _injectSheetQuickActions(sheet, root);

  const groups = root?.querySelector('.tab[data-tab="combat"] .item-groups-list');
  if (!groups) return;

  // V1 fires render hooks synchronously, most specific class first, so the parent-class
  // hooks (astora-mod's renderActorSheet, which adds the Usage column) run after this one.
  // Yield once so they finish before the column check below.
  await null;
  // astora-mod adds the Usage column after Charges; match it only when it is there.
  const showUsage = !!groups.querySelector(".item-list-header > .item-usage");

  const collapsed = _collapsedSet();
  const routines = getRoutines(actor).map((routine) => {
    const key = `${actor.uuid}:${routine.id}`;
    return {
      ...routine,
      img: _routineImg(actor, routine),
      collapsed: collapsed.has(key),
      entries: routine.entries.map((entry) => _entryView(sheet, actor, entry)),
    };
  });

  const markup = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    routines,
    owner: actor.isOwner,
    showUsage,
  });
  // The sheet may have re-rendered while the template loaded.
  if (!groups.isConnected) return;

  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  const section = template.content.firstElementChild;
  groups.prepend(section);
  _activateSection(sheet, section);
});

/**
 * @param {ActorSheet} sheet
 * @param {HTMLElement} section - The injected `ol.seq-routines`.
 */
function _activateSection(sheet, section) {
  const actor = sheet.actor;
  const owner = actor.isOwner;
  const token = sheet.token ?? null;
  const routineIdOf = (el) => el.closest("[data-routine-id]")?.dataset.routineId;
  const entryIdOf = (el) => el.closest("[data-entry-id]")?.dataset.entryId;
  const on = (selector, event, handler) => {
    for (const el of section.querySelectorAll(selector)) el.addEventListener(event, handler);
  };

  // Collapse toggles the rows in place; no sheet re-render.
  on(".seq-routine-toggle", "click", (event) => {
    const row = event.currentTarget.closest(".seq-routine");
    const routineId = row.dataset.routineId;
    const nowCollapsed = !row.classList.contains("seq-collapsed");
    row.classList.toggle("seq-collapsed", nowCollapsed);
    for (const el of section.querySelectorAll(`.seq-routine-child[data-routine-id="${routineId}"]`)) {
      el.hidden = nowCollapsed;
    }
    _setCollapsed(`${actor.uuid}:${routineId}`, nowCollapsed);
  });

  on(".seq-routine-use", "click", (event) => {
    event.preventDefault();
    useRoutine(routineIdOf(event.currentTarget), { subject: token ?? actor, shift: event.shiftKey });
  });

  // Dragging a routine row to the hotbar makes a macro (hotbarDrop below).
  on(".seq-routine", "dragstart", (event) => {
    if (event.target !== event.currentTarget) return;
    const data = { type: DRAG_ROUTINE, actorId: actor.id, routineId: event.currentTarget.dataset.routineId };
    event.dataTransfer.setData("text/plain", JSON.stringify(data));
  });

  if (!owner) return;

  on(".seq-routine-create", "click", () => {
    updateRoutines(actor, (routines) => {
      routines.push({
        id: foundry.utils.randomID(),
        name: game.i18n.localize("SEQ.Routine.DefaultName"),
        img: null,
        description: "",
        quickbar: false,
        quickRoll: false,
        entries: [],
      });
    });
  });

  on(".seq-routine-edit", "click", (event) => {
    RoutineSheet.open(actor, routineIdOf(event.currentTarget));
  });

  on(".seq-routine-delete", "click", async (event) => {
    const routineId = routineIdOf(event.currentTarget);
    const current = getRoutines(actor).find((r) => r.id === routineId);
    if (!current) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SEQ.Routine.Delete") },
      content: `<p>${game.i18n.format("SEQ.Routine.DeleteConfirm", { name: foundry.utils.escapeHTML(current.name) })}</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;
    updateRoutines(actor, (routines) => {
      const index = routines.findIndex((r) => r.id === routineId);
      if (index < 0) return false;
      routines.splice(index, 1);
    });
  });

  on(".seq-entry-preset", "click", (event) => {
    event.preventDefault();
    editPreset(actor, routineIdOf(event.currentTarget), entryIdOf(event.currentTarget), token);
  });

  on(".seq-entry-open", "click", (event) => {
    const { entry } = _findEntry(getRoutines(actor), routineIdOf(event.currentTarget), entryIdOf(event.currentTarget));
    actor.items.get(entry?.itemId)?.sheet.render(true, { focus: true });
  });

  on(".seq-entry-remove", "click", (event) => {
    const routineId = routineIdOf(event.currentTarget);
    const entryId = entryIdOf(event.currentTarget);
    updateRoutines(actor, (routines) => {
      const { routine, index } = _findEntry(routines, routineId, entryId);
      if (index < 0) return false;
      routine.entries.splice(index, 1);
    });
  });

  on(".seq-routine-entry", "dragstart", (event) => {
    const data = {
      type: DRAG_ENTRY,
      actorUuid: actor.uuid,
      routineId: routineIdOf(event.currentTarget),
      entryId: entryIdOf(event.currentTarget),
    };
    event.dataTransfer.setData("text/plain", JSON.stringify(data));
  });

  // Drops onto a routine row append; onto an entry, insert before it. Propagation stops so
  // PF1's sheet-level drop handler (item sort / create) never sees these.
  on(".seq-drop-target", "dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  on(".seq-drop-target", "drop", (event) => {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== "Item" && data?.type !== DRAG_ENTRY) return;
    event.preventDefault();
    event.stopPropagation();
    _onDropOnRoutine(actor, data, routineIdOf(event.currentTarget), entryIdOf(event.currentTarget));
  });
}

/**
 * @param {Actor} actor
 * @param {object} data - Drag data: a PF1 item, or a routine entry being moved.
 * @param {string} routineId - Routine dropped on.
 * @param {string|undefined} beforeEntryId - Entry dropped on, if any; the new position is before it.
 */
async function _onDropOnRoutine(actor, data, routineId, beforeEntryId) {
  let moving = null;
  if (data.type === DRAG_ENTRY) {
    if (data.actorUuid !== actor.uuid || data.entryId === beforeEntryId) return;
  } else {
    // Only items already on this actor; anything else is not a routine's business.
    const item = data.uuid ? fromUuidSync(data.uuid) : null;
    if (!item || item.parent?.uuid !== actor.uuid) return;
    if (!_canBeEntry(item)) {
      ui.notifications.warn(game.i18n.format("SEQ.Warn.RoutineItemType", { name: item.name }));
      return;
    }
    moving = { id: foundry.utils.randomID(), itemId: item.id, actionId: null, presets: {} };
  }

  await updateRoutines(actor, (routines) => {
    const target = routines.find((r) => r.id === routineId);
    if (!target) return false;
    if (data.type === DRAG_ENTRY) {
      const { routine, index } = _findEntry(routines, data.routineId, data.entryId);
      if (index < 0) return false;
      [moving] = routine.entries.splice(index, 1);
    }
    const before = beforeEntryId ? target.entries.findIndex((e) => e.id === beforeEntryId) : -1;
    if (before < 0) target.entries.push(moving);
    else target.entries.splice(before, 0, moving);
  });
}

// ---- Routine sheet ---- //

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Edit window for one routine, laid out like PF1's item sheet so it reads as familiar:
 * image and name in the header, Quickbar and Quick roll in the sidebar, a Description tab.
 *
 * PF1 scopes its item-sheet layout as `.pf1.sheet.item form > header` / `form > .sidebar`
 * under `.pf1.sheet .window-content`, so the root stays a div carrying those classes and
 * the template supplies its own `<form>`. Each field saves on its own change; nothing
 * re-renders except after the description, so an open editor is never wiped by another field.
 */
class RoutineSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {Actor} actor
   * @param {string} routineId
   */
  constructor(actor, routineId) {
    super({ id: RoutineSheet.idFor(actor, routineId) });
    this.actor = actor;
    this.routineId = routineId;
  }

  static DEFAULT_OPTIONS = {
    // theme-light: v13 forces it on every V1 window, PF1's sheets included, but an AppV2
    // window otherwise inherits the interface's dark scheme and its inputs and editor
    // toolbar stop matching the item sheet beside it.
    classes: ["pf1", "sheet", "item", "seq-routine-sheet", "themed", "theme-light"],
    tag: "div",
    window: { icon: "fa-solid fa-list-ol", resizable: true },
    position: { width: 740, height: 620 },
    actions: { editImage: RoutineSheet.#onEditImage },
  };

  static PARTS = {
    body: { template: SHEET_TEMPLATE },
  };

  static idFor(actor, routineId) {
    return `pf1-seq-routine-${actor.uuid.replaceAll(".", "-")}-${routineId}`;
  }

  /** Open the routine's sheet, or bring an open one forward. */
  static open(actor, routineId) {
    const existing = foundry.applications.instances.get(RoutineSheet.idFor(actor, routineId));
    if (existing) return existing.render({ force: true });
    return new RoutineSheet(actor, routineId).render({ force: true });
  }

  get routine() {
    return getRoutines(this.actor).find((r) => r.id === this.routineId);
  }

  /** @override — PF1's own "Item – Actor" title format. */
  get title() {
    return `${this.routine?.name ?? ""} – ${this.actor.name}`;
  }

  /** @override */
  async _prepareContext(options) {
    const routine = this.routine ?? {};
    const description = routine.description ?? "";
    return {
      name: routine.name ?? "",
      img: _routineImg(this.actor, routine.entries ? routine : { entries: [] }),
      quickbar: !!routine.quickbar,
      quickRoll: !!routine.quickRoll,
      count: routine.entries?.length ?? 0,
      description,
      enrichedDescription: await foundry.applications.ux.TextEditor.implementation.enrichHTML(description, {
        secrets: this.actor.isOwner,
        relativeTo: this.actor,
        rollData: this.actor.getRollData?.(),
      }),
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector("form");
    form.addEventListener("submit", (event) => event.preventDefault());

    form.querySelector('input[name="name"]').addEventListener("change", async (event) => {
      const name = event.currentTarget.value.trim();
      if (!name) return;
      await updateRoutine(this.actor, this.routineId, (routine) => {
        routine.name = name;
      });
      if (this.window?.title) this.window.title.textContent = this.title;
    });

    for (const input of form.querySelectorAll('.sidebar input[type="checkbox"]')) {
      input.addEventListener("change", () => {
        updateRoutine(this.actor, this.routineId, (routine) => {
          routine[input.name] = input.checked;
        });
      });
    }

    form.querySelector('prose-mirror[name="description"]')?.addEventListener("change", async (event) => {
      const value = event.currentTarget.value ?? "";
      await updateRoutine(this.actor, this.routineId, (routine) => {
        routine.description = value;
      });
      this.render();
    });
  }

  static #onEditImage(event, target) {
    const current = this.routine?.img ?? "";
    new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: async (path) => {
        await updateRoutine(this.actor, this.routineId, (routine) => {
          routine.img = path;
        });
        target.src = path;
      },
    }).render({ force: true });
  }
}

// A routine deleted while its sheet is open takes the sheet with it.
Hooks.on("updateActor", (actor, change) => {
  if (!foundry.utils.hasProperty(change, `flags.${MODULE_ID}.${FLAG}`)) return;
  const ids = new Set(getRoutines(actor).map((r) => r.id));
  const prefix = `pf1-seq-routine-${actor.uuid.replaceAll(".", "-")}-`;
  for (const app of foundry.applications.instances.values()) {
    if (app instanceof RoutineSheet && app.id.startsWith(prefix) && !ids.has(app.routineId)) app.close();
  }
});

// ---- Quickbars ---- //

/** Routines flagged for the quickbar, in sheet order. */
function _quickRoutines(actor) {
  return getRoutines(actor).filter((r) => r.quickbar && r.entries.length);
}

/**
 * Click uses the routine (Shift flips quick roll); right-click opens the actor sheet on the
 * combat tab, in place of PF1's open-item-sheet.
 */
function _bindQuickAction(el, actor, routineId, subject) {
  el.addEventListener("click", (event) => {
    event.preventDefault();
    useRoutine(routineId, { subject, shift: event.shiftKey });
  });
  el.addEventListener("contextmenu", async (event) => {
    event.preventDefault();
    await actor.sheet.render(true, { focus: true });
    actor.sheet.activateTab?.("combat");
  });
}

/** The sheet's Quick Actions strip, after PF1's own items. */
function _injectSheetQuickActions(sheet, root) {
  const list = root?.querySelector("ol.quick-actions");
  if (!list) return;
  const actor = sheet.actor;
  for (const routine of _quickRoutines(actor)) {
    const li = document.createElement("li");
    li.className = "item seq-routine-quick";
    li.dataset.routineId = routine.id;
    li.dataset.tooltip = routine.name;
    const img = document.createElement("img");
    img.src = _routineImg(actor, routine);
    li.append(img);
    _bindQuickAction(li, actor, routine.id, sheet.token ?? actor);
    list.append(li);
  }
}

// Token HUD. PF1 adds its own quick-actions column in _onRender, before this hook, and
// skips it entirely when the actor has no item quick actions; build it in that case.
Hooks.on("renderTokenHUD", (hud, html) => {
  const tokenDoc = hud.object?.document;
  const actor = tokenDoc?.actor;
  if (!actor) return;
  const routines = _quickRoutines(actor);
  if (!routines.length) return;

  const root = html instanceof HTMLElement ? html : html[0];
  let column = root.querySelector(".col.actions .below");
  if (!column) {
    const middle = root.querySelector(".col.middle");
    if (!middle) return;
    const wrapper = document.createElement("div");
    wrapper.className = "col actions";
    column = document.createElement("div");
    column.className = "below";
    wrapper.append(column);
    middle.after(wrapper);
  }

  for (const routine of routines) {
    const el = document.createElement("div");
    el.className = "control-icon token-quick-action seq-routine-quick";
    el.dataset.routineId = routine.id;
    el.dataset.tooltip = routine.name;
    const img = document.createElement("img");
    img.src = _routineImg(actor, routine);
    img.width = 36;
    img.height = 36;
    img.inert = true;
    el.append(img);
    _bindQuickAction(el, actor, routine.id, tokenDoc);
    column.append(el);
  }
});

// ---- Hotbar ---- //

// A routine dragged from the sheet becomes a script macro. Like PF1's item macros it
// resolves a controlled token at run time, so one macro serves every token of an NPC.
Hooks.on("hotbarDrop", (bar, data, slot) => {
  if (data?.type !== DRAG_ROUTINE) return;
  _createRoutineMacro(data, slot);
  return false;
});

async function _createRoutineMacro({ actorId, routineId }, slot) {
  const actor = game.actors.get(actorId);
  const routine = getRoutines(actor).find((r) => r.id === routineId);
  if (!routine) return;

  const command = `game.modules.get("${MODULE_ID}")?.api?.useRoutine("${routineId}", { actorId: "${actorId}" });`;
  let macro = game.macros.find((m) => m.command === command && m.isOwner);
  macro ??= await Macro.implementation.create({
    name: routine.name,
    type: "script",
    img: _routineImg(actor, routine),
    command,
  });
  if (macro) await game.user.assignHotbarMacro(macro, slot);
}

// ---- API ---- //

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = { ...(module.api ?? {}), useRoutine, getRoutines };
  // Cached up front so the section lands in the same frame as the sheet and the
  // scroll position PF1 restores after a render doesn't jump.
  foundry.applications.handlebars.loadTemplates([TEMPLATE, SHEET_TEMPLATE]);
});
