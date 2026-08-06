/**
 * OpenVault Extraction Parser
 *
 * Parses LLM extraction results and updates character states, relationships, and places.
 */

import { generateId, log } from '../utils.js';
import { CHARACTERS_KEY, RELATIONSHIPS_KEY } from '../constants.js';
import { isUnknownLocation, resolveLocation, upsertPlaceFromFacts } from '../places.js';
import { ensureCharacter, upsertCharacterFromFacts } from '../characters.js';
import { getBlacklistSet, normalizeBlacklistName } from '../blacklist.js';

/**
 * Collect characters who should know place facts from an event (witness-gated).
 * @param {Object} event
 * @returns {string[]}
 */
function getPlaceKnowers(event) {
    const knowers = new Set();
    for (const w of (event.witnesses || [])) {
        if (w) knowers.add(w);
    }
    // Non-secret involvement also learns the place
    if (!event.is_secret) {
        for (const c of (event.characters_involved || [])) {
            if (c) knowers.add(c);
        }
    }
    return Array.from(knowers);
}

/**
 * Strip blacklisted names from parsed events before state/relationship/place updates.
 * Keeps the memory; only removes the denylisted entity from involvement fields.
 * @param {Array} events
 * @param {string[]} [blacklistedNames]
 * @returns {Array} The same events array (mutated)
 */
export function sanitizeEventsAgainstBlacklist(events, blacklistedNames = null) {
    const blocked = getBlacklistSet(blacklistedNames);
    if (!events?.length || blocked.size === 0) return events || [];

    for (const event of events) {
        event.characters_involved = (event.characters_involved || [])
            .filter(n => n && !blocked.has(normalizeBlacklistName(n)));
        event.witnesses = (event.witnesses || [])
            .filter(n => n && !blocked.has(normalizeBlacklistName(n)));

        if (event.emotional_impact && typeof event.emotional_impact === 'object') {
            const cleaned = {};
            for (const [charName, emotion] of Object.entries(event.emotional_impact)) {
                if (!blocked.has(normalizeBlacklistName(charName))) {
                    cleaned[charName] = emotion;
                }
            }
            event.emotional_impact = cleaned;
        }

        if (event.relationship_impact && typeof event.relationship_impact === 'object') {
            const cleaned = {};
            for (const [relationKey, impact] of Object.entries(event.relationship_impact)) {
                const match = String(relationKey).match(/^(.+?)\s*->\s*(.+)$/);
                if (match) {
                    const [, charA, charB] = match;
                    if (
                        blocked.has(normalizeBlacklistName(charA)) ||
                        blocked.has(normalizeBlacklistName(charB))
                    ) {
                        continue;
                    }
                } else if (blocked.has(normalizeBlacklistName(relationKey))) {
                    continue;
                }
                cleaned[relationKey] = impact;
            }
            event.relationship_impact = cleaned;
        }

        if (event.place_facts?.occupants && typeof event.place_facts.occupants === 'object') {
            const cleaned = {};
            for (const [charName, role] of Object.entries(event.place_facts.occupants)) {
                if (!blocked.has(normalizeBlacklistName(charName))) {
                    cleaned[charName] = role;
                }
            }
            event.place_facts.occupants = cleaned;
        }

        if (event.character_facts && typeof event.character_facts === 'object') {
            const factsName = event.character_facts.name;
            if (factsName && blocked.has(normalizeBlacklistName(factsName))) {
                delete event.character_facts;
            } else if (Array.isArray(event.character_facts.aliases)) {
                event.character_facts.aliases = event.character_facts.aliases
                    .filter(n => n && !blocked.has(normalizeBlacklistName(n)));
            }
        }
    }

    return events;
}

/**
 * Parse extraction result from LLM
 * @param {string} jsonString - JSON string from LLM
 * @param {Array} messages - Source messages
 * @param {string} characterName - Character name
 * @param {string} userName - User name
 * @param {string} batchId - Unique batch ID for this extraction run
 * @returns {Array} Array of parsed event objects
 */
export function parseExtractionResult(jsonString, messages, characterName, userName, batchId = null) {
    try {
        // Extract JSON from response (handle markdown code blocks)
        let cleaned = jsonString;
        const jsonMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            cleaned = jsonMatch[1];
        }

        const parsed = JSON.parse(cleaned.trim());
        const events = Array.isArray(parsed) ? parsed : [parsed];

        // Get message IDs for sequence ordering
        const messageIds = messages.map(m => m.id);
        const minMessageId = Math.min(...messageIds);

        // Enrich events with metadata
        return events.map((event, index) => {
            const location = event.location || 'unknown';
            const placeFacts = event.place_facts && typeof event.place_facts === 'object'
                ? event.place_facts
                : null;
            const characterFacts = event.character_facts && typeof event.character_facts === 'object'
                ? event.character_facts
                : null;

            return {
                id: generateId(),
                ...event,
                message_ids: messageIds,
                // Sequence is based on the earliest message ID, with sub-index for multiple events from same batch
                sequence: minMessageId * 1000 + index,
                created_at: Date.now(),
                batch_id: batchId,
                characters_involved: event.characters_involved || [],
                witnesses: event.witnesses || event.characters_involved || [],
                location,
                location_id: null, // resolved in updatePlacesFromEvents
                place_facts: placeFacts,
                character_facts: characterFacts,
                is_secret: event.is_secret || false,
                importance: Math.min(5, Math.max(1, event.importance || 3)), // Clamp to 1-5, default 3
                emotional_impact: event.emotional_impact || {},
                relationship_impact: event.relationship_impact || {},
            };
        });
    } catch (error) {
        log(`Failed to parse extraction result: ${error.message}`);
        return [];
    }
}

/**
 * Update character states based on extracted events
 * @param {Array} events - Extracted events
 * @param {Object} data - OpenVault data object
 * @param {string[]} [blacklistedNames] - Optional preloaded blacklist
 */
export function updateCharacterStatesFromEvents(events, data, blacklistedNames = null) {
    data[CHARACTERS_KEY] = data[CHARACTERS_KEY] || {};
    const blocked = getBlacklistSet(blacklistedNames);

    for (const event of events) {
        // Get message range for this event
        const messageIds = event.message_ids || [];
        const messageRange = messageIds.length > 0
            ? { min: Math.min(...messageIds), max: Math.max(...messageIds) }
            : null;

        // Lasting character profile facts (nicknames, appearance, traits)
        if (event.character_facts && typeof event.character_facts === 'object') {
            const factsName = event.character_facts.name;
            if (!factsName || !blocked.has(normalizeBlacklistName(factsName))) {
                upsertCharacterFromFacts(data, event.character_facts, {
                    eventId: event.id,
                });
            }
        }

        // Update emotional impact
        if (event.emotional_impact) {
            for (const [charName, emotion] of Object.entries(event.emotional_impact)) {
                if (blocked.has(normalizeBlacklistName(charName))) continue;

                const char = ensureCharacter(data, charName);
                if (!char) continue;

                // Update emotion and track which messages it's from
                char.current_emotion = emotion;
                char.last_updated = Date.now();
                if (messageRange) {
                    char.emotion_from_messages = messageRange;
                }
            }
        }

        // Add event to witnesses' knowledge
        for (const witness of (event.witnesses || [])) {
            if (blocked.has(normalizeBlacklistName(witness))) continue;

            const char = ensureCharacter(data, witness);
            if (!char) continue;
            if (!char.known_events.includes(event.id)) {
                char.known_events.push(event.id);
            }
        }

        // Drop bulky character_facts from stored event after merge (facts live on the profile)
        delete event.character_facts;
    }
}

/**
 * Update relationships based on extracted events
 * @param {Array} events - Extracted events
 * @param {Object} data - OpenVault data object
 * @param {string[]} [blacklistedNames] - Optional preloaded blacklist
 */
export function updateRelationshipsFromEvents(events, data, blacklistedNames = null) {
    data[RELATIONSHIPS_KEY] = data[RELATIONSHIPS_KEY] || {};
    const blocked = getBlacklistSet(blacklistedNames);

    for (const event of events) {
        if (event.relationship_impact) {
            for (const [relationKey, impact] of Object.entries(event.relationship_impact)) {
                // Parse relationship key (e.g., "Alice->Bob")
                const match = relationKey.match(/^(.+?)\s*->\s*(.+)$/);
                if (!match) continue;

                const [, charA, charB] = match;
                if (
                    blocked.has(normalizeBlacklistName(charA)) ||
                    blocked.has(normalizeBlacklistName(charB))
                ) {
                    continue;
                }

                const key = `${charA}<->${charB}`;

                if (!data[RELATIONSHIPS_KEY][key]) {
                    data[RELATIONSHIPS_KEY][key] = {
                        character_a: charA,
                        character_b: charB,
                        trust_level: 5,
                        tension_level: 0,
                        relationship_type: 'acquaintance',
                        history: [],
                    };
                }

                // Update based on impact description
                const impactLower = impact.toLowerCase();
                if (impactLower.includes('trust') && impactLower.includes('increas')) {
                    data[RELATIONSHIPS_KEY][key].trust_level = Math.min(10, data[RELATIONSHIPS_KEY][key].trust_level + 1);
                } else if (impactLower.includes('trust') && impactLower.includes('decreas')) {
                    data[RELATIONSHIPS_KEY][key].trust_level = Math.max(0, data[RELATIONSHIPS_KEY][key].trust_level - 1);
                }

                if (impactLower.includes('tension') && impactLower.includes('increas')) {
                    data[RELATIONSHIPS_KEY][key].tension_level = Math.min(10, data[RELATIONSHIPS_KEY][key].tension_level + 1);
                } else if (impactLower.includes('tension') && impactLower.includes('decreas')) {
                    data[RELATIONSHIPS_KEY][key].tension_level = Math.max(0, data[RELATIONSHIPS_KEY][key].tension_level - 1);
                }

                // Add to history
                data[RELATIONSHIPS_KEY][key].history.push({
                    event_id: event.id,
                    impact: impact,
                    timestamp: Date.now(),
                });
            }
        }
    }
}

/**
 * Update place profiles from extracted events (witness-gated).
 * Also resolves location / location_id on each event.
 * @param {Array} events - Extracted events
 * @param {Object} data - OpenVault data object
 */
export function updatePlacesFromEvents(events, data) {
    for (const event of events) {
        const knowers = getPlaceKnowers(event);
        let place = null;

        // Explicit place facts (place_change or attached to other events)
        if (event.place_facts && typeof event.place_facts === 'object') {
            const facts = {
                ...event.place_facts,
                name: event.place_facts.name || event.location,
            };
            place = upsertPlaceFromFacts(data, facts, {
                eventId: event.id,
                knowers,
            });
        } else if (event.event_type === 'place_change' && !isUnknownLocation(event.location)) {
            // place_change without structured facts — still create/update from location + summary
            place = upsertPlaceFromFacts(data, {
                name: event.location,
                description: event.summary || '',
            }, {
                eventId: event.id,
                knowers,
            });
        } else if (!isUnknownLocation(event.location)) {
            // Any located event: ensure place exists and witnesses know it
            place = upsertPlaceFromFacts(data, {
                name: event.location,
            }, {
                eventId: event.id,
                knowers,
            });
        }

        if (place) {
            event.location = place.name;
            event.location_id = place.id;
        } else {
            const resolved = resolveLocation(data, event.location);
            event.location = resolved.location;
            event.location_id = resolved.location_id;
        }

        // Drop bulky place_facts from stored event after merge (facts live on the place profile)
        delete event.place_facts;
    }
}
