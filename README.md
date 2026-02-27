# PF1e Sequential Attacks 

A Foundry VTT module that allows full attacks to be resolved one attack at a time instead of all at once.

**Version:** 1.0.0  
**Foundry VTT Compatibility:** v13  
**Manifest URL:** `https://github.com/Hamilcarbarcas/pf1-sequential-attacks/releases/latest/download/module.json`

## Features

- **Sequential Attack Resolution**: Roll each attack in a full attack sequence individually
- **Visual Tracker**: Dialog displays all attacks in the sequence with status indicators:
  - Current attack
  - Completed attacks
  - Skipped attacks
  - Pending attacks
- **Per-Attack Control**: 
  - Roll attacks one at a time using the "Roll Next Attack" button
  - Skip individual attacks without rolling them
  - Retarget between attacks
  - Toggle buffs/debuffs between attacks
- **Attack Bonus Preview**: See the calculated attack bonus for each attack before rolling
- **Progress Tracking**: Dialog shows current attack count
- **Individual Chat Cards**: Each attack posts its own chat message when resolved

## Usage

### Enabling Sequential Attacks
1. Open the module settings
2. Find "Sequential Full Attacks" setting
3. Toggle it on to enable

### During an Attack
When you have multiple attacks in a full attack sequence and sequential mode is enabled:
1. The attack dialog appears as normal
2. After confirming the dialog, a sequential tracker shows all your attacks
3. Click **"Roll Next Attack"** to roll the current attack and post it to chat
4. **"Skip"** an attack if you don't want to roll it
5. **"Cancel"** to abort the entire sequence

The tracker will auto-close when all attacks are resolved.

## Compatibility

- **Minimum Foundry Version**: 13
- **Verified Version**: 13
- **Required Dependencies**:
  - **libWrapper** (https://github.com/ruipin/fvtt-lib-wrapper)
  - **Pathfinder 1e** system