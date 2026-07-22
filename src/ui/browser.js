/**
 * OpenVault Memory Browser UI
 *
 * Handles memory list rendering, character states, and relationship displays.
 */

import { saveChatConditional } from '../../../../../../script.js';
import { getOpenVaultData, escapeHtml, showToast } from '../utils.js';
import { MEMORIES_KEY, CHARACTERS_KEY, RELATIONSHIPS_KEY, PLACES_KEY, MEMORIES_PER_PAGE } from '../constants.js';
import { isUnknownLocation } from '../places.js';
import { refreshStats } from './status.js';

// Pagination state for memory browser
let memoryBrowserPage = 0;

/**
 * Reset memory browser page (called on chat change)
 */
export function resetMemoryBrowserPage() {
    memoryBrowserPage = 0;
}

/**
 * Navigate to previous page
 */
export function prevPage() {
    if (memoryBrowserPage > 0) {
        memoryBrowserPage--;
        renderMemoryBrowser();
    }
}

/**
 * Navigate to next page
 */
export function nextPage() {
    memoryBrowserPage++;
    renderMemoryBrowser();
}

/**
 * Reset page and re-render (for filter changes)
 */
export function resetAndRender() {
    memoryBrowserPage = 0;
    renderMemoryBrowser();
}

/**
 * Render the memory browser list
 */
export function renderMemoryBrowser() {
    const data = getOpenVaultData();
    if (!data) {
        $('#openvault_memory_list').html('<p class="openvault-placeholder">No chat loaded</p>');
        $('#openvault_page_info').text('Page 0 / 0');
        return;
    }
    const memories = data[MEMORIES_KEY] || [];
    const $list = $('#openvault_memory_list');
    const $pageInfo = $('#openvault_page_info');
    const $prevBtn = $('#openvault_prev_page');
    const $nextBtn = $('#openvault_next_page');

    // Get filter values
    const typeFilter = $('#openvault_filter_type').val();
    const characterFilter = $('#openvault_filter_character').val();
    const locationFilter = $('#openvault_filter_location').val();

    // Filter memories
    let filteredMemories = memories.filter(m => {
        if (typeFilter && m.event_type !== typeFilter) return false;
        if (characterFilter && !m.characters_involved?.includes(characterFilter)) return false;
        if (locationFilter) {
            if (locationFilter === '__unknown__') {
                if (!isUnknownLocation(m.location)) return false;
            } else if (m.location_id !== locationFilter && m.location !== locationFilter) {
                return false;
            }
        }
        return true;
    });

    // Sort by creation date (newest first)
    filteredMemories.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    // Pagination
    const totalPages = Math.ceil(filteredMemories.length / MEMORIES_PER_PAGE) || 1;
    memoryBrowserPage = Math.min(memoryBrowserPage, totalPages - 1);
    const startIdx = memoryBrowserPage * MEMORIES_PER_PAGE;
    const pageMemories = filteredMemories.slice(startIdx, startIdx + MEMORIES_PER_PAGE);

    // Clear and render
    $list.empty();

    if (pageMemories.length === 0) {
        $list.html('<p class="openvault-placeholder">No memories yet</p>');
    } else {
        for (const memory of pageMemories) {
            const date = memory.created_at ? new Date(memory.created_at).toLocaleDateString() : 'Unknown';
            const typeClass = memory.event_type || 'action';
            const characters = (memory.characters_involved || []).map(c =>
                `<span class="openvault-character-tag">${escapeHtml(c)}</span>`
            ).join('');
            const witnesses = memory.witnesses?.length > 0
                ? `<div class="openvault-memory-witnesses">Witnesses: ${memory.witnesses.join(', ')}</div>`
                : '';
            const location = !isUnknownLocation(memory.location)
                ? `<div class="openvault-memory-location"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(memory.location)}</div>`
                : '';

            // Importance stars
            const importance = memory.importance || 3;
            const stars = '\u2605'.repeat(importance) + '\u2606'.repeat(5 - importance);

            $list.append(`
                <div class="openvault-memory-item ${typeClass}" data-id="${memory.id}">
                    <div class="openvault-memory-header">
                        <span class="openvault-memory-type">${escapeHtml(memory.event_type || 'event')}</span>
                        <span class="openvault-memory-importance" title="Importance: ${importance}/5">${stars}</span>
                        <span class="openvault-memory-date">${date}</span>
                    </div>
                    <div class="openvault-memory-summary">${escapeHtml(memory.summary || 'No summary')}</div>
                    <div class="openvault-memory-characters">${characters}</div>
                    ${location}
                    ${witnesses}
                    <div class="openvault-memory-actions">
                        <button class="menu_button openvault-delete-memory" data-id="${memory.id}">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `);
        }

        // Bind delete buttons
        $list.find('.openvault-delete-memory').on('click', async function() {
            const id = $(this).data('id');
            await deleteMemory(id);
        });
    }

    // Update pagination
    $pageInfo.text(`Page ${memoryBrowserPage + 1} of ${totalPages}`);
    $prevBtn.prop('disabled', memoryBrowserPage === 0);
    $nextBtn.prop('disabled', memoryBrowserPage >= totalPages - 1);

    // Populate character and location filter dropdowns
    populateCharacterFilter();
    populateLocationFilter();
}

/**
 * Delete a memory by ID
 * @param {string} id - Memory ID to delete
 */
async function deleteMemory(id) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return;
    }
    const idx = data[MEMORIES_KEY]?.findIndex(m => m.id === id);
    if (idx !== -1) {
        data[MEMORIES_KEY].splice(idx, 1);
        await saveChatConditional();
        refreshAllUI();
        showToast('success', 'Memory deleted');
    }
}

/**
 * Populate the character filter dropdown
 */
export function populateCharacterFilter() {
    const data = getOpenVaultData();
    if (!data) {
        $('#openvault_filter_character').find('option:not(:first)').remove();
        return;
    }
    const memories = data[MEMORIES_KEY] || [];
    const characters = new Set();

    for (const memory of memories) {
        for (const char of (memory.characters_involved || [])) {
            characters.add(char);
        }
    }

    const $filter = $('#openvault_filter_character');
    const currentValue = $filter.val();
    $filter.find('option:not(:first)').remove();

    for (const char of Array.from(characters).sort()) {
        $filter.append(`<option value="${escapeHtml(char)}">${escapeHtml(char)}</option>`);
    }

    // Restore selection if still valid
    if (currentValue && characters.has(currentValue)) {
        $filter.val(currentValue);
    }
}

/**
 * Populate the location filter dropdown
 */
export function populateLocationFilter() {
    const data = getOpenVaultData();
    const $filter = $('#openvault_filter_location');
    if (!$filter.length) return;

    if (!data) {
        $filter.find('option:not(:first)').remove();
        return;
    }

    const memories = data[MEMORIES_KEY] || [];
    const places = data[PLACES_KEY] || {};
    const options = new Map(); // value -> label

    for (const place of Object.values(places)) {
        if (place?.id && place?.name) {
            options.set(place.id, place.name);
        }
    }

    let hasUnknown = false;
    for (const memory of memories) {
        if (isUnknownLocation(memory.location)) {
            hasUnknown = true;
            continue;
        }
        if (memory.location_id && !options.has(memory.location_id)) {
            options.set(memory.location_id, memory.location);
        } else if (!memory.location_id && memory.location && ![...options.values()].includes(memory.location)) {
            options.set(memory.location, memory.location);
        }
    }

    const currentValue = $filter.val();
    $filter.find('option:not(:first)').remove();

    for (const [value, label] of [...options.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
        $filter.append(`<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`);
    }
    if (hasUnknown) {
        $filter.append('<option value="__unknown__">Unknown</option>');
    }

    if (currentValue && (options.has(currentValue) || (hasUnknown && currentValue === '__unknown__'))) {
        $filter.val(currentValue);
    }
}

/**
 * Render character states
 */
export function renderCharacterStates() {
    const data = getOpenVaultData();
    const $container = $('#openvault_character_states');
    if (!data) {
        $container.html('<p class="openvault-placeholder">No chat loaded</p>');
        return;
    }
    const characters = data[CHARACTERS_KEY] || {};

    $container.empty();

    const charNames = Object.keys(characters);
    if (charNames.length === 0) {
        $container.html('<p class="openvault-placeholder">No character data yet</p>');
        return;
    }

    for (const name of charNames.sort()) {
        const char = characters[name];
        const emotion = char.current_emotion || 'neutral';
        const intensity = char.emotion_intensity || 5;
        const knownCount = char.known_events?.length || 0;

        // Format message range for emotion source
        let emotionSource = '';
        if (char.emotion_from_messages) {
            const { min, max } = char.emotion_from_messages;
            emotionSource = min === max
                ? ` (msg ${min})`
                : ` (msgs ${min}-${max})`;
        }

        $container.append(`
            <div class="openvault-character-item">
                <div class="openvault-character-name">${escapeHtml(name)}</div>
                <div class="openvault-emotion">
                    <span class="openvault-emotion-label">${escapeHtml(emotion)}${emotionSource}</span>
                    <div class="openvault-emotion-bar">
                        <div class="openvault-emotion-fill" style="width: ${intensity * 10}%"></div>
                    </div>
                </div>
                <div class="openvault-memory-witnesses">Known events: ${knownCount}</div>
            </div>
        `);
    }
}

/**
 * Render relationships
 */
export function renderRelationships() {
    const data = getOpenVaultData();
    const $container = $('#openvault_relationships');
    if (!data) {
        $container.html('<p class="openvault-placeholder">No chat loaded</p>');
        return;
    }
    const relationships = data[RELATIONSHIPS_KEY] || {};

    $container.empty();

    const relKeys = Object.keys(relationships);
    if (relKeys.length === 0) {
        $container.html('<p class="openvault-placeholder">No relationship data yet</p>');
        return;
    }

    for (const key of relKeys.sort()) {
        const rel = relationships[key];
        const trust = rel.trust_level || 5;
        const tension = rel.tension_level || 0;
        const type = rel.relationship_type || 'acquaintance';

        $container.append(`
            <div class="openvault-relationship-item">
                <div class="openvault-relationship-pair">${escapeHtml(rel.character_a || '?')} \u2194 ${escapeHtml(rel.character_b || '?')}</div>
                <div class="openvault-relationship-type">${escapeHtml(type)}</div>
                <div class="openvault-relationship-bars">
                    <div class="openvault-bar-row">
                        <span class="openvault-bar-label">Trust</span>
                        <div class="openvault-bar-container">
                            <div class="openvault-bar-fill trust" style="width: ${trust * 10}%"></div>
                        </div>
                    </div>
                    <div class="openvault-bar-row">
                        <span class="openvault-bar-label">Tension</span>
                        <div class="openvault-bar-container">
                            <div class="openvault-bar-fill tension" style="width: ${tension * 10}%"></div>
                        </div>
                    </div>
                </div>
            </div>
        `);
    }
}

/**
 * Render places
 */
export function renderPlaces() {
    const data = getOpenVaultData();
    const $container = $('#openvault_places');
    if (!$container.length) return;

    if (!data) {
        $container.html('<p class="openvault-placeholder">No chat loaded</p>');
        return;
    }
    const places = data[PLACES_KEY] || {};

    $container.empty();

    const placeIds = Object.keys(places);
    if (placeIds.length === 0) {
        $container.html('<p class="openvault-placeholder">No place data yet</p>');
        return;
    }

    const sorted = placeIds
        .map(id => places[id])
        .filter(Boolean)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    for (const place of sorted) {
        const aliases = place.aliases?.length
            ? `<div class="openvault-place-aliases">Also known as: ${escapeHtml(place.aliases.join(', '))}</div>`
            : '';
        const description = place.description
            ? `<div class="openvault-place-description">${escapeHtml(place.description)}</div>`
            : '<div class="openvault-place-description openvault-placeholder-inline">No description yet</div>';
        const occupants = place.occupants && Object.keys(place.occupants).length > 0
            ? Object.entries(place.occupants)
                .map(([name, role]) => `<span class="openvault-occupant-tag">${escapeHtml(name)} <em>${escapeHtml(role)}</em></span>`)
                .join('')
            : '';
        const features = place.features?.length
            ? `<div class="openvault-place-features">Features: ${escapeHtml(place.features.join(', '))}</div>`
            : '';
        const knownBy = place.known_by?.length
            ? `<div class="openvault-memory-witnesses">Known by: ${escapeHtml(place.known_by.join(', '))}</div>`
            : '<div class="openvault-memory-witnesses">Known by: (none)</div>';

        $container.append(`
            <div class="openvault-place-item" data-id="${escapeHtml(place.id)}">
                <div class="openvault-place-name">${escapeHtml(place.name || place.id)}</div>
                ${aliases}
                ${description}
                ${occupants ? `<div class="openvault-place-occupants">${occupants}</div>` : ''}
                ${features}
                ${knownBy}
            </div>
        `);
    }
}

/**
 * Refresh all UI components
 */
export function refreshAllUI() {
    refreshStats();
    renderMemoryBrowser();
    renderCharacterStates();
    renderRelationships();
    renderPlaces();
}
