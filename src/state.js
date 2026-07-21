/**
 * OpenVault State Management
 *
 * Handles operation state machine, generation locks, and chat loading cooldown.
 */

import { GENERATION_LOCK_TIMEOUT_MS } from './constants.js';

// Operation state machine to prevent concurrent operations
export const operationState = {
    generationInProgress: false,
    extractionInProgress: false,
    retrievalInProgress: false,
};

// Generation lock timeout handle
let generationLockTimeout = null;

// Chat loading state - prevents operations during initial chat load
// Start with cooldown active to prevent any operations before APP_READY completes
let chatLoadingCooldown = true;
let chatLoadingTimeout = null;

// Cached memory injection for swipe/regenerate (avoids redundant smart-retrieval calls)
let retrievalCache = {
    key: null,
    contextText: null,
};

/**
 * Generation types that reuse the previous turn's prompt context
 * @param {string} type - SillyTavern generation type
 * @returns {boolean}
 */
export function isRerollGenerationType(type) {
    return type === 'swipe' || type === 'regenerate';
}

/**
 * Get cached retrieval context if the key matches
 * @param {string} key - Cache key for the current turn
 * @returns {string|null}
 */
export function getCachedRetrieval(key) {
    if (!key || !retrievalCache.key || retrievalCache.key !== key) {
        return null;
    }
    return retrievalCache.contextText || null;
}

/**
 * Store retrieval context for later rerolls
 * @param {string} key - Cache key for the current turn
 * @param {string} contextText - Formatted injection text
 */
export function setCachedRetrieval(key, contextText) {
    retrievalCache = {
        key: key || null,
        contextText: contextText || null,
    };
}

/**
 * Clear the retrieval cache (chat change, disable, etc.)
 */
export function clearCachedRetrieval() {
    retrievalCache = {
        key: null,
        contextText: null,
    };
}

/**
 * Set generation lock with safety timeout
 */
export function setGenerationLock() {
    operationState.generationInProgress = true;

    // Clear any existing safety timeout
    if (generationLockTimeout) {
        clearTimeout(generationLockTimeout);
    }

    // Set safety timeout - if GENERATION_ENDED doesn't fire, clear the lock anyway
    generationLockTimeout = setTimeout(() => {
        if (operationState.generationInProgress) {
            console.warn('OpenVault: Generation lock timeout - clearing stale lock');
            operationState.generationInProgress = false;
        }
    }, GENERATION_LOCK_TIMEOUT_MS);
}

/**
 * Clear generation lock and cancel safety timeout
 */
export function clearGenerationLock() {
    operationState.generationInProgress = false;
    if (generationLockTimeout) {
        clearTimeout(generationLockTimeout);
        generationLockTimeout = null;
    }
}

/**
 * Clear all generation lock state (for backfill completion)
 */
export function clearAllLocks() {
    operationState.generationInProgress = false;
    operationState.extractionInProgress = false;
    operationState.retrievalInProgress = false;
    if (generationLockTimeout) {
        clearTimeout(generationLockTimeout);
        generationLockTimeout = null;
    }
}

/**
 * Check if chat loading cooldown is active
 * @returns {boolean}
 */
export function isChatLoadingCooldown() {
    return chatLoadingCooldown;
}

/**
 * Set chat loading cooldown with automatic clear after timeout
 * @param {number} timeoutMs - Timeout in milliseconds (default 2000)
 * @param {function} logFn - Optional logging function
 */
export function setChatLoadingCooldown(timeoutMs = 2000, logFn = null) {
    chatLoadingCooldown = true;
    if (chatLoadingTimeout) {
        clearTimeout(chatLoadingTimeout);
    }
    chatLoadingTimeout = setTimeout(() => {
        chatLoadingCooldown = false;
        if (logFn) logFn('Chat load cooldown cleared');
    }, timeoutMs);
}

/**
 * Reset operation states on chat change (only if safe)
 */
export function resetOperationStatesIfSafe() {
    if (!operationState.generationInProgress) {
        operationState.extractionInProgress = false;
        operationState.retrievalInProgress = false;
    }
}
