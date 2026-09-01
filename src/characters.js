/**
 * OpenVault Character Helpers
 *
 * Find, merge, and rename character profiles stored in chat metadata.
 * Long-term fields (aliases, description, features) live alongside ephemeral emotion state.
 */

import {
    CHARACTERS_KEY,
    MEMORIES_KEY,
    RELATIONSHIPS_KEY,
    PLACES_KEY,
} from './constants.js';
import {
    isBlacklistedName,
    namesMatchInsensitive,
    normalizeBlacklistName,
} from './blacklist.js';

/**
 * Ensure character_states map exists on OpenVault data.
 * @param {Object} data
 * @returns {Object}
 */
export function ensureCharactersMap(data) {
    if (!data[CHARACTERS_KEY] || typeof data[CHARACTERS_KEY] !== 'object') {
        data[CHARACTERS_KEY] = {};
    }
    return data[CHARACTERS_KEY];
}

/**
 * Whether a character has any lasting profile fields filled.
 * @param {Object} char
 * @returns {boolean}
 */
export function hasCharacterProfile(char) {
    if (!char) return false;
    if ((char.description || '').trim()) return true;
    if (Array.isArray(char.aliases) && char.aliases.length > 0) return true;
    if (Array.isArray(char.features) && char.features.length > 0) return true;
    return false;
}

/**
 * Parse comma- or semicolon-separated nicknames into a deduped list.
 * @param {string} input
 * @param {string} [canonicalName] - Excluded when it matches a nickname
 * @returns {string[]}
 */
export function parseAliasesInput(input, canonicalName = '') {
    const result = [];
    for (const part of String(input || '').split(/[,;]+/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (canonicalName && namesMatchInsensitive(trimmed, canonicalName)) continue;
        pushUniqueInsensitive(result, trimmed);
    }
    return result;
}

/**
 * Ensure nicknames do not collide with other characters or the blacklist.
 * @param {Object} states - character_states map
 * @param {string} characterName - Canonical name of the character being edited
 * @param {string[]} aliases
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateCharacterAliases(states, characterName, aliases) {
    if (!Array.isArray(aliases)) return { ok: true };

    for (const alias of aliases) {
        if (isBlacklistedName(alias)) {
            return { ok: false, error: `"${alias}" is blacklisted` };
        }

        for (const [key, other] of Object.entries(states || {})) {
            if (!other) continue;
            const otherName = other.name || key;
            if (namesMatchInsensitive(otherName, characterName)
                || namesMatchInsensitive(key, characterName)) {
                continue;
            }
            if (namesMatchInsensitive(alias, otherName) || namesMatchInsensitive(alias, key)) {
                return { ok: false, error: `"${alias}" is already used by ${otherName}` };
            }
            for (const otherAlias of (other.aliases || [])) {
                if (namesMatchInsensitive(alias, otherAlias)) {
                    return { ok: false, error: `"${alias}" is already a nickname of ${otherName}` };
                }
            }
        }
    }

    return { ok: true };
}

/**
 * Merge a string into a unique list (case-insensitive for membership).
 * @param {string[]} list
 * @param {string} value
 */
function pushUniqueInsensitive(list, value) {
    if (!value || typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (list.some(v => String(v).toLowerCase() === lower)) return;
    list.push(trimmed);
}

/**
 * Merge description text: prefer newer non-empty; append if additive and distinct.
 * @param {string} existing
 * @param {string} incoming
 * @returns {string}
 */
export function mergeCharacterDescription(existing, incoming) {
    const prev = (existing || '').trim();
    const next = (incoming || '').trim();
    if (!next) return prev;
    if (!prev) return next;
    if (prev.toLowerCase() === next.toLowerCase()) return prev;
    if (prev.toLowerCase().includes(next.toLowerCase())) return prev;
    if (next.toLowerCase().includes(prev.toLowerCase())) return next;
    return `${prev} ${next}`.trim();
}

/**
 * Create an empty character profile with emotion defaults.
 * @param {string} name
 * @returns {Object}
 */
export function createCharacter(name) {
    return {
        name: name.trim(),
        aliases: [],
        description: '',
        features: [],
        current_emotion: 'neutral',
        emotion_intensity: 5,
        known_events: [],
        source_event_ids: [],
        last_updated: Date.now(),
    };
}

/**
 * Find an existing character by name or alias (case-insensitive).
 * @param {Object} states - character_states map
 * @param {string} nameOrAlias
 * @param {string[]} [extraAliases]
 * @returns {Object|null}
 */
export function findCharacter(states, nameOrAlias, extraAliases = []) {
    if (!states || !nameOrAlias) return null;

    const candidates = [nameOrAlias, ...(extraAliases || [])]
        .filter(Boolean)
        .map(s => String(s).trim())
        .filter(Boolean);

    if (candidates.length === 0) return null;

    const candidateLower = new Set(candidates.map(c => c.toLowerCase()));

    // Prefer exact map-key match first
    for (const candidate of candidates) {
        if (states[candidate]) return states[candidate];
        const lower = candidate.toLowerCase();
        for (const [key, char] of Object.entries(states)) {
            if (!char) continue;
            if (key.toLowerCase() === lower) return char;
        }
    }

    for (const char of Object.values(states)) {
        if (!char) continue;
        if (char.name && candidateLower.has(char.name.toLowerCase())) {
            return char;
        }
        for (const alias of (char.aliases || [])) {
            if (alias && candidateLower.has(String(alias).toLowerCase())) {
                return char;
            }
        }
    }

    return null;
}

/**
 * Ensure a character entry exists; returns the profile.
 * @param {Object} data
 * @param {string} name
 * @returns {Object|null}
 */
export function ensureCharacter(data, name) {
    if (!data || !name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;

    const states = ensureCharactersMap(data);
    let char = findCharacter(states, trimmed);
    if (char) {
        // Ensure lasting fields exist on older entries
        char.aliases = Array.isArray(char.aliases) ? char.aliases : [];
        char.features = Array.isArray(char.features) ? char.features : [];
        char.description = char.description || '';
        char.source_event_ids = Array.isArray(char.source_event_ids) ? char.source_event_ids : [];
        char.known_events = Array.isArray(char.known_events) ? char.known_events : [];
        if (!char.name) char.name = trimmed;
        return char;
    }

    char = createCharacter(trimmed);
    states[trimmed] = char;
    return char;
}

/**
 * Merge source profile fields into target (mutates target).
 * @param {Object} target
 * @param {Object} source
 */
function mergeCharacterProfiles(target, source) {
    if (!target || !source) return;

    target.aliases = Array.isArray(target.aliases) ? target.aliases : [];
    target.features = Array.isArray(target.features) ? target.features : [];
    target.known_events = Array.isArray(target.known_events) ? target.known_events : [];
    target.source_event_ids = Array.isArray(target.source_event_ids) ? target.source_event_ids : [];

    for (const alias of (source.aliases || [])) {
        if (alias && !namesMatchInsensitive(alias, target.name)) {
            pushUniqueInsensitive(target.aliases, alias);
        }
    }
    for (const feature of (source.features || [])) {
        pushUniqueInsensitive(target.features, feature);
    }
    target.description = mergeCharacterDescription(target.description, source.description);

    for (const eventId of (source.known_events || [])) {
        if (eventId && !target.known_events.includes(eventId)) {
            target.known_events.push(eventId);
        }
    }
    for (const eventId of (source.source_event_ids || [])) {
        if (eventId && !target.source_event_ids.includes(eventId)) {
            target.source_event_ids.push(eventId);
        }
    }

    const sourceUpdated = source.last_updated || 0;
    const targetUpdated = target.last_updated || 0;
    if (sourceUpdated >= targetUpdated && source.current_emotion) {
        target.current_emotion = source.current_emotion;
        if (source.emotion_from_messages) {
            target.emotion_from_messages = source.emotion_from_messages;
        }
        if (typeof source.emotion_intensity === 'number') {
            target.emotion_intensity = source.emotion_intensity;
        }
    }

    target.last_updated = Math.max(sourceUpdated, targetUpdated, Date.now());
}

/**
 * Upsert lasting character facts from extraction.
 * Does not overwrite emotion from facts.
 * @param {Object} data
 * @param {Object} facts - { name, aliases?, description?, features? }
 * @param {Object} [meta] - { eventId? }
 * @returns {Object|null}
 */
export function upsertCharacterFromFacts(data, facts, meta = {}) {
    if (!data || !facts) return null;

    const name = facts.name;
    if (!name || typeof name !== 'string' || !name.trim()) return null;
    if (isBlacklistedName(name)) return null;

    const aliases = Array.isArray(facts.aliases) ? facts.aliases.filter(Boolean) : [];
    const states = ensureCharactersMap(data);
    let char = findCharacter(states, name, aliases);

    if (!char) {
        char = createCharacter(name);
        states[name.trim()] = char;
    } else if (char.name && !namesMatchInsensitive(name, char.name)) {
        // Keep canonical name; record alternate as alias
        pushUniqueInsensitive(char.aliases, name.trim());
    }

    char.aliases = Array.isArray(char.aliases) ? char.aliases : [];
    char.features = Array.isArray(char.features) ? char.features : [];

    for (const alias of aliases) {
        if (namesMatchInsensitive(alias, char.name)) continue;
        pushUniqueInsensitive(char.aliases, alias);
    }

    if (facts.description) {
        char.description = mergeCharacterDescription(char.description, facts.description);
    }

    if (Array.isArray(facts.features)) {
        for (const feature of facts.features) {
            pushUniqueInsensitive(char.features, feature);
        }
    }

    if (meta.eventId) {
        char.source_event_ids = Array.isArray(char.source_event_ids) ? char.source_event_ids : [];
        if (!char.source_event_ids.includes(meta.eventId)) {
            char.source_event_ids.push(meta.eventId);
        }
    }

    char.last_updated = Date.now();
    return char;
}

/**
 * Replace a name in a string list (case-insensitive match).
 * @param {string[]} list
 * @param {string} oldName
 * @param {string} newName
 * @returns {string[]}
 */
function replaceNameInList(list, oldName, newName) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const result = [];
    for (const item of list) {
        const next = namesMatchInsensitive(item, oldName) ? newName : item;
        const key = normalizeBlacklistName(next);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(next);
    }
    return result;
}

/**
 * Rename keys in an object that match oldName.
 * @param {Object} obj
 * @param {string} oldName
 * @param {string} newName
 * @returns {Object}
 */
function renameObjectKeys(obj, oldName, newName) {
    if (!obj || typeof obj !== 'object') return obj || {};
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        const nextKey = namesMatchInsensitive(key, oldName) ? newName : key;
        // Prefer keeping existing value if duplicate after rename
        if (result[nextKey] === undefined) {
            result[nextKey] = value;
        }
    }
    return result;
}

/**
 * Build relationship map key used by the parser.
 * @param {string} charA
 * @param {string} charB
 * @returns {string}
 */
function relationshipKey(charA, charB) {
    return `${charA}<->${charB}`;
}

/**
 * Rename a character across OpenVault data (states, memories, relationships, places).
 * Old name becomes an alias. Merges if newName already exists.
 * @param {Object} data
 * @param {string} oldName
 * @param {string} newName
 * @returns {{ ok: boolean, merged?: boolean, error?: string, character?: Object }}
 */
export function renameCharacter(data, oldName, newName) {
    if (!data) return { ok: false, error: 'No data' };

    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from) return { ok: false, error: 'Missing current name' };
    if (!to) return { ok: false, error: 'Name cannot be empty' };
    if (namesMatchInsensitive(from, to)) {
        // Case-only / whitespace canonicalize
        const states = ensureCharactersMap(data);
        const char = findCharacter(states, from);
        if (char && char.name !== to) {
            // Update display casing if map key matches
            const key = Object.keys(states).find(k => namesMatchInsensitive(k, from));
            if (key && key === from) {
                char.name = to;
                if (key !== to) {
                    states[to] = char;
                    delete states[key];
                }
            } else if (char) {
                char.name = to;
            }
            char.last_updated = Date.now();
            return { ok: true, character: char };
        }
        return { ok: true, character: char || null };
    }

    if (isBlacklistedName(to)) {
        return { ok: false, error: `"${to}" is blacklisted` };
    }

    const states = ensureCharactersMap(data);
    const sourceKey = Object.keys(states).find(k =>
        namesMatchInsensitive(k, from) || namesMatchInsensitive(states[k]?.name, from)
    );
    if (!sourceKey) {
        return { ok: false, error: 'Character not found' };
    }

    const source = states[sourceKey];
    const targetKey = Object.keys(states).find(k =>
        namesMatchInsensitive(k, to) || namesMatchInsensitive(states[k]?.name, to)
    );
    const merged = Boolean(targetKey && !namesMatchInsensitive(targetKey, sourceKey));

    let target;
    if (merged) {
        target = states[targetKey];
        mergeCharacterProfiles(target, source);
        pushUniqueInsensitive(target.aliases, source.name || from);
        // Remove old name from aliases if it equals new name
        target.aliases = (target.aliases || []).filter(a => !namesMatchInsensitive(a, to));
        target.name = target.name || to;
        // Prefer the requested display name if target was found by alias only
        if (!namesMatchInsensitive(target.name, to)) {
            pushUniqueInsensitive(target.aliases, target.name);
            target.name = to;
        }
        delete states[sourceKey];
        // Ensure stored under canonical key `to` when target was keyed differently
        if (targetKey !== to) {
            states[to] = target;
            if (targetKey && targetKey !== to) delete states[targetKey];
        }
    } else {
        target = source;
        pushUniqueInsensitive(target.aliases = target.aliases || [], from);
        target.aliases = target.aliases.filter(a => !namesMatchInsensitive(a, to));
        target.name = to;
        if (sourceKey !== to) {
            states[to] = target;
            delete states[sourceKey];
        }
    }

    target.last_updated = Date.now();

    // Memories
    for (const memory of (data[MEMORIES_KEY] || [])) {
        memory.characters_involved = replaceNameInList(memory.characters_involved, from, to);
        memory.witnesses = replaceNameInList(memory.witnesses, from, to);
        if (memory.emotional_impact && typeof memory.emotional_impact === 'object') {
            memory.emotional_impact = renameObjectKeys(memory.emotional_impact, from, to);
        }
        if (memory.relationship_impact && typeof memory.relationship_impact === 'object') {
            const cleaned = {};
            for (const [relKey, impact] of Object.entries(memory.relationship_impact)) {
                const match = String(relKey).match(/^(.+?)\s*->\s*(.+)$/);
                if (match) {
                    let [, a, b] = match;
                    if (namesMatchInsensitive(a, from)) a = to;
                    if (namesMatchInsensitive(b, from)) b = to;
                    cleaned[`${a}->${b}`] = impact;
                } else if (namesMatchInsensitive(relKey, from)) {
                    cleaned[to] = impact;
                } else {
                    cleaned[relKey] = impact;
                }
            }
            memory.relationship_impact = cleaned;
        }
    }

    // Relationships — re-key map entries
    const relationships = data[RELATIONSHIPS_KEY] || {};
    const nextRels = {};
    for (const [key, rel] of Object.entries(relationships)) {
        if (!rel) continue;
        let a = rel.character_a;
        let b = rel.character_b;
        if (namesMatchInsensitive(a, from)) a = to;
        if (namesMatchInsensitive(b, from)) b = to;
        rel.character_a = a;
        rel.character_b = b;
        const newKey = relationshipKey(a, b);
        if (nextRels[newKey]) {
            // Merge history into existing
            const existing = nextRels[newKey];
            existing.history = [...(existing.history || []), ...(rel.history || [])];
            existing.trust_level = Math.round(((existing.trust_level || 5) + (rel.trust_level || 5)) / 2);
            existing.tension_level = Math.round(((existing.tension_level || 0) + (rel.tension_level || 0)) / 2);
        } else {
            nextRels[newKey] = rel;
        }
    }
    data[RELATIONSHIPS_KEY] = nextRels;

    // Places — occupants and known_by
    for (const place of Object.values(data[PLACES_KEY] || {})) {
        if (!place) continue;
        if (place.occupants && typeof place.occupants === 'object') {
            const nextOcc = {};
            for (const [occName, role] of Object.entries(place.occupants)) {
                const nextName = namesMatchInsensitive(occName, from) ? to : occName;
                nextOcc[nextName] = role || nextOcc[nextName] || 'present';
            }
            place.occupants = nextOcc;
        }
        if (Array.isArray(place.known_by)) {
            place.known_by = replaceNameInList(place.known_by, from, to);
        }
    }

    return { ok: true, merged, character: target };
}
