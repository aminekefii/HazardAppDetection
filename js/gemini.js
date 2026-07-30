/* gemini.js — the "double-check" call, straight from the phone. No backend.
 * Prompt copied verbatim from Model-v4.2/detect_and_verify.py so verdicts stay
 * comparable with the desktop results. */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT_TEMPLATE = `You are a safety assistant that double-checks an object detector.

An object detector flagged this image and reported: {yolo_finding}.

Look at the image yourself and respond ONLY with JSON in exactly this shape:
{
  "detected_class": "<the main hazard class the detector reported, echoed back>",
  "confirmed": <true if that hazard is really visible in the image, false if the detector was wrong>,
  "danger_level": "<one of: low, medium, high>",
  "warning": "<ONE short, natural sentence to be read ALOUD to warn a person nearby. Calm, clear, specific. Max ~15 words.>"
}

Rules:
- "confirmed" is your honest verdict on whether the detector was right. If you do NOT
  see that hazard, set it to false (this filters the detector's false positives).
- If confirmed is false, still write a warning field but keep it neutral (e.g. "No clear hazard detected.").
- The "warning" is spoken to a human, so make it sound natural, not robotic.
- If you can see WHO or WHAT is at risk (a child, a hand), mention it briefly.
- Do not add any text outside the JSON.
`;

export class GeminiError extends Error {
  constructor(kind, message, retryAfterMs = 0) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;                 // 'auth' | 'quota' | 'network' | 'http'
    this.retryAfterMs = retryAfterMs;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);
    fr.onerror = () => reject(new Error('could not read frame'));
    fr.readAsDataURL(blob);
  });
}

export function buildPrompt(finding) {
  return PROMPT_TEMPLATE.replace('{yolo_finding}', finding);
}

export async function verify(jpegBlob, finding, apiKey) {
  const data = await blobToBase64(jpegBlob);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: 'image/jpeg', data } },
          { text: buildPrompt(finding) },
        ]}],
        generationConfig: { response_mime_type: 'application/json' },
      }),
    });
  } catch (e) {
    throw new GeminiError('network', 'no connection to Gemini');
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new GeminiError('auth', 'API key rejected');
    }
    if (res.status === 429) {
      // free tier is 20 req/day; the body carries "Please retry in 57.8s"
      const m = body.match(/retry in ([\d.]+)s/i);
      throw new GeminiError('quota', 'rate limited',
        m ? Math.ceil(parseFloat(m[1]) * 1000) : 60000);
    }
    throw new GeminiError('http', `Gemini HTTP ${res.status}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    // same degradation as the Python client
    return { detected_class: '?', confirmed: null, danger_level: '?',
             warning: text || '(Gemini returned no text)' };
  }
}
