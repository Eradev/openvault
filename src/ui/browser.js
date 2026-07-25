/**
 * OpenVault Memory Browser UI
 *
 * Handles memory list rendering, character states, and relationship displays.
 */

import { saveChatConditional } from '../../../../../../script.js';
import { getOpenVaultData, escapeHtml, showToast } from '../utils.js';
import { MEMORIES_KEY, CHARACTERS_KEY, RELATIONSHIPS_KEY, PLACES_KEY, MEMORIES_PER_PAGE } from '../constants.js';
import { isUnknownLocation } from '../places.js';
import {
    getBlacklistedNames,
    canEditBlacklist,
    addBlacklistedName,
    removeBlacklistedName,
    normalizeBlacklistName,
} from '../blacklist.js';
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
                    <div class="openvault-item-actions">
                        <button class="menu_button openvault-edit-memory" data-id="${escapeHtml(memory.id)}">
                            <i class="fa-solid fa-pen"></i> Edit
                        </button>
                        <button class="menu_button openvault-delete-memory" data-id="${escapeHtml(memory.id)}">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `);
        }

        $list.find('.openvault-edit-memory').on('click', function() {
            const $item = $(this).closest('.openvault-memory-item');
            beginMemoryEdit($item, $(this).data('id'));
        });
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
 * Switch a memory item into inline summary edit mode
 * @param {JQuery} $item - Memory item element
 * @param {string} id - Memory ID
 */
function beginMemoryEdit($item, id) {
    const data = getOpenVaultData();
    const memory = data?.[MEMORIES_KEY]?.find(m => m.id === id);
    if (!memory || !$item.length) return;

    const current = memory.summary || '';
    $item.find('.openvault-memory-summary').replaceWith(
        `<textarea class="openvault-edit-textarea openvault-memory-summary-edit" rows="3">${escapeHtml(current)}</textarea>`
    );
    $item.find('.openvault-item-actions').html(`
        <button class="menu_button openvault-save-memory" data-id="${escapeHtml(id)}">
            <i class="fa-solid fa-check"></i> Save
        </button>
        <button class="menu_button openvault-cancel-memory-edit">
            <i class="fa-solid fa-xmark"></i> Cancel
        </button>
    `);

    $item.find('.openvault-memory-summary-edit').trigger('focus');
    $item.find('.openvault-save-memory').on('click', async function() {
        const summary = $item.find('.openvault-memory-summary-edit').val();
        await saveMemorySummary(id, summary);
    });
    $item.find('.openvault-cancel-memory-edit').on('click', () => renderMemoryBrowser());
}

/**
 * Persist an edited memory summary
 * @param {string} id - Memory ID
 * @param {string} summary - New summary text
 */
async function saveMemorySummary(id, summary) {
    const trimmed = (summary || '').trim();
    if (!trimmed) {
        showToast('warning', 'Summary cannot be empty');
        return;
    }

    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return;
    }

    const memory = data[MEMORIES_KEY]?.find(m => m.id === id);
    if (!memory) {
        showToast('warning', 'Memory not found');
        return;
    }

    memory.summary = trimmed;
    await saveChatConditional();
    refreshAllUI();
    showToast('success', 'Memory updated');
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
 * Render character states and card blacklist
 */
export function renderCharacterStates() {
    const data = getOpenVaultData();
    const $container = $('#openvault_character_states');
    const editable = canEditBlacklist();
    const blacklisted = getBlacklistedNames();
    const blacklistedLower = new Set(blacklisted.map(normalizeBlacklistName));

    // Type-add controls
    $('#openvault_blacklist_input').prop('disabled', !editable);
    $('#openvault_blacklist_add_btn').prop('disabled', !editable);
    $('#openvault_blacklist_hint').text(
        editable
            ? 'Blacklisted names will not receive states, relationships, or memory involvement.'
            : 'Load a character card to manage the blacklist.'
    );

    if (!data) {
        $container.html('<p class="openvault-placeholder">No chat loaded</p>');
        return;
    }
    const characters = data[CHARACTERS_KEY] || {};

    $container.empty();

    const charNames = Object.keys(characters).sort();
    if (charNames.length === 0 && blacklisted.length === 0) {
        $container.html('<p class="openvault-placeholder">No character data yet</p>');
        return;
    }

    for (const name of charNames) {
        if (blacklistedLower.has(normalizeBlacklistName(name))) continue;

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

        const blacklistBtn = editable
            ? `<button class="menu_button openvault-blacklist-btn" data-name="${escapeHtml(name)}" title="Blacklist this name">
                    <i class="fa-solid fa-ban"></i>
               </button>`
            : '';

        $container.append(`
            <div class="openvault-character-item">
                <div class="openvault-character-header">
                    <div class="openvault-character-name">${escapeHtml(name)}</div>
                    ${blacklistBtn}
                </div>
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

    if (blacklisted.length > 0) {
        $container.append('<div class="openvault-blacklist-section-title">Blacklisted</div>');
        for (const name of [...blacklisted].sort((a, b) => a.localeCompare(b))) {
            const removeBtn = editable
                ? `<button class="menu_button openvault-unblacklist-btn" data-name="${escapeHtml(name)}" title="Remove from blacklist">
                        <i class="fa-solid fa-xmark"></i>
                   </button>`
                : '';
            $container.append(`
                <div class="openvault-character-item openvault-blacklisted-item">
                    <div class="openvault-character-header">
                        <div class="openvault-character-name">${escapeHtml(name)}</div>
                        ${removeBtn}
                    </div>
                    <div class="openvault-memory-witnesses">Excluded from states, relationships, and involvement</div>
                </div>
            `);
        }
    }

    $container.find('.openvault-blacklist-btn').on('click', async function() {
        const name = $(this).attr('data-name');
        if (!name) return;
        if (!confirm(`Blacklist "${name}" on this character card?\n\nExisting states/relationships for this name will be removed from the current chat. Memories stay, but this name will be stripped from them.`)) {
            return;
        }
        const ok = await addBlacklistedName(name);
        if (ok) refreshAllUI();
    });

    $container.find('.openvault-unblacklist-btn').on('click', async function() {
        const name = $(this).attr('data-name');
        if (!name) return;
        const ok = await removeBlacklistedName(name);
        if (ok) refreshAllUI();
    });
}

/**
 * Bind one-time handlers for the blacklist type-add controls
 */
export function bindBlacklistUI() {
    $('#openvault_blacklist_add_btn').off('click.openvault').on('click.openvault', async () => {
        const name = $('#openvault_blacklist_input').val();
        const ok = await addBlacklistedName(name);
        if (ok) {
            $('#openvault_blacklist_input').val('');
            refreshAllUI();
        }
    });

    $('#openvault_blacklist_input').off('keydown.openvault').on('keydown.openvault', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const name = $('#openvault_blacklist_input').val();
        const ok = await addBlacklistedName(name);
        if (ok) {
            $('#openvault_blacklist_input').val('');
            refreshAllUI();
        }
    });
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
                <div class="openvault-item-actions">
                    <button class="menu_button openvault-edit-place" data-id="${escapeHtml(place.id)}">
                        <i class="fa-solid fa-pen"></i> Edit
                    </button>
                </div>
            </div>
        `);
    }

    $container.find('.openvault-edit-place').on('click', function() {
        const $item = $(this).closest('.openvault-place-item');
        beginPlaceEdit($item, $(this).data('id'));
    });
}

/**
 * Switch a place item into inline description edit mode
 * @param {JQuery} $item - Place item element
 * @param {string} id - Place ID
 */
function beginPlaceEdit($item, id) {
    const data = getOpenVaultData();
    const place = data?.[PLACES_KEY]?.[id];
    if (!place || !$item.length) return;

    const current = place.description || '';
    $item.find('.openvault-place-description').replaceWith(
        `<textarea class="openvault-edit-textarea openvault-place-description-edit" rows="3">${escapeHtml(current)}</textarea>`
    );
    $item.find('.openvault-item-actions').html(`
        <button class="menu_button openvault-save-place" data-id="${escapeHtml(id)}">
            <i class="fa-solid fa-check"></i> Save
        </button>
        <button class="menu_button openvault-cancel-place-edit">
            <i class="fa-solid fa-xmark"></i> Cancel
        </button>
    `);

    $item.find('.openvault-place-description-edit').trigger('focus');
    $item.find('.openvault-save-place').on('click', async function() {
        const description = $item.find('.openvault-place-description-edit').val();
        await savePlaceDescription(id, description);
    });
    $item.find('.openvault-cancel-place-edit').on('click', () => renderPlaces());
}

/**
 * Persist an edited place description
 * @param {string} id - Place ID
 * @param {string} description - New description text
 */
async function savePlaceDescription(id, description) {
    const data = getOpenVaultData();
    if (!data) {
        showToast('warning', 'No chat loaded');
        return;
    }

    const place = data[PLACES_KEY]?.[id];
    if (!place) {
        showToast('warning', 'Place not found');
        return;
    }

    place.description = (description || '').trim();
    place.last_updated = Date.now();
    await saveChatConditional();
    refreshAllUI();
    showToast('success', 'Place updated');
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
