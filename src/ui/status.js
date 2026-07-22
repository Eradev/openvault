/**
 * OpenVault Status & Stats UI
 *
 * Handles status indicator and statistics display.
 */

import { getOpenVaultData, log } from '../utils.js';
import { MEMORIES_KEY, CHARACTERS_KEY, RELATIONSHIPS_KEY, PLACES_KEY } from '../constants.js';

/**
 * Set the status indicator
 * @param {string} status - 'ready', 'extracting', 'retrieving', 'error'
 */
export function setStatus(status) {
    const $indicator = $('#openvault_status');
    $indicator.removeClass('ready extracting retrieving error');
    $indicator.addClass(status);

    const statusText = {
        ready: 'Ready',
        extracting: 'Extracting...',
        retrieving: 'Retrieving...',
        error: 'Error',
    };

    $indicator.text(statusText[status] || status);
}

/**
 * Refresh statistics display
 */
export function refreshStats() {
    const data = getOpenVaultData();
    if (!data) {
        $('#openvault_stat_events').text(0);
        $('#openvault_stat_characters').text(0);
        $('#openvault_stat_relationships').text(0);
        $('#openvault_stat_places').text(0);
        return;
    }

    const placeCount = Object.keys(data[PLACES_KEY] || {}).length;
    $('#openvault_stat_events').text(data[MEMORIES_KEY]?.length || 0);
    $('#openvault_stat_characters').text(Object.keys(data[CHARACTERS_KEY] || {}).length);
    $('#openvault_stat_relationships').text(Object.keys(data[RELATIONSHIPS_KEY] || {}).length);
    $('#openvault_stat_places').text(placeCount);

    log(`Stats: ${data[MEMORIES_KEY]?.length || 0} memories, ${Object.keys(data[CHARACTERS_KEY] || {}).length} characters, ${placeCount} places`);
}
