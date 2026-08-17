# OpenVault

**Agentic Memory Extension for SillyTavern**

OpenVault provides POV-aware memory with witness tracking, relationship dynamics, place profiles, character profiles, and emotional continuity for roleplay conversations. All data is stored locally in chat metadata - no external services required.

## Features

- **Automatic Memory Extraction**: Analyzes conversations to extract significant events, emotions, relationship changes, place facts, and lasting character facts
- **POV-Aware Retrieval**: Filters memories based on which characters witnessed events (no meta-gaming)
- **Place Memories**: Tracks locations (appearance, occupants, features) with witness-gated knowledge
- **Character Profiles**: Tracks lasting identity (nicknames, physical description, traits); edit name/description in the browser with cascade rename
- **Character Context**: Uses character card and persona descriptions for more accurate memory extraction
- **Relationship Tracking**: Monitors and records relationship dynamics between characters
- **Emotional Continuity**: Tracks emotional states and shifts across conversations
- **Auto-Hide**: Automatically hides old messages from context while preserving their memories
- **Smart Retrieval**: Optional LLM-powered selection of the most relevant memories and character profiles (shared context slots)
- **Memory Browser**: View, filter, edit, and manage extracted memories, characters, relationships, and places
- **Backfill**: Extract memories from existing chat history

## Installation

1. Open SillyTavern
2. Go to **Extensions** > **Install Extension**
3. Enter the repository URL: `https://github.com/eradev/openvault`
4. Click Install
5. Reload SillyTavern

Or manually clone into your extensions folder:

```bash
cd SillyTavern/data/<user>/extensions
git clone https://github.com/eradev/openvault
```

## Usage

### Automatic Mode (Default)

When enabled, OpenVault automatically:

1. **Before AI response**: Retrieves relevant memories and injects them as context
2. **After AI response**: Extracts new memories from the conversation (every N messages)

### Manual Mode

Use the buttons in the settings panel:

- **Extract Memories**: Analyze recent messages for significant events
- **Retrieve Context**: Manually inject relevant memories into context
- **Backfill Chat History**: Extract memories from the entire chat history

## Settings

| Setting | Description | Default |
| --------- | ------------- | --------- |
| **Enable OpenVault** | Toggle the extension on/off | On |
| **Automatic Mode** | Auto-extract and retrieve memories | On |
| **Extraction Profile** | LLM connection profile for extraction | Current |
| **Extraction Token Budget** | Max tokens for the extraction LLM response (-1 = no limit) | -1 |
| **Retrieval Token Budget** | Max tokens for injected memory context | 1000 |
| **Messages per Extraction** | Messages to analyze per extraction | 5 |
| **Memory Context** | Memories shown to extraction LLM (-1 = All) | All |
| **Smart Retrieval** | Use LLM to select relevant memories | Off |
| **Cache retrieval on reroll** | Reuse memory context on swipe/regenerate (skips extra LLM call) | On |
| **Auto-hide old messages** | Hide messages beyond threshold | On |
| **Messages to keep visible** | Auto-hide threshold | 50 |

## How It Works

### Memory Extraction

OpenVault sends recent messages to an LLM with:

- Character descriptions (from character card)
- Persona description (your character)
- Existing memories (for consistency)
- Known character names/aliases (to reuse canonical names)
- Known place names (to reuse canonical location names)

The LLM extracts structured events with:

- **Event type**: action, revelation, emotion_shift, relationship_change, place_change
- **Importance**: 1-5 scale
- **Summary**: Brief description
- **Characters involved**: Who participated
- **Witnesses**: Who observed (for POV filtering)
- **Location**: Where it happened
- **Place facts**: Appearance, occupants/roles, and notable features (when relevant)
- **Character facts**: Lasting nicknames, physical description, and traits (not clothing, mood, or temporary state)
- **Emotional/Relationship impact**: How characters were affected

### Memory Retrieval

Before the AI responds, OpenVault:

1. Analyzes the current conversation context
2. Finds relevant memories (filtered by POV/witnesses)
3. Optionally selects lasting character profiles for current scene actors when identity/appearance matters (each uses one slot from the memory budget)
4. Infers the current scene location and boosts same-place memories
5. Injects known places (witness-gated), selected character profiles, and selected memories within the token budget

### Auto-Hide

When enabled, messages older than the threshold are hidden from context (in user-assistant pairs). The memories extracted from these messages are still retrieved and injected, effectively providing summaries of hidden content.

## Data Storage

All data is stored in `chatMetadata.openvault`:

- `memories`: Array of extracted memory events
- `character_states`: Per-character emotion plus lasting profile fields (aliases, description, features)
- `relationships`: Relationship dynamics between characters
- `places`: Place profiles (description, occupants, features, who knows them)

In the Memory Browser you can edit a character's **name** (cascades to memories, relationships, and places) and **description**.

Data is per-chat and persists with the chat file.

## Memory Types

| Type | Description |
| ------ | ------------- |
| **action** | Significant actions taken by characters |
| **revelation** | New information revealed or discovered |
| **emotion_shift** | Changes in emotional state |
| **relationship_change** | Changes in how characters relate to each other |
| **place_change** | Place appearance, layout, occupants, or notable features |

## Danger Zone

- **Delete Current Chat Memories**: Removes all OpenVault data for the current chat
- **Delete All Data**: Removes all OpenVault data across all chats

## Debug Mode

Enable debug mode to see detailed logs in the browser console (F12 > Console).

## License

GNU Affero General Public License v3.0 (AGPL-3.0)

See [LICENSE](LICENSE) for details.

## Version

v0.4.0
