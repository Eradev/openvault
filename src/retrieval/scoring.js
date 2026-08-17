/**
 * OpenVault Memory Scoring
 *
 * Algorithms for selecting relevant memories and character profiles for retrieval.
 * Character profiles compete with memories for the same maxMemoriesPerRetrieval slots.
 */

import { getContext, extension_settings } from '../../../../../extensions.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { log, showToast, getTransientApiErrorMessage, resolveTimeoutMs, runWithAbortTimeout } from '../utils.js';
import { extensionName } from '../constants.js';
import { trackLlmRequest } from '../state.js';
import { hasCharacterProfile } from '../characters.js';

/**
 * Call LLM for retrieval using ConnectionManagerRequestService
 * Uses the retrieval profile setting (separate from extraction profile)
 * @param {string} prompt - The retrieval prompt
 * @returns {Promise<string>} The LLM response content
 * @throws {Error} If the LLM call fails or no profile is available
 */
async function callLLMForRetrieval(prompt) {
    const settings = extension_settings[extensionName];

    // Get profile ID - use retrieval profile or fall back to currently selected profile
    let profileId = settings.retrievalProfile;

    // If no profile specified, use the currently selected profile
    if (!profileId) {
        profileId = extension_settings?.connectionManager?.selectedProfile;
        if (profileId) {
            const profiles = extension_settings?.connectionManager?.profiles || [];
            const profile = profiles.find(p => p.id === profileId);
            log(`No retrieval profile set, using current profile: ${profile?.name || profileId}`);
        }
    }

    if (!profileId) {
        throw new Error('No connection profile available for retrieval. Please configure a profile in Connection Manager.');
    }

    try {
        log(`Using ConnectionManagerRequestService for retrieval with profile: ${profileId}`);

        // Build messages array
        const messages = [
            {
                role: 'system',
                content: 'You are a helpful assistant that analyzes memories for relevance. Always respond with valid JSON only, no markdown formatting.'
            },
            { role: 'user', content: prompt }
        ];

        // Send request via ConnectionManagerRequestService
        const timeoutMs = resolveTimeoutMs(settings.retrievalTimeoutSeconds);
        const result = await trackLlmRequest(() => runWithAbortTimeout(
            signal => ConnectionManagerRequestService.sendRequest(
                profileId,
                messages,
                1000, // max tokens (retrieval needs less than extraction)
                {
                    includePreset: true,
                    includeInstruct: true,
                    stream: false,
                    signal,
                },
                {} // override payload
            ),
            timeoutMs,
            'Memory retrieval'
        ));

        // Extract content from response
        const content = result?.content || result || '';

        if (!content) {
            throw new Error('Empty response from LLM');
        }

        // Parse reasoning if present (some models return thinking tags)
        const context = getContext();
        if (context.parseReasoningFromString) {
            const parsed = context.parseReasoningFromString(content);
            return parsed ? parsed.content : content;
        }

        return content;
    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        log(`Retrieval LLM call error: ${errorMessage}`);
        const transientMessage = getTransientApiErrorMessage(error);
        if (transientMessage) {
            showToast('warning', `Smart retrieval: ${transientMessage}`);
        } else {
            showToast('error', `Smart retrieval failed: ${errorMessage}`);
        }
        throw error;
    }
}

/**
 * Build character profile candidates for scene actors with lasting fields.
 * @param {Object} characterStates
 * @param {string[]} activeCharacters
 * @returns {Object[]}
 */
export function getCharacterProfileCandidates(characterStates, activeCharacters) {
    const states = characterStates || {};
    const result = [];
    const seen = new Set();

    for (const name of (activeCharacters || [])) {
        if (!name) continue;
        const lower = name.toLowerCase();
        if (seen.has(lower)) continue;

        let char = states[name];
        if (!char) {
            char = Object.values(states).find(c =>
                c && (
                    (c.name || '').toLowerCase() === lower
                    || (c.aliases || []).some(a => String(a).toLowerCase() === lower)
                )
            );
        }
        if (!char || !hasCharacterProfile(char)) continue;

        seen.add((char.name || name).toLowerCase());
        result.push(char);
    }

    return result;
}

/**
 * Format a short candidate line for a character profile.
 * @param {Object} char
 * @returns {string}
 */
function formatCharacterCandidateLine(char) {
    const aliases = (char.aliases || []).length ? ` aka ${char.aliases.join(', ')}` : '';
    const desc = (char.description || '').slice(0, 80);
    const features = (char.features || []).slice(0, 3).join(', ');
    const parts = [];
    if (desc) parts.push(desc);
    if (features) parts.push(`Traits: ${features}`);
    const detail = parts.length ? ` — ${parts.join(' | ')}` : '';
    return `[character] ${char.name || 'Unknown'}${aliases}${detail}`;
}

/**
 * Split a mixed scored list into memories and characters, respecting limit.
 * @param {{ type: string, item: Object, score: number }[]} scored
 * @param {number} limit
 * @returns {{ memories: Object[], characters: Object[] }}
 */
function takeTopMixed(scored, limit) {
    scored.sort((a, b) => b.score - a.score);
    const limited = limit < 0 ? scored : scored.slice(0, limit);
    return {
        memories: limited.filter(s => s.type === 'memory').map(s => s.item),
        characters: limited.filter(s => s.type === 'character').map(s => s.item),
    };
}

/**
 * Select relevant memories + character profiles using simple scoring (fast mode)
 * @param {Object[]} memories - Available memories
 * @param {string} recentContext - Recent chat context
 * @param {string} characterName - POV character name
 * @param {string[]} activeCharacters - List of active characters
 * @param {number} limit - Maximum slots (memories + character profiles)
 * @param {string|null} [currentLocationId] - Current scene place id for location boost
 * @param {Object[]} [characterCandidates] - Scene-actor profiles with lasting fields
 * @returns {{ memories: Object[], characters: Object[] }}
 */
export function selectRelevantMemoriesSimple(memories, recentContext, characterName, activeCharacters, limit, currentLocationId = null, characterCandidates = []) {
    const contextLower = (recentContext || '').toLowerCase();
    const contextWords = contextLower.split(/\s+/).filter(w => w.length > 3);
    const scored = [];

    for (const memory of (memories || [])) {
        let score = 0;

        const importance = memory.importance || 3;
        score += importance * 4;

        const age = Date.now() - memory.created_at;
        const ageHours = age / (1000 * 60 * 60);
        score += Math.max(0, 10 - ageHours);

        for (const char of activeCharacters) {
            if (memory.characters_involved?.includes(char)) score += 5;
            if (memory.witnesses?.includes(char)) score += 3;
        }

        const summaryLower = memory.summary?.toLowerCase() || '';
        for (const word of contextWords) {
            if (summaryLower.includes(word)) score += 1;
        }

        if (memory.event_type === 'revelation') score += 3;
        if (memory.event_type === 'relationship_change') score += 2;
        if (memory.event_type === 'place_change') score += 2;

        if (currentLocationId && memory.location_id === currentLocationId) {
            score += 8;
        }

        scored.push({ type: 'memory', item: memory, score });
    }

    for (const char of (characterCandidates || [])) {
        let score = 2; // base — only rises when clearly relevant
        const names = [char.name, ...(char.aliases || [])].filter(Boolean);
        for (const n of names) {
            const needle = String(n).toLowerCase();
            if (needle.length >= 2 && contextLower.includes(needle)) {
                score += 12;
            }
        }
        // Boost if involved in many high-importance memories in the pool
        for (const memory of (memories || [])) {
            const involved = (memory.characters_involved || []).some(c =>
                names.some(n => String(c).toLowerCase() === String(n).toLowerCase())
            );
            if (involved) score += (memory.importance || 3);
        }
        scored.push({ type: 'character', item: char, score });
    }

    return takeTopMixed(scored, limit);
}

/**
 * Select relevant memories + character profiles using LLM (smart mode)
 * @param {Object[]} memories
 * @param {string} recentContext
 * @param {string} characterName
 * @param {number} limit
 * @param {string|null} [currentLocationName]
 * @param {Object[]} [characterCandidates]
 * @returns {Promise<{ memories: Object[], characters: Object[] }>}
 */
export async function selectRelevantMemoriesSmart(memories, recentContext, characterName, limit, currentLocationName = null, characterCandidates = []) {
    const mems = memories || [];
    const chars = characterCandidates || [];
    const total = mems.length + chars.length;

    if (total === 0) return { memories: [], characters: [] };
    if (limit < 0 || total <= limit) {
        return { memories: mems, characters: chars };
    }

    log(`Smart retrieval: analyzing ${mems.length} memories + ${chars.length} character profiles to select ${limit}`);

    const candidates = [
        ...mems.map((m, i) => ({ type: 'memory', item: m, index: i })),
        ...chars.map((c, i) => ({ type: 'character', item: c, index: mems.length + i })),
    ];

    const numberedList = candidates.map((c, i) => {
        const num = i + 1;
        if (c.type === 'character') {
            return `${num}. ${formatCharacterCandidateLine(c.item)}`;
        }
        const m = c.item;
        const typeTag = `[${m.event_type || 'event'}]`;
        const importance = m.importance || 3;
        const importanceTag = `[\u2605${'\u2605'.repeat(importance - 1)}]`;
        const secretTag = m.is_secret ? '[Secret] ' : '';
        const locationTag = m.location && m.location !== 'unknown' ? ` @ ${m.location}` : '';
        return `${num}. ${typeTag} ${importanceTag} ${secretTag}${m.summary}${locationTag}`;
    }).join('\n');

    const locationHint = currentLocationName
        ? `\nCurrent scene location: ${currentLocationName}. Prefer memories that happened here or establish this place when relevant.\n`
        : '';

    const prompt = `You are a narrative memory analyzer. Given the current roleplay scene and a mixed list of available memories and lasting character profiles, select which items are most relevant for the AI to reference in its response.

CURRENT SCENE:
${recentContext}
${locationHint}
AVAILABLE ITEMS (numbered):
${numberedList}

[Task]: Select up to ${limit} items that would be most useful for ${characterName} to know for the current scene. Each selection uses one slot.
Consider:
- Importance level (\u2605 to \u2605\u2605\u2605\u2605\u2605) - higher importance events are more critical to the story
- Direct relevance to current conversation topics
- Character relationships being discussed
- Place / location continuity (what this room looks like, who works here)
- Background context that explains current situations
- Emotional continuity
- Secrets the character knows
- [character] profile items: include ONLY when lasting appearance, nicknames, or identity traits matter for the scene (recognition, physical description, alias confusion). Do not select character profiles by default.

[Return]: JSON object with selected item numbers (1-indexed) and brief reasoning:
{"selected": [1, 4, 7], "reasoning": "Brief explanation of why these items are relevant"}

Only return valid JSON, no markdown formatting.`;

    try {
        const response = await callLLMForRetrieval(prompt);

        let parsed;
        try {
            let cleaned = response;
            const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                cleaned = jsonMatch[1];
            }
            parsed = JSON.parse(cleaned.trim());
        } catch (parseError) {
            log(`Smart retrieval: Failed to parse LLM response, falling back to simple mode. Error: ${parseError.message}`);
            return selectRelevantMemoriesSimple(mems, recentContext, characterName, [], limit, null, chars);
        }

        const selectedIndices = parsed.selected || [];
        if (!Array.isArray(selectedIndices) || selectedIndices.length === 0) {
            log('Smart retrieval: No items selected by LLM, falling back to simple mode');
            return selectRelevantMemoriesSimple(mems, recentContext, characterName, [], limit, null, chars);
        }

        const selectedMemories = [];
        const selectedCharacters = [];
        for (const idx of selectedIndices) {
            const candidate = candidates[idx - 1];
            if (!candidate) continue;
            if (candidate.type === 'memory') selectedMemories.push(candidate.item);
            else selectedCharacters.push(candidate.item);
        }

        if (selectedMemories.length === 0 && selectedCharacters.length === 0) {
            log('Smart retrieval: Invalid indices from LLM, falling back to simple mode');
            return selectRelevantMemoriesSimple(mems, recentContext, characterName, [], limit, null, chars);
        }

        // Cap to limit in case LLM over-selected
        const capped = [];
        for (const idx of selectedIndices) {
            const candidate = candidates[idx - 1];
            if (!candidate) continue;
            capped.push(candidate);
            if (limit >= 0 && capped.length >= limit) break;
        }

        const memoriesOut = capped.filter(c => c.type === 'memory').map(c => c.item);
        const charactersOut = capped.filter(c => c.type === 'character').map(c => c.item);

        log(`Smart retrieval: LLM selected ${memoriesOut.length} memories + ${charactersOut.length} character profiles. Reasoning: ${parsed.reasoning || 'none provided'}`);
        return { memories: memoriesOut, characters: charactersOut };
    } catch (error) {
        log(`Smart retrieval error: ${error.message}, falling back to simple mode`);
        return selectRelevantMemoriesSimple(mems, recentContext, characterName, [], limit, null, chars);
    }
}

/**
 * Select relevant memories and character profiles (dispatcher).
 * @param {Object[]} memories
 * @param {string} recentContext
 * @param {string} characterName
 * @param {string[]} activeCharacters
 * @param {number} limit
 * @param {{ location_id?: string|null, location?: string|null }} [currentLocation]
 * @param {Object[]} [characterCandidates]
 * @returns {Promise<{ memories: Object[], characters: Object[] }>}
 */
export async function selectRelevantMemories(memories, recentContext, characterName, activeCharacters, limit, currentLocation = null, characterCandidates = []) {
    const settings = extension_settings[extensionName];

    if (settings.smartRetrievalEnabled) {
        return selectRelevantMemoriesSmart(
            memories,
            recentContext,
            characterName,
            limit,
            currentLocation?.location || null,
            characterCandidates
        );
    }

    return selectRelevantMemoriesSimple(
        memories,
        recentContext,
        characterName,
        activeCharacters,
        limit,
        currentLocation?.location_id || null,
        characterCandidates
    );
}
