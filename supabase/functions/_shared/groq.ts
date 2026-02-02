/**
 * Groq API Client
 * Handles Llama 3.3 70B calls for nuanced file analysis.
 * Free tier: 14,400 requests/day.
 */

const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export interface AnalysisSuggestion {
  category: 'delete' | 'archive' | 'rename' | 'structure';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  file_path: string;
  suggested_value: string | null;
  confidence: number;
}

/**
 * Returns true if Groq API key is configured.
 */
export function isGroqAvailable(): boolean {
  return GROQ_API_KEY.length > 0;
}

/**
 * Call Groq with Llama 3.3 70B and get JSON suggestions back.
 */
export async function analyzeFiles(
  fileData: any,
  systemPrompt: string
): Promise<AnalysisSuggestion[]> {
  if (!GROQ_API_KEY) {
    console.warn('GROQ_API_KEY not set — skipping AI analysis');
    return [];
  }

  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(fileData) },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from Groq');
  }

  const parsed = JSON.parse(content);
  return parsed.suggestions || [];
}

/**
 * System prompt for AI analysis — only used for files NOT caught by the rules engine.
 * Focuses on nuanced analysis that deterministic rules can't handle.
 */
export const ANALYSIS_SYSTEM_PROMPT = `You are a 5S file organization expert analyzing a SharePoint document library. These files were NOT caught by deterministic rules, so focus on nuanced analysis.

Return valid JSON:
{
  "suggestions": [
    {
      "category": "delete|archive|rename|structure",
      "severity": "low|medium|high|critical",
      "title": "Short label",
      "description": "Why this action is recommended",
      "file_path": "/exact/path/to/file.ext",
      "suggested_value": "new-name.ext or /new/path or null",
      "confidence": 0.0 to 1.0
    }
  ]
}

Focus on things rules can't catch:
- Semantic duplicates (different names but same content purpose, e.g. "Budget Q1" and "Q1 Financial Plan")
- Context-aware renames (suggest meaningful names based on path context and naming patterns nearby)
- Structure reorganization (files that belong in a different folder based on content type)
- Obsolete project folders (whole directories that appear to be for completed/abandoned projects)
- Mixed-purpose folders (folders containing unrelated file types that should be separated)

## Rules
- Be conservative with delete — prefer archive when unsure
- Never suggest deleting compliance, regulatory, IEP, student records, board minutes, or accreditation docs
- Confidence: 0.5 = unsure, 0.8 = likely, 0.95+ = very confident
- Keep suggestions actionable and specific`;
