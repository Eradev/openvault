/**
 * OpenVault Constants
 *
 * Central location for all constants, default settings, and metadata keys.
 */

export const extensionName = 'openvault';
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Metadata keys for chat storage
export const METADATA_KEY = 'openvault';
export const MEMORIES_KEY = 'memories';
export const CHARACTERS_KEY = 'character_states';
export const RELATIONSHIPS_KEY = 'relationships';
export const PLACES_KEY = 'places';
export const LAST_PROCESSED_KEY = 'last_processed_message_id';
export const LAST_BATCH_KEY = 'last_extraction_batch';
export const EXTRACTED_BATCHES_KEY = 'extracted_batches';

// Default settings
export const defaultSettings = {
    enabled: true,
    automaticMode: true,
    extractionProfile: '',
    retrievalProfile: '',
    tokenBudget: 1000,
    maxMemoriesPerRetrieval: 10,
    debugMode: false,
    // Extraction settings
    extractionTokenBudget: -1,
    extractionTimeoutSeconds: 300,
    retrievalTimeoutSeconds: 300,
    messagesPerExtraction: 10,
    memoryContextCount: -1,
    smartRetrievalEnabled: true,
    cacheRetrievalOnReroll: true,
    // Auto-hide settings
    autoHideEnabled: true,
    autoHideThreshold: 50,
    // Backfill settings
    backfillMaxRPM: 30,
};

// Timeout constants
export const GENERATION_LOCK_TIMEOUT_MS = 300000; // 5 minutes safety timeout
// Wait after AI reply before extraction to avoid competing with the main API rate limit
export const EXTRACTION_DELAY_MS = 3000;

// Pagination constants
export const MEMORIES_PER_PAGE = 10;
