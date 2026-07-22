/**
 * OpenVault Utilities
 *
 * Core utility functions used throughout the extension.
 */

import { getContext } from '../../../../extensions.js';
import { saveChatConditional, setExtensionPrompt, extension_prompt_types } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { extensionName, METADATA_KEY, MEMORIES_KEY, CHARACTERS_KEY, RELATIONSHIPS_KEY, PLACES_KEY, LAST_PROCESSED_KEY, EXTRACTED_BATCHES_KEY } from './constants.js';

/**
 * Whether a chat message is eligible for memory extraction.
 * Visible messages always qualify. Auto-hidden messages (is_system with
 * openvault_hidden) also qualify so batch indices stay stable after hide.
 * Migration: unmarked auto-hidden user/AI turns (name matches persona/character).
 * @param {object} m - Chat message
 * @param {object} [context] - SillyTavern context (name1/name2 for migration)
 * @returns {boolean}
 */
export function isExtractableMessage(m, context = null) {
    if (!m) return false;
    if (!m.is_system) return true;
    if (m.extra?.openvault_hidden) return true;
    // Migration for chats auto-hidden before openvault_hidden tagging
    if (m.is_user) return true;
    const ctx = context || getContext();
    if (m.name && ctx) {
        if (ctx.name1 && m.name === ctx.name1) return true;
        if (ctx.name2 && m.name === ctx.name2) return true;
    }
    return false;
}

/**
 * Chat messages eligible for extraction, with absolute indices.
 * @param {object[]} chat - Full chat array
 * @param {object} [context] - SillyTavern context
 * @returns {object[]} Messages with idx set to absolute chat index
 */
export function getExtractableMessages(chat, context = null) {
    const ctx = context || getContext();
    return (chat || [])
        .map((m, idx) => ({ ...m, idx }))
        .filter(m => isExtractableMessage(m, ctx));
}

/**
 * Wrap a promise with a timeout.
 * Safe against unhandled rejections when the timeout wins first
 * (the underlying request may still abort/reject later).
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} operation - Name for error message
 */
export function withTimeout(promise, ms, operation = 'Operation') {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`${operation} timed out after ${ms}ms`));
            }
        }, ms);

        Promise.resolve(promise).then(
            value => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                }
            },
            error => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            }
        );
    });
}

/**
 * Whether an error looks like a user/system abort (not a hard failure)
 * @param {any} error
 * @returns {boolean}
 */
export function isAbortError(error) {
    if (!error) return false;
    if (error.name === 'AbortError') return true;
    if (error.type === 'aborted') return true;
    const message = String(error.message || error || '');
    return /abort(ed|ion)?|the operation was aborted|signal is aborted/i.test(message);
}

/**
 * Whether an error looks like HTTP 429 / rate limiting
 * @param {any} error
 * @returns {boolean}
 */
export function isRateLimitError(error) {
    if (!error) return false;
    if (error.status === 429 || error.statusCode === 429 || error.code === 429) return true;
    const message = String(error.message || error || '');
    return /\b429\b|too many requests|rate.?limit/i.test(message);
}

/**
 * User-facing message for transient API failures
 * @param {any} error
 * @returns {string|null} Message if transient, else null
 */
export function getTransientApiErrorMessage(error) {
    if (isAbortError(error)) {
        return 'Request was cancelled — skipped this run';
    }
    if (isRateLimitError(error)) {
        return 'Rate limited (429) — skipped this run. Try again in a moment.';
    }
    return null;
}

/**
 * Get OpenVault data from chat metadata
 * @returns {Object|null} Returns null if context is not available
 */
export function getOpenVaultData() {
    const context = getContext();
    if (!context) {
        console.warn('[OpenVault] getContext() returned null/undefined');
        return null;
    }
    if (!context.chatMetadata) {
        context.chatMetadata = {};
    }
    if (!context.chatMetadata[METADATA_KEY]) {
        context.chatMetadata[METADATA_KEY] = {
            [MEMORIES_KEY]: [],
            [CHARACTERS_KEY]: {},
            [RELATIONSHIPS_KEY]: {},
            [PLACES_KEY]: {},
            [LAST_PROCESSED_KEY]: -1,
            [EXTRACTED_BATCHES_KEY]: [],
        };
    }
    // Migrate older chats that predate places
    const data = context.chatMetadata[METADATA_KEY];
    if (!data[PLACES_KEY] || typeof data[PLACES_KEY] !== 'object') {
        data[PLACES_KEY] = {};
    }
    return data;
}

/**
 * Get current chat ID for tracking across async operations
 * @returns {string|null}
 */
export function getCurrentChatId() {
    const context = getContext();
    return context?.chatId || context?.chat_metadata?.chat_id || null;
}

/**
 * Save OpenVault data to chat metadata
 * @returns {Promise<boolean>} True if save succeeded, false otherwise
 */
export async function saveOpenVaultData() {
    try {
        await saveChatConditional();
        log('Data saved to chat metadata');
        return true;
    } catch (error) {
        console.error('[OpenVault] Failed to save data:', error);
        showToast('error', `Failed to save data: ${error.message}`);
        return false;
    }
}

/**
 * Safe wrapper for toastr to handle cases where it might not be available
 * @param {string} type - 'success', 'error', 'warning', 'info'
 * @param {string} message - Message to display
 * @param {string} title - Toast title (default: 'OpenVault')
 * @param {object} options - Additional toastr options
 */
export function showToast(type, message, title = 'OpenVault', options = {}) {
    if (typeof toastr !== 'undefined' && toastr[type]) {
        toastr[type](message, title, options);
    } else {
        console.log(`[OpenVault] Toast (${type}): ${message}`);
    }
}

/**
 * Safe wrapper for setExtensionPrompt with error handling
 * @param {string} content - Content to inject
 * @returns {boolean} True if successful
 */
export function safeSetExtensionPrompt(content) {
    try {
        setExtensionPrompt(
            extensionName,
            content,
            extension_prompt_types.IN_CHAT,
            0
        );
        return true;
    } catch (error) {
        console.error('[OpenVault] Failed to set extension prompt:', error);
        return false;
    }
}

/**
 * Generate a unique ID
 * @returns {string}
 */
export function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string}
 */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Log message if debug mode is enabled
 * @param {string} message
 */
export function log(message) {
    const settings = extension_settings[extensionName];
    if (settings?.debugMode) {
        console.log(`[OpenVault] ${message}`);
    }
}
