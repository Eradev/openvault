/**
 * OpenVault Memory Retrieval
 *
 * Main retrieval logic for selecting and injecting memories into context.
 */

import { getContext, extension_settings } from '../../../../../extensions.js';
import { getOpenVaultData, getCurrentChatId, safeSetExtensionPrompt, showToast, log } from '../utils.js';
import { extensionName, MEMORIES_KEY, CHARACTERS_KEY, PLACES_KEY, LAST_BATCH_KEY } from '../constants.js';
import { setStatus } from '../ui/status.js';
import { getActiveCharacters, getPOVContext } from '../pov.js';
import { selectRelevantMemories } from './scoring.js';
import { getRelationshipContext, formatContextForInjection } from './formatting.js';
import { getCachedRetrieval, setCachedRetrieval, clearCachedRetrieval } from '../state.js';
import {
    filterPlacesByPOV,
    inferCurrentLocation,
    selectPlacesForInjection,
} from '../places.js';

/**
 * Build a cache key for the current retrieval turn.
 * Same user message + memory set + retrieval settings → reusable on swipe/regenerate.
 * @param {string} pendingUserMessage - Last user message text
 * @returns {string|null}
 */
export function buildRetrievalCacheKey(pendingUserMessage = '') {
    const context = getContext();
    const data = getOpenVaultData();
    if (!context?.chat || !data) return null;

    const settings = extension_settings[extensionName];
    const chat = context.chat;
    let lastUserIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && !chat[i].is_system) {
            lastUserIdx = i;
            break;
        }
    }

    const memories = data[MEMORIES_KEY] || [];
    const parts = [
        getCurrentChatId() || 'unknown',
        String(lastUserIdx),
        String(pendingUserMessage.length),
        // Lightweight content fingerprint (avoid storing full message)
        String(simpleHash(pendingUserMessage)),
        String(memories.length),
        String(data[LAST_BATCH_KEY] || ''),
        String(settings.tokenBudget),
        String(settings.maxMemoriesPerRetrieval),
        settings.smartRetrievalEnabled ? '1' : '0',
        String(settings.retrievalProfile || ''),
    ];
    return parts.join('|');
}

/**
 * Simple string hash for cache keys
 * @param {string} str
 * @returns {number}
 */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

/**
 * Inject retrieved context into the prompt
 * @param {string} contextText - Formatted context to inject
 */
export function injectContext(contextText) {
    if (!contextText) {
        // Clear the injection if no context
        clearCachedRetrieval();
        safeSetExtensionPrompt('');
        return;
    }

    if (safeSetExtensionPrompt(contextText)) {
        log('Context injected into prompt');
    } else {
        log('Failed to inject context');
    }
}

/**
 * Try to reuse a cached injection for swipe/regenerate
 * @param {string} pendingUserMessage - Last user message text
 * @returns {boolean} True if cache was applied
 */
export function tryApplyCachedRetrieval(pendingUserMessage = '') {
    const key = buildRetrievalCacheKey(pendingUserMessage);
    const cached = getCachedRetrieval(key);
    if (!cached) {
        log('Retrieval cache miss');
        return false;
    }

    injectContext(cached);
    log('Retrieval cache hit - skipped smart retrieval LLM call');
    return true;
}

/**
 * Retrieve relevant context and inject into prompt
 * @returns {Promise<{memories: Object[], context: string}|null>}
 */
export async function retrieveAndInjectContext() {
    const settings = extension_settings[extensionName];
    if (!settings.enabled) {
        log('OpenVault disabled, skipping retrieval');
        return null;
    }

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        log('No chat to retrieve context for');
        return null;
    }

    const data = getOpenVaultData();
    if (!data) {
        log('No chat context available');
        return null;
    }
    const memories = data[MEMORIES_KEY] || [];

    if (memories.length === 0) {
        log('No memories stored yet');
        return null;
    }

    setStatus('retrieving');

    // Persistent toast while fetching (manual retrieve / smart selection can take a while)
    const retrievingLabel = settings.smartRetrievalEnabled
        ? 'Fetching memory context (smart retrieval)...'
        : 'Fetching memory context...';
    showToast('info', retrievingLabel, 'OpenVault', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        toastClass: 'toast openvault-retrieving-toast',
    });

    try {
        const userName = context.name1;
        const activeCharacters = getActiveCharacters();

        // Get POV context (different behavior for group chat vs narrator mode)
        const { povCharacters, isGroupChat } = getPOVContext();

        // Collect known events from all POV characters
        const knownEventIds = new Set();
        for (const charName of povCharacters) {
            const charState = data[CHARACTERS_KEY]?.[charName];
            if (charState?.known_events) {
                for (const eventId of charState.known_events) {
                    knownEventIds.add(eventId);
                }
            }
        }

        // Filter memories by POV - memories that ANY of the POV characters know
        const povCharactersLower = povCharacters.map(c => c.toLowerCase());
        const accessibleMemories = memories.filter(m => {
            // Any POV character was a witness (case-insensitive)
            if (m.witnesses?.some(w => povCharactersLower.includes(w.toLowerCase()))) return true;
            // Non-secret events that any POV character is involved in
            if (!m.is_secret && m.characters_involved?.some(c => povCharactersLower.includes(c.toLowerCase()))) return true;
            // Explicitly in any POV character's known events
            if (knownEventIds.has(m.id)) return true;
            return false;
        });

        log(`POV filter: mode=${isGroupChat ? 'group' : 'narrator'}, characters=[${povCharacters.join(', ')}], total=${memories.length}, accessible=${accessibleMemories.length}`);

        // If POV filtering is too strict, fall back to all memories with a warning
        let memoriesToUse = accessibleMemories;
        if (accessibleMemories.length === 0 && memories.length > 0) {
            log('POV filter returned 0 results, using all memories as fallback');
            memoriesToUse = memories;
        }

        if (memoriesToUse.length === 0) {
            log('No memories available');
            setStatus('ready');
            return null;
        }

        // Use first POV character for formatting (or main character for narrator mode)
        const primaryCharacter = isGroupChat ? povCharacters[0] : context.name2;

        // Get full visible chat context for relevance matching
        const recentMessages = chat
            .filter(m => !m.is_system)
            .map(m => m.mes)
            .join('\n');

        // Infer current scene location and POV-filter known places (strict — no meta-gaming)
        const currentLocation = inferCurrentLocation(
            memoriesToUse,
            data[PLACES_KEY] || {},
            recentMessages
        );
        const knownPlaces = filterPlacesByPOV(data[PLACES_KEY] || {}, povCharacters);
        if (currentLocation.location) {
            log(`Current location inferred: ${currentLocation.location} (${currentLocation.location_id || 'unresolved'})`);
        }

        // Build retrieval prompt to select relevant memories
        const relevantMemories = await selectRelevantMemories(
            memoriesToUse,
            recentMessages,
            primaryCharacter,
            activeCharacters,
            settings.maxMemoriesPerRetrieval,
            currentLocation
        );

        if (!relevantMemories || relevantMemories.length === 0) {
            log('No relevant memories found');
            setStatus('ready');
            return null;
        }

        // Get relationship context for the primary character
        const relationshipContext = getRelationshipContext(data, primaryCharacter, activeCharacters);

        // Places: current (if known) + places referenced by selected memories
        const placesForInjection = selectPlacesForInjection(
            knownPlaces,
            currentLocation.place,
            relevantMemories
        );

        // Get emotional state of primary character (with message range info)
        const primaryCharState = data[CHARACTERS_KEY]?.[primaryCharacter];
        const emotionalInfo = {
            emotion: primaryCharState?.current_emotion || 'neutral',
            fromMessages: primaryCharState?.emotion_from_messages || null,
        };

        // Format header based on mode
        const headerName = isGroupChat ? primaryCharacter : 'Scene';

        // Format and inject context
        const formattedContext = formatContextForInjection(
            relevantMemories,
            relationshipContext,
            emotionalInfo,
            headerName,
            settings.tokenBudget,
            placesForInjection
        );

        if (formattedContext) {
            injectContext(formattedContext);
            const lastUserMessage = [...chat].reverse().find(m => m.is_user && !m.is_system);
            setCachedRetrieval(buildRetrievalCacheKey(lastUserMessage?.mes || ''), formattedContext);
            log(`Injected ${relevantMemories.length} memories into context`);
            $('.openvault-retrieving-toast').remove();
            showToast('success', `Retrieved ${relevantMemories.length} relevant memories`);
        } else {
            $('.openvault-retrieving-toast').remove();
        }

        setStatus('ready');
        return { memories: relevantMemories, context: formattedContext };
    } catch (error) {
        console.error('[OpenVault] Retrieval error:', error);
        $('.openvault-retrieving-toast').remove();
        setStatus('error');
        return null;
    } finally {
        $('.openvault-retrieving-toast').remove();
    }
}

/**
 * Update the injection (for automatic mode)
 * This rebuilds and re-injects context based on current state
 * @param {string} pendingUserMessage - Optional user message not yet in chat
 */
export async function updateInjection(pendingUserMessage = '') {
    const settings = extension_settings[extensionName];

    // Clear injection if disabled or not in automatic mode
    if (!settings.enabled || !settings.automaticMode) {
        clearCachedRetrieval();
        safeSetExtensionPrompt('');
        return;
    }

    const context = getContext();
    if (!context.chat || context.chat.length === 0) {
        clearCachedRetrieval();
        safeSetExtensionPrompt('');
        return;
    }

    const data = getOpenVaultData();
    if (!data) {
        clearCachedRetrieval();
        safeSetExtensionPrompt('');
        return;
    }
    const memories = data[MEMORIES_KEY] || [];

    if (memories.length === 0) {
        clearCachedRetrieval();
        safeSetExtensionPrompt('');
        return;
    }

    const activeCharacters = getActiveCharacters();

    // Get POV context (different behavior for group chat vs narrator mode)
    const { povCharacters, isGroupChat } = getPOVContext();

    // Collect known events from all POV characters
    const knownEventIds = new Set();
    for (const charName of povCharacters) {
        const charState = data[CHARACTERS_KEY]?.[charName];
        if (charState?.known_events) {
            for (const eventId of charState.known_events) {
                knownEventIds.add(eventId);
            }
        }
    }

    // Filter memories by POV - memories that ANY of the POV characters know
    const povCharactersLower = povCharacters.map(c => c.toLowerCase());
    const accessibleMemories = memories.filter(m => {
        if (m.witnesses?.some(w => povCharactersLower.includes(w.toLowerCase()))) return true;
        if (!m.is_secret && m.characters_involved?.some(c => povCharactersLower.includes(c.toLowerCase()))) return true;
        if (knownEventIds.has(m.id)) return true;
        return false;
    });

    // Exclude memories from recent messages (they're still in context, no need to "remember")
    const recentMessageIds = new Set(
        context.chat
            .map((m, idx) => idx)
            .slice(-10)
    );

    const nonRecentMemories = accessibleMemories.filter(m => {
        if (!m.message_ids || m.message_ids.length === 0) return true;
        const allSourcesRecent = m.message_ids.every(id => recentMessageIds.has(id));
        if (allSourcesRecent) {
            log(`Excluding recent memory: "${m.summary?.substring(0, 40)}..." (from messages ${m.message_ids.join(',')})`);
            return false;
        }
        return true;
    });

    // Exclude memories from the most recent extraction batch
    const lastBatchId = data[LAST_BATCH_KEY];
    const nonBatchMemories = nonRecentMemories.filter(m => {
        if (lastBatchId && m.batch_id === lastBatchId) {
            log(`Excluding last-batch memory: "${m.summary?.substring(0, 40)}..." (batch: ${m.batch_id})`);
            return false;
        }
        return true;
    });

    log(`Retrieval: ${accessibleMemories.length} accessible, ${nonRecentMemories.length} after recent filter, ${nonBatchMemories.length} after batch filter`);

    // Fallback to all memories if filters are too strict
    let memoriesToUse = nonBatchMemories;
    if (nonBatchMemories.length === 0 && memories.length > 0) {
        log('Injection: All memories filtered out (POV, recency, or batch), using all memories as fallback');
        memoriesToUse = memories;
    }

    if (memoriesToUse.length === 0) {
        injectContext('');
        return;
    }

    // Use first POV character for formatting (or context name for narrator mode)
    const primaryCharacter = isGroupChat ? povCharacters[0] : context.name2;

    // Get full visible chat context for relevance matching
    let recentMessages = context.chat
        .filter(m => !m.is_system)
        .map(m => m.mes)
        .join('\n');

    // Include pending user message if provided (for pre-generation retrieval)
    if (pendingUserMessage) {
        recentMessages = recentMessages + '\n\n[User is about to say]: ' + pendingUserMessage;
        log(`Including pending user message in retrieval context`);
    }

    const currentLocation = inferCurrentLocation(
        memoriesToUse,
        data[PLACES_KEY] || {},
        recentMessages
    );
    const knownPlaces = filterPlacesByPOV(data[PLACES_KEY] || {}, povCharacters);

    // Select relevant memories - uses smart retrieval if enabled in settings
    const relevantMemories = await selectRelevantMemories(
        memoriesToUse,
        recentMessages,
        primaryCharacter,
        activeCharacters,
        settings.maxMemoriesPerRetrieval,
        currentLocation
    );

    if (!relevantMemories || relevantMemories.length === 0) {
        injectContext('');
        return;
    }

    // Get relationship and emotional context (with message range info)
    const relationshipContext = getRelationshipContext(data, primaryCharacter, activeCharacters);
    const placesForInjection = selectPlacesForInjection(
        knownPlaces,
        currentLocation.place,
        relevantMemories
    );
    const primaryCharState = data[CHARACTERS_KEY]?.[primaryCharacter];
    const emotionalInfo = {
        emotion: primaryCharState?.current_emotion || 'neutral',
        fromMessages: primaryCharState?.emotion_from_messages || null,
    };

    // Format header based on mode
    const headerName = isGroupChat ? primaryCharacter : 'Scene';

    // Format and inject
    const formattedContext = formatContextForInjection(
        relevantMemories,
        relationshipContext,
        emotionalInfo,
        headerName,
        settings.tokenBudget,
        placesForInjection
    );

    if (formattedContext) {
        injectContext(formattedContext);
        setCachedRetrieval(buildRetrievalCacheKey(pendingUserMessage), formattedContext);
        log(`Injection updated: ${relevantMemories.length} memories`);
    }
}
