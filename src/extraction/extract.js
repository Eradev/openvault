/**
 * OpenVault Memory Extraction
 *
 * Main extraction logic for extracting memories from messages.
 */

import { getContext, extension_settings } from '../../../../../extensions.js';
import { saveChatConditional } from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { getOpenVaultData, saveOpenVaultData, showToast, log, isExtractableMessage, getTransientApiErrorMessage, isAbortError, isRateLimitError, safeSetExtensionPrompt } from '../utils.js';
import { extensionName, MEMORIES_KEY, PLACES_KEY, LAST_PROCESSED_KEY, LAST_BATCH_KEY, EXTRACTED_BATCHES_KEY } from '../constants.js';
import { setStatus } from '../ui/status.js';
import { refreshAllUI } from '../ui/browser.js';
import { buildExtractionPrompt } from './prompts.js';
import { parseExtractionResult, sanitizeEventsAgainstBlacklist, updateCharacterStatesFromEvents, updateRelationshipsFromEvents, updatePlacesFromEvents } from './parser.js';
import { getBlacklistedNames } from '../blacklist.js';
import { clearAllLocks, clearCachedRetrieval } from '../state.js';

/**
 * Get recent memories for context during extraction
 * @param {number} count - Number of recent memories to retrieve (-1 = all, 0 = none)
 * @returns {Object[]} - Array of recent memory objects
 */
export function getRecentMemoriesForContext(count) {
    if (count === 0) return [];

    const data = getOpenVaultData();
    if (!data) return [];
    const memories = data[MEMORIES_KEY] || [];

    // Sort by sequence/creation time (newest first)
    const sorted = [...memories].sort((a, b) => {
        const seqA = a.sequence ?? a.created_at ?? 0;
        const seqB = b.sequence ?? b.created_at ?? 0;
        return seqB - seqA;
    });

    // Return all if count is -1, otherwise slice to count
    return count < 0 ? sorted : sorted.slice(0, count);
}

/**
 * Call LLM for extraction using ConnectionManagerRequestService
 * @param {string} prompt - The extraction prompt
 * @returns {Promise<string>} The LLM response content
 * @throws {Error} If the LLM call fails or no profile is available
 */
export async function callLLMForExtraction(prompt) {
    const settings = extension_settings[extensionName];

    // Get profile ID - use extraction profile or fall back to currently selected profile
    let profileId = settings.extractionProfile;

    // If no profile specified, use the currently selected profile
    if (!profileId) {
        profileId = extension_settings?.connectionManager?.selectedProfile;
        if (profileId) {
            const profiles = extension_settings?.connectionManager?.profiles || [];
            const profile = profiles.find(p => p.id === profileId);
            log(`No extraction profile set, using current profile: ${profile?.name || profileId}`);
        }
    }

    if (!profileId) {
        throw new Error('No connection profile available for extraction. Please configure a profile in Connection Manager.');
    }

    log(`Using ConnectionManagerRequestService with profile: ${profileId}`);

    // Build messages array
    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant that extracts structured data from roleplay conversations. Always respond with valid JSON only, no markdown formatting.'
        },
        { role: 'user', content: prompt }
    ];

    // Send request via ConnectionManagerRequestService
    const result = await ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        2000, // max tokens
        {
            includePreset: true,
            includeInstruct: true,
            stream: false
        },
        {} // override payload
    );

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
}

/**
 * Extract memories from messages using LLM.
 * Never rethrows — API failures (429, abort, etc.) return a soft failure result
 * so callers (and unawaited UI handlers) cannot crash SillyTavern.
 * @param {number[]} messageIds - Optional specific message IDs to extract
 * @returns {Promise<{events_created: number, messages_processed: number, failed?: boolean}|undefined>}
 */
export async function extractMemories(messageIds = null) {
    const settings = extension_settings[extensionName];
    if (!settings.enabled) {
        showToast('warning', 'OpenVault is disabled');
        return;
    }

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        showToast('warning', 'No chat messages to extract');
        return;
    }

    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat context available');
        return;
    }

    // Get messages to extract
    let messagesToExtract = [];
    if (messageIds && messageIds.length > 0) {
        // When specific IDs are provided (e.g., backfill), include hidden messages
        messagesToExtract = messageIds
            .map(id => ({ id, ...chat[id] }))
            .filter(m => m);
    } else {
        // Extract last few unprocessed messages (configurable count),
        // including auto-hidden turns so manual extract can catch up
        const lastProcessedId = data[LAST_PROCESSED_KEY] || -1;
        const messageCount = settings.messagesPerExtraction || 5;
        messagesToExtract = chat
            .map((m, idx) => ({ id: idx, ...m }))
            .filter(m => isExtractableMessage(m, context) && m.id > lastProcessedId)
            .slice(-messageCount);
    }

    if (messagesToExtract.length === 0) {
        showToast('info', 'No new messages to extract');
        return;
    }

    log(`Extracting ${messagesToExtract.length} messages`);
    setStatus('extracting');

    // Generate a unique batch ID for this extraction run
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
        const characterName = context.name2;
        const userName = context.name1;

        // Get character description from character card
        const characterDescription = context.characters?.[context.characterId]?.description || '';

        // Get persona description
        const personaDescription = context.powerUserSettings?.persona_description || '';

        // Build extraction prompt
        const messagesText = messagesToExtract.map(m => {
            const speaker = m.is_user ? userName : (m.name || characterName);
            return `[${speaker}]: ${m.mes}`;
        }).join('\n\n');

        // Get existing memories for context (to avoid duplicates and maintain consistency)
        const memoryContextCount = settings.memoryContextCount || 0;
        const existingMemories = getRecentMemoriesForContext(memoryContextCount);

        const existingPlaces = data[PLACES_KEY] || {};
        const blacklistedNames = getBlacklistedNames(context);
        const extractionPrompt = buildExtractionPrompt(
            messagesText,
            characterName,
            userName,
            existingMemories,
            characterDescription,
            personaDescription,
            existingPlaces,
            blacklistedNames
        );

        // Call LLM for extraction
        const extractedJson = await callLLMForExtraction(extractionPrompt);

        // Parse and store extracted events
        const events = parseExtractionResult(extractedJson, messagesToExtract, characterName, userName, batchId);
        sanitizeEventsAgainstBlacklist(events, blacklistedNames);

        if (events.length > 0) {
            // Add events to storage
            data[MEMORIES_KEY] = data[MEMORIES_KEY] || [];
            data[MEMORIES_KEY].push(...events);

            // Update character states, relationships, and places
            updateCharacterStatesFromEvents(events, data, blacklistedNames);
            updateRelationshipsFromEvents(events, data, blacklistedNames);
            updatePlacesFromEvents(events, data);

            // Update last processed message ID
            const maxId = Math.max(...messagesToExtract.map(m => m.id));
            data[LAST_PROCESSED_KEY] = Math.max(data[LAST_PROCESSED_KEY] || -1, maxId);

            // Store this batch ID as the most recent (for exclusion during retrieval)
            data[LAST_BATCH_KEY] = batchId;

            await saveOpenVaultData();

            log(`Extracted ${events.length} events`);
            showToast('success', `Extracted ${events.length} memory events`);
        } else {
            showToast('info', 'No significant events found in messages');
        }

        setStatus('ready');
        refreshAllUI();

        return { events_created: events.length, messages_processed: messagesToExtract.length };
    } catch (error) {
        const transientMessage = getTransientApiErrorMessage(error);
        console.error('[OpenVault] Extraction error:', error);

        if (transientMessage) {
            // Soft failure — do not rethrow (avoids unhandled rejection / ST crash)
            log(`Extraction soft-failed: ${error?.message || error}`);
            showToast('warning', transientMessage, 'OpenVault');
            setStatus('ready');
            return {
                events_created: 0,
                messages_processed: messagesToExtract.length,
                failed: true,
                reason: isRateLimitError(error) ? 'rate_limit' : isAbortError(error) ? 'aborted' : 'transient',
            };
        }

        showToast('error', `Extraction failed: ${error?.message || 'Unknown error'}`);
        setStatus('error');
        // Still do not rethrow — keep SillyTavern stable
        return {
            events_created: 0,
            messages_processed: messagesToExtract.length,
            failed: true,
            reason: 'error',
        };
    }
}

/**
 * Extract memories from all messages EXCEPT the last N in current chat
 * N is determined by the messagesPerExtraction setting
 * This backfills chat history, leaving recent messages for automatic extraction
 * @param {function} updateEventListenersFn - Function to update event listeners after backfill
 */
export async function extractAllMessages(updateEventListenersFn) {
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        showToast('warning', 'No chat messages to extract');
        return;
    }

    const settings = extension_settings[extensionName];
    const messageCount = settings.messagesPerExtraction || 5;
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat context available');
        return;
    }

    // Get all message IDs that already have memories extracted from them
    const alreadyExtractedIds = new Set();
    for (const memory of (data[MEMORIES_KEY] || [])) {
        for (const msgId of (memory.message_ids || [])) {
            alreadyExtractedIds.add(msgId);
        }
    }

    // Get all message indices (including hidden ones for import/backfill scenarios)
    const allMessageIds = chat
        .map((m, idx) => idx)
        .filter(idx => !alreadyExtractedIds.has(idx));

    if (alreadyExtractedIds.size > 0) {
        log(`Backfill: Skipping ${alreadyExtractedIds.size} already-extracted messages`);
    }

    // Exclude the last N messages (they'll be handled by regular/automatic extraction)
    let messagesToExtract = allMessageIds.slice(0, -messageCount);

    // Only extract complete batches - truncate to nearest multiple of batch size
    const completeBatches = Math.floor(messagesToExtract.length / messageCount);
    const completeMessageCount = completeBatches * messageCount;
    const remainder = messagesToExtract.length - completeMessageCount;

    if (remainder > 0) {
        log(`Truncating to ${completeBatches} complete batches (${completeMessageCount} messages), leaving ${remainder} for next batch`);
        messagesToExtract = messagesToExtract.slice(0, completeMessageCount);
    }

    if (messagesToExtract.length === 0) {
        if (alreadyExtractedIds.size > 0) {
            showToast('info', `All eligible messages already extracted (${alreadyExtractedIds.size} messages have memories)`);
        } else {
            showToast('warning', `No complete batches to extract (need ${messageCount} messages)`);
        }
        return;
    }

    // Show persistent progress toast
    setStatus('extracting');
    const $progressToast = $(toastr?.info(
        `Backfill: 0/${completeBatches} batches (0%)`,
        'OpenVault - Extracting',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            toastClass: 'toast openvault-backfill-toast'
        }
    ));

    // Process in batches
    let totalEvents = 0;

    for (let i = 0; i < completeBatches; i++) {
        const startIdx = i * messageCount;
        const batch = messagesToExtract.slice(startIdx, startIdx + messageCount);
        const batchNum = i + 1;

        // Update progress toast
        const progress = Math.round((i / completeBatches) * 100);
        $('.openvault-backfill-toast .toast-message').text(
            `Backfill: ${i}/${completeBatches} batches (${progress}%) - Processing batch ${batchNum}...`
        );

        try {
            log(`Processing batch ${batchNum}/${completeBatches} (batch index ${i})...`);
            const result = await extractMemories(batch);
            totalEvents += result?.events_created || 0;

            // On rate limit, pause longer before continuing
            if (result?.reason === 'rate_limit' && batchNum < completeBatches) {
                const cooldownMs = 15000;
                log(`Rate limited during backfill — waiting ${cooldownMs}ms`);
                $('.openvault-backfill-toast .toast-message').text(
                    `Backfill: ${i}/${completeBatches} - Rate limited, waiting...`
                );
                await new Promise(resolve => setTimeout(resolve, cooldownMs));
            }

            // Mark this batch as extracted only on success with events
            if (result && !result.failed && result.events_created > 0) {
                if (!data[EXTRACTED_BATCHES_KEY].includes(i)) {
                    data[EXTRACTED_BATCHES_KEY].push(i);
                }
            }

            // Delay between batches based on rate limit setting
            if (batchNum < completeBatches && result?.reason !== 'rate_limit') {
                const rpm = settings.backfillMaxRPM || 30;
                const delayMs = Math.ceil(60000 / rpm);
                log(`Rate limiting: waiting ${delayMs}ms (${rpm} RPM)`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        } catch (error) {
            console.error('[OpenVault] Batch extraction error:', error);
            $('.openvault-backfill-toast .toast-message').text(
                `Backfill: ${i}/${completeBatches} - Batch ${batchNum} failed, continuing...`
            );
        }
    }

    // Clear progress toast
    $('.openvault-backfill-toast').remove();

    // Reset operation state
    clearAllLocks();

    // Clear injection and save
    clearCachedRetrieval();
    safeSetExtensionPrompt('');
    await saveChatConditional();

    // Re-register event listeners
    if (updateEventListenersFn) {
        updateEventListenersFn(true);
    }

    showToast('success', `Extracted ${totalEvents} events from ${messagesToExtract.length} messages`);
    refreshAllUI();
    setStatus('ready');
    log('Backfill complete');
}
