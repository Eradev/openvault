/**
 * OpenVault Place Helpers
 *
 * Normalize, find, and merge place profiles stored in chat metadata.
 */

import { PLACES_KEY } from './constants.js';

const ARTICLE_RE = /^(the|a|an)\s+/i;
const NON_ALNUM_RE = /[^a-z0-9\s]+/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Normalize a place name into a stable id key.
 * @param {string} name
 * @returns {string}
 */
export function normalizePlaceId(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .toLowerCase()
        .trim()
        .replace(ARTICLE_RE, '')
        .replace(NON_ALNUM_RE, ' ')
        .replace(WHITESPACE_RE, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Whether a location string is missing / unknown.
 * @param {string} location
 * @returns {boolean}
 */
export function isUnknownLocation(location) {
    if (!location || typeof location !== 'string') return true;
    const trimmed = location.trim().toLowerCase();
    return !trimmed || trimmed === 'unknown' || trimmed === 'n/a' || trimmed === 'none';
}

/**
 * Ensure places map exists on OpenVault data.
 * @param {Object} data
 * @returns {Object}
 */
export function ensurePlacesMap(data) {
    if (!data[PLACES_KEY] || typeof data[PLACES_KEY] !== 'object') {
        data[PLACES_KEY] = {};
    }
    return data[PLACES_KEY];
}

/**
 * Find an existing place by id, name, or alias.
 * @param {Object} places - Places map
 * @param {string} nameOrAlias
 * @param {string[]} [extraAliases]
 * @returns {Object|null}
 */
export function findPlace(places, nameOrAlias, extraAliases = []) {
    if (!places || isUnknownLocation(nameOrAlias)) return null;

    const candidates = [nameOrAlias, ...(extraAliases || [])]
        .filter(Boolean)
        .map(s => String(s).trim())
        .filter(s => !isUnknownLocation(s));

    const candidateIds = new Set(candidates.map(normalizePlaceId).filter(Boolean));
    const candidateLower = new Set(candidates.map(c => c.toLowerCase()));

    for (const place of Object.values(places)) {
        if (!place) continue;
        if (candidateIds.has(place.id) || candidateIds.has(normalizePlaceId(place.name))) {
            return place;
        }
        if (place.name && candidateLower.has(place.name.toLowerCase())) {
            return place;
        }
        for (const alias of (place.aliases || [])) {
            if (!alias) continue;
            if (candidateIds.has(normalizePlaceId(alias)) || candidateLower.has(alias.toLowerCase())) {
                return place;
            }
        }
    }

    return null;
}

/**
 * Create an empty place profile.
 * @param {string} name
 * @returns {Object}
 */
export function createPlace(name) {
    const id = normalizePlaceId(name) || `place_${Date.now()}`;
    return {
        id,
        name: name.trim(),
        aliases: [],
        description: '',
        occupants: {},
        features: [],
        known_by: [],
        source_event_ids: [],
        last_updated: Date.now(),
    };
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
export function mergePlaceDescription(existing, incoming) {
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
 * Upsert a place from extracted facts and return the place profile.
 * @param {Object} data - OpenVault data
 * @param {Object} facts - { name, aliases?, description?, occupants?, features? }
 * @param {Object} [meta] - { eventId?, knowers? }
 * @returns {Object|null}
 */
export function upsertPlaceFromFacts(data, facts, meta = {}) {
    if (!data || !facts) return null;

    const name = facts.name || facts.location;
    if (isUnknownLocation(name)) return null;

    const places = ensurePlacesMap(data);
    const aliases = Array.isArray(facts.aliases) ? facts.aliases.filter(Boolean) : [];
    let place = findPlace(places, name, aliases);

    if (!place) {
        place = createPlace(name);
        places[place.id] = place;
    } else if (normalizePlaceId(name) && place.name && normalizePlaceId(name) !== normalizePlaceId(place.name)) {
        // Keep canonical name; record the alternate as an alias
        pushUniqueInsensitive(place.aliases, name);
    } else if (!place.name && name) {
        place.name = name.trim();
    }

    for (const alias of aliases) {
        if (normalizePlaceId(alias) === place.id) continue;
        if (alias.trim().toLowerCase() === place.name.toLowerCase()) continue;
        pushUniqueInsensitive(place.aliases, alias);
    }

    if (facts.description) {
        place.description = mergePlaceDescription(place.description, facts.description);
    }

    if (facts.occupants && typeof facts.occupants === 'object') {
        place.occupants = place.occupants || {};
        for (const [charName, role] of Object.entries(facts.occupants)) {
            if (!charName) continue;
            place.occupants[charName] = role || place.occupants[charName] || 'present';
        }
    }

    if (Array.isArray(facts.features)) {
        place.features = place.features || [];
        for (const feature of facts.features) {
            pushUniqueInsensitive(place.features, feature);
        }
    }

    if (Array.isArray(meta.knowers)) {
        place.known_by = place.known_by || [];
        for (const knower of meta.knowers) {
            pushUniqueInsensitive(place.known_by, knower);
        }
    }

    if (meta.eventId) {
        place.source_event_ids = place.source_event_ids || [];
        if (!place.source_event_ids.includes(meta.eventId)) {
            place.source_event_ids.push(meta.eventId);
        }
    }

    place.last_updated = Date.now();
    return place;
}

/**
 * Resolve a location string against known places.
 * @param {Object} data
 * @param {string} location
 * @returns {{ location: string, location_id: string|null }}
 */
export function resolveLocation(data, location) {
    if (isUnknownLocation(location)) {
        return { location: 'unknown', location_id: null };
    }
    const places = data?.[PLACES_KEY] || {};
    const place = findPlace(places, location);
    if (place) {
        return { location: place.name, location_id: place.id };
    }
    const id = normalizePlaceId(location);
    return { location: location.trim(), location_id: id || null };
}

/**
 * Filter places known by any of the given POV characters (case-insensitive).
 * @param {Object} places
 * @param {string[]} povCharacters
 * @returns {Object[]}
 */
export function filterPlacesByPOV(places, povCharacters) {
    const list = Object.values(places || {});
    if (!povCharacters?.length) return [];
    const povLower = povCharacters.map(c => c.toLowerCase());
    return list.filter(place =>
        (place.known_by || []).some(k => povLower.includes(String(k).toLowerCase()))
    );
}

/**
 * Infer the current scene location from recent accessible memories and chat text.
 * @param {Object[]} accessibleMemories
 * @param {Object} places
 * @param {string} recentChatText
 * @returns {{ location_id: string|null, location: string|null, place: Object|null }}
 */
export function inferCurrentLocation(accessibleMemories, places, recentChatText = '') {
    const placeMap = places || {};

    // Prefer most recent accessible memory with a known location
    const sorted = [...(accessibleMemories || [])].sort((a, b) => {
        const seqA = a.sequence ?? a.created_at ?? 0;
        const seqB = b.sequence ?? b.created_at ?? 0;
        return seqB - seqA;
    });

    for (const memory of sorted) {
        if (memory.location_id && placeMap[memory.location_id]) {
            const place = placeMap[memory.location_id];
            return { location_id: place.id, location: place.name, place };
        }
        if (!isUnknownLocation(memory.location)) {
            const place = findPlace(placeMap, memory.location);
            if (place) {
                return { location_id: place.id, location: place.name, place };
            }
            return {
                location_id: memory.location_id || normalizePlaceId(memory.location),
                location: memory.location,
                place: null,
            };
        }
    }

    // Light name match against known places in recent chat
    const textLower = (recentChatText || '').toLowerCase();
    if (textLower) {
        let best = null;
        let bestLen = 0;
        for (const place of Object.values(placeMap)) {
            const names = [place.name, ...(place.aliases || [])].filter(Boolean);
            for (const name of names) {
                const needle = String(name).toLowerCase();
                if (needle.length < 3) continue;
                if (textLower.includes(needle) && needle.length > bestLen) {
                    best = place;
                    bestLen = needle.length;
                }
            }
        }
        if (best) {
            return { location_id: best.id, location: best.name, place: best };
        }
    }

    return { location_id: null, location: null, place: null };
}

/**
 * Select places to inject: current place (if known) plus places referenced by selected memories.
 * @param {Object[]} knownPlaces - Already POV-filtered
 * @param {Object|null} currentPlace
 * @param {Object[]} selectedMemories
 * @returns {Object[]}
 */
export function selectPlacesForInjection(knownPlaces, currentPlace, selectedMemories) {
    const byId = new Map();
    const known = knownPlaces || [];

    if (currentPlace && known.some(p => p.id === currentPlace.id)) {
        byId.set(currentPlace.id, currentPlace);
    }

    for (const memory of (selectedMemories || [])) {
        const locId = memory.location_id;
        if (locId) {
            const match = known.find(p => p.id === locId);
            if (match) byId.set(match.id, match);
        } else if (!isUnknownLocation(memory.location)) {
            const match = findPlace(
                Object.fromEntries(known.map(p => [p.id, p])),
                memory.location
            );
            if (match) byId.set(match.id, match);
        }
    }

    // If nothing selected but we have a known current place, still include it
    if (byId.size === 0 && currentPlace && known.some(p => p.id === currentPlace.id)) {
        byId.set(currentPlace.id, currentPlace);
    }

    return Array.from(byId.values());
}
