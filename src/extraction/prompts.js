/**
 * OpenVault Extraction Prompts
 *
 * Builds prompts for memory extraction from messages.
 */

/**
 * Build a short list of established place names for the extraction LLM.
 * @param {Object} places - Places map
 * @returns {string}
 */
function formatKnownPlacesSection(places = {}) {
    const list = Object.values(places || {});
    if (list.length === 0) return '';

    const lines = list
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .slice(0, 40)
        .map(p => {
            const aliases = (p.aliases || []).length ? ` (aka: ${p.aliases.join(', ')})` : '';
            return `- ${p.name}${aliases}`;
        })
        .join('\n');

    return `
## Previously Established Places
Reuse these canonical place names when referring to the same location. Do not invent duplicate names for the same place.

${lines}

`;
}

/**
 * Build the extraction prompt
 * @param {string} messagesText - Formatted messages to analyze
 * @param {string} characterName - Main character name
 * @param {string} userName - User character name
 * @param {Object[]} existingMemories - Recent memories for context (optional)
 * @param {string} characterDescription - Character card description (optional)
 * @param {string} personaDescription - User persona description (optional)
 * @param {Object} existingPlaces - Known places map (optional)
 * @returns {string} The extraction prompt
 */
export function buildExtractionPrompt(messagesText, characterName, userName, existingMemories = [], characterDescription = '', personaDescription = '', existingPlaces = {}) {
    // Build character context section if we have descriptions
    let characterContextSection = '';
    if (characterDescription || personaDescription) {
        characterContextSection = '\n## Character Context\n';
        if (characterDescription) {
            characterContextSection += `### ${characterName} (AI Character)\n${characterDescription}\n\n`;
        }
        if (personaDescription) {
            characterContextSection += `### ${userName} (User's Persona)\n${personaDescription}\n\n`;
        }
    }

    // Build memory context section if we have existing memories
    let memoryContextSection = '';
    if (existingMemories && existingMemories.length > 0) {
        const memorySummaries = existingMemories
            .sort((a, b) => (a.sequence ?? a.created_at ?? 0) - (b.sequence ?? b.created_at ?? 0))
            .map((m, i) => `${i + 1}. [${m.event_type || 'event'}] ${m.summary}`)
            .join('\n');

        memoryContextSection = `
## Previously Established Memories
The following events have already been recorded. Use this context to:
- Avoid duplicating already-recorded events
- Maintain consistency with established facts
- Build upon existing character developments

${memorySummaries}

`;
    }

    const placesContextSection = formatKnownPlacesSection(existingPlaces);

    return `You are analyzing roleplay messages to extract structured memory events.

## Characters
- Main character: ${characterName}
- User's character: ${userName}
${characterContextSection}${memoryContextSection}${placesContextSection}
## Messages to analyze:
${messagesText}

## Task
Extract NEW significant events from these messages. Use the Character Context (if provided) to better understand motivations, personality traits, and relationship dynamics. For each event, identify:
1. **event_type**: One of: "action", "revelation", "emotion_shift", "relationship_change", "place_change"
2. **importance**: 1-5 scale (1=minor detail, 2=notable, 3=significant, 4=major event, 5=critical/story-changing)
3. **summary**: Brief description of what happened (1-2 sentences)
4. **characters_involved**: List of character names directly involved
5. **witnesses**: List of character names who observed this (important for POV filtering)
6. **location**: Where this happened — prefer a stable place name (reuse names from Previously Established Places when applicable). Use "unknown" only if no location is mentioned.
7. **is_secret**: Whether this information should only be known by witnesses
8. **emotional_impact**: Object mapping character names to emotional changes (e.g., {"${characterName}": "growing trust", "${userName}": "surprised"})
9. **relationship_impact**: Object describing relationship changes (e.g., {"${characterName}->${userName}": "trust increased"})
10. **place_facts** (optional): When the scene establishes or updates a place (appearance, layout, who works/lives there, notable features), include:
    - **name**: Canonical place name
    - **aliases**: Other names used for the same place (optional array)
    - **description**: What the place looks like / layout (optional)
    - **occupants**: Object mapping character names to roles (e.g., {"Maya": "bartender"}) (optional)
    - **features**: Notable features as a string array (optional)
    Use event_type "place_change" when the event is primarily about discovering or changing a place. You may also attach place_facts to other event types when location details are revealed.

Only extract events that are significant for character memory and story continuity. Skip mundane exchanges.
${existingMemories.length > 0 ? 'Do NOT duplicate events from the "Previously Established Memories" section.' : ''}

Respond with a JSON array of events:
\`\`\`json
[
  {
    "event_type": "...",
    "importance": 3,
    "summary": "...",
    "characters_involved": [...],
    "witnesses": [...],
    "location": "...",
    "is_secret": false,
    "emotional_impact": {...},
    "relationship_impact": {...},
    "place_facts": {
      "name": "...",
      "aliases": [],
      "description": "...",
      "occupants": {},
      "features": []
    }
  }
]
\`\`\`

If no significant events, respond with an empty array: []`;
}
