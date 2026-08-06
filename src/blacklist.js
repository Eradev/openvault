/**
 * OpenVault Character Blacklist
 *
 * Per-character-card denylist for collective/abstract names (e.g. Parents, Narrator).
 * Stored on the SillyTavern card via writeExtensionField.
 */

import { getContext } from '../../../../extensions.js';
import {
    getOpenVaultData,
    saveOpenVaultData,
    showToast,
    log,
} from './utils.js';
import {
    extensionName,
    MEMORIES_KEY,
    CHARACTERS_KEY,
    RELATIONSHIPS_KEY,
    PLACES_KEY,
} from './constants.js';

/**
 * Normalize a name for case-insensitive comparison
 * @param {string} name
 * @returns {string}
 */
export function normalizeBlacklistName(name) {
    return String(name || '').trim().toLowerCase();
}

/**
 * Whether two names match (case-insensitive, trimmed)
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function namesMatchInsensitive(a, b) {
    const na = normalizeBlacklistName(a);
    const nb = normalizeBlacklistName(b);
    return Boolean(na) && na === nb;
}

/**
 * Resolve which character card index owns the blacklist.
 * Solo: context.characterId. Group: responding character (name2) when found.
 * @param {object} [context]
 * @returns {number|null}
 */
export function resolveBlacklistCharacterId(context = null) {
    const ctx = context || getContext();
    if (!ctx) return null;

    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const id = Number(ctx.characterId);
        if (!Number.isNaN(id) && ctx.characters?.[id]) {
            return id;
        }
    }

    // Group chats: prefer the responding character's card
    if (ctx.name2 && Array.isArray(ctx.characters)) {
        const idx = ctx.characters.findIndex(c => c?.name === ctx.name2);
        if (idx >= 0) return idx;
    }

    return null;
}

/**
 * Whether the UI can edit the blacklist (a writable card is available)
 * @returns {boolean}
 */
export function canEditBlacklist() {
    const ctx = getContext();
    if (!ctx?.writeExtensionField) return false;
    return resolveBlacklistCharacterId(ctx) !== null;
}

/**
 * Read blacklisted names from the active character card
 * @param {object} [context]
 * @returns {string[]}
 */
export function getBlacklistedNames(context = null) {
    const ctx = context || getContext();
    const characterId = resolveBlacklistCharacterId(ctx);
    if (characterId === null) return [];

    const raw = ctx.characters?.[characterId]?.data?.extensions?.[extensionName]?.blacklistedNames;
    if (!Array.isArray(raw)) return [];

    return raw
        .map(n => String(n || '').trim())
        .filter(Boolean);
}

/**
 * Whether a name is on the active card's blacklist
 * @param {string} name
 * @param {string[]} [blacklistedNames] - Optional preloaded list
 * @returns {boolean}
 */
export function isBlacklistedName(name, blacklistedNames = null) {
    const list = blacklistedNames ?? getBlacklistedNames();
    const needle = normalizeBlacklistName(name);
    if (!needle) return false;
    return list.some(n => normalizeBlacklistName(n) === needle);
}

/**
 * Build a Set of normalized blacklisted names for fast lookup
 * @param {string[]} [blacklistedNames]
 * @returns {Set<string>}
 */
export function getBlacklistSet(blacklistedNames = null) {
    const list = blacklistedNames ?? getBlacklistedNames();
    return new Set(list.map(normalizeBlacklistName).filter(Boolean));
}

/**
 * Persist blacklisted names onto the character card
 * @param {string[]} names
 * @returns {Promise<boolean>}
 */
async function writeBlacklistedNames(names) {
    const ctx = getContext();
    const characterId = resolveBlacklistCharacterId(ctx);
    if (characterId === null || typeof ctx.writeExtensionField !== 'function') {
        showToast('warning', 'No character card available to save blacklist');
        return false;
    }

    const cleaned = [];
    const seen = new Set();
    for (const name of names) {
        const trimmed = String(name || '').trim();
        if (!trimmed) continue;
        const key = normalizeBlacklistName(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(trimmed);
    }

    try {
        await ctx.writeExtensionField(characterId, extensionName, {
            blacklistedNames: cleaned,
        });
        log(`Blacklist saved on card (${cleaned.length} names)`);
        return true;
    } catch (error) {
        console.error('[OpenVault] Failed to write blacklist:', error);
        showToast('error', `Failed to save blacklist: ${error.message}`);
        return false;
    }
}

/**
 * Remove a blacklisted name from name arrays (case-insensitive)
 * @param {string[]} list
 * @param {string} name
 * @returns {string[]}
 */
function filterNameList(list, name) {
    if (!Array.isArray(list)) return [];
    return list.filter(n => !namesMatchInsensitive(n, name));
}

/**
 * Drop object keys whose name matches (case-insensitive)
 * @param {Object} obj
 * @param {string} name
 * @returns {Object}
 */
function filterObjectKeysByName(obj, name) {
    if (!obj || typeof obj !== 'object') return {};
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (!namesMatchInsensitive(key, name)) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Drop relationship_impact keys where either side matches the name
 * @param {Object} impact
 * @param {string} name
 * @returns {Object}
 */
function filterRelationshipImpact(impact, name) {
    if (!impact || typeof impact !== 'object') return {};
    const result = {};
    for (const [key, value] of Object.entries(impact)) {
        const match = String(key).match(/^(.+?)\s*->\s*(.+)$/);
        if (match) {
            const [, charA, charB] = match;
            if (namesMatchInsensitive(charA, name) || namesMatchInsensitive(charB, name)) {
                continue;
            }
        } else if (namesMatchInsensitive(key, name)) {
            continue;
        }
        result[key] = value;
    }
    return result;
}

/**
 * Scrub a blacklisted name from current chat OpenVault metadata
 * @param {string} name
 * @returns {Promise<boolean>} True if chat data was modified and saved
 */
export async function scrubBlacklistedNameFromChat(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;

    const data = getOpenVaultData();
    if (!data) return false;

    let changed = false;

    // Character states
    const states = data[CHARACTERS_KEY] || {};
    for (const key of Object.keys(states)) {
        if (namesMatchInsensitive(key, trimmed) || namesMatchInsensitive(states[key]?.name, trimmed)) {
            delete states[key];
            changed = true;
            continue;
        }
        // Strip blacklisted name from other characters' aliases
        const char = states[key];
        if (Array.isArray(char?.aliases)) {
            const before = char.aliases.length;
            char.aliases = char.aliases.filter(a => !namesMatchInsensitive(a, trimmed));
            if (char.aliases.length !== before) changed = true;
        }
    }

    // Relationships
    const relationships = data[RELATIONSHIPS_KEY] || {};
    for (const key of Object.keys(relationships)) {
        const rel = relationships[key];
        if (
            namesMatchInsensitive(rel?.character_a, trimmed) ||
            namesMatchInsensitive(rel?.character_b, trimmed)
        ) {
            delete relationships[key];
            changed = true;
        }
    }

    // Memories — strip involvement, keep the memory
    for (const memory of (data[MEMORIES_KEY] || [])) {
        const beforeInvolved = JSON.stringify(memory.characters_involved || []);
        const beforeWitnesses = JSON.stringify(memory.witnesses || []);
        memory.characters_involved = filterNameList(memory.characters_involved, trimmed);
        memory.witnesses = filterNameList(memory.witnesses, trimmed);

        const beforeEmotion = JSON.stringify(memory.emotional_impact || {});
        memory.emotional_impact = filterObjectKeysByName(memory.emotional_impact, trimmed);

        const beforeRel = JSON.stringify(memory.relationship_impact || {});
        memory.relationship_impact = filterRelationshipImpact(memory.relationship_impact, trimmed);

        if (
            JSON.stringify(memory.characters_involved) !== beforeInvolved ||
            JSON.stringify(memory.witnesses) !== beforeWitnesses ||
            JSON.stringify(memory.emotional_impact) !== beforeEmotion ||
            JSON.stringify(memory.relationship_impact) !== beforeRel
        ) {
            changed = true;
        }
    }

    // Places — occupants and known_by
    for (const place of Object.values(data[PLACES_KEY] || {})) {
        if (!place) continue;

        if (place.occupants && typeof place.occupants === 'object') {
            for (const occKey of Object.keys(place.occupants)) {
                if (namesMatchInsensitive(occKey, trimmed)) {
                    delete place.occupants[occKey];
                    changed = true;
                }
            }
        }

        if (Array.isArray(place.known_by)) {
            const before = place.known_by.length;
            place.known_by = filterNameList(place.known_by, trimmed);
            if (place.known_by.length !== before) {
                changed = true;
            }
        }
    }

    if (changed) {
        await saveOpenVaultData();
        log(`Scrubbed blacklisted name "${trimmed}" from chat data`);
    }

    return changed;
}

/**
 * Add a name to the card blacklist and scrub current chat data
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function addBlacklistedName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        showToast('warning', 'Enter a name to blacklist');
        return false;
    }

    if (!canEditBlacklist()) {
        showToast('warning', 'No character card available to save blacklist');
        return false;
    }

    const current = getBlacklistedNames();
    if (isBlacklistedName(trimmed, current)) {
        showToast('info', `"${trimmed}" is already blacklisted`);
        return false;
    }

    const ok = await writeBlacklistedNames([...current, trimmed]);
    if (!ok) return false;

    await scrubBlacklistedNameFromChat(trimmed);
    showToast('success', `Blacklisted "${trimmed}"`);
    return true;
}

/**
 * Remove a name from the card blacklist (does not restore scrubbed data)
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function removeBlacklistedName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;

    if (!canEditBlacklist()) {
        showToast('warning', 'No character card available to save blacklist');
        return false;
    }

    const current = getBlacklistedNames();
    const next = current.filter(n => !namesMatchInsensitive(n, trimmed));
    if (next.length === current.length) {
        showToast('info', `"${trimmed}" is not on the blacklist`);
        return false;
    }

    const ok = await writeBlacklistedNames(next);
    if (!ok) return false;

    showToast('success', `Removed "${trimmed}" from blacklist`);
    return true;
}
