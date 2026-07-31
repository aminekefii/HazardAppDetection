/* gemini.test.js — error classification.
 *
 * These matter because main.js reacts differently to each kind: 'auth' forces
 * the settings sheet open and tells the user their key was rejected. Getting
 * that wrong sends someone to re-paste a key that was never the problem. */
import { ok, eq, suite } from './assert.js';

globalThis.FileReader = class {
  readAsDataURL() {
    this.result = 'data:image/jpeg;base64,QUJD';
    queueMicrotask(() => this.onload());
  }
};

let respond = null;
globalThis.fetch = async () => {
  if (respond instanceof Error) throw respond;
  return respond;
};

const { verify } = await import('../../js/gemini.js');
const blob = { size: 3 };

async function kindOf() {
  try {
    const out = await verify(blob, 'fire with 91% confidence', 'k'.repeat(39));
    return { ok: true, out };
  } catch (e) { return { ok: false, kind: e.kind, retryAfterMs: e.retryAfterMs, message: e.message }; }
}

await suite('a rejected key is reported as an auth problem', async () => {
  respond = new Response(JSON.stringify({
    error: { code: 400, message: 'API key not valid. Please pass a valid API key.',
      status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
  }), { status: 400 });
  const r = await kindOf();
  eq(r.kind, 'auth', 'API_KEY_INVALID is an auth failure');

  respond = new Response('forbidden', { status: 403 });
  eq((await kindOf()).kind, 'auth', '403 is an auth failure');
});

await suite('a malformed request is not blamed on the key', async () => {
  // e.g. the JPEG exceeded the inline-data limit, or the payload was rejected
  respond = new Response(JSON.stringify({
    error: { code: 400, message: 'Invalid JSON payload received. Unknown name "inline_dat".',
      status: 'INVALID_ARGUMENT' },
  }), { status: 400 });
  const r = await kindOf();
  ok(r.kind !== 'auth', `a plain 400 is not an auth failure (got "${r.kind}")`);
  eq(r.kind, 'http', 'it is reported as an HTTP error instead');
});

await suite('quota exhaustion carries the retry delay', async () => {
  respond = new Response('Quota exceeded. Please retry in 57.8s.', { status: 429 });
  const r = await kindOf();
  eq(r.kind, 'quota', '429 is a quota failure');
  eq(r.retryAfterMs, 57800, 'the delay is parsed out of the body');

  respond = new Response('Quota exceeded.', { status: 429 });
  eq((await kindOf()).retryAfterMs, 60000, 'and defaults to a minute when absent');
});

await suite('a dead network is distinguishable from a rejection', async () => {
  respond = new TypeError('Load failed');
  eq((await kindOf()).kind, 'network', 'a thrown fetch is a network failure');
});

await suite('a verdict is returned, and bad JSON degrades instead of throwing', async () => {
  respond = new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      detected_class: 'fire', confirmed: true, danger_level: 'high',
      warning: 'There is an open flame on the counter.',
    }) }] } }],
  }), { status: 200 });
  const r = await kindOf();
  ok(r.ok, 'a good response resolves');
  eq(r.out.confirmed, true, 'the verdict is parsed');
  eq(r.out.danger_level, 'high', 'with its danger level');

  respond = new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'I am afraid I cannot do that' }] } }],
  }), { status: 200 });
  const bad = await kindOf();
  ok(bad.ok, 'unparseable text does not throw');
  eq(bad.out.confirmed, null, 'it degrades to an unconfirmed verdict');
});

console.log('\n  gemini: all assertions passed');
