import { ScalarTypes } from '@roostorg/coop-types';
import { jsonStringify } from '../../../../../utils/encoding.js';
import { makeSignalPermanentError } from '../../../../../utils/errors.js';
export async function getZentropiScores(fetchHTTP, params) {
    const response = await fetchHTTP({
        url: 'https://api.zentropi.ai/v1/label',
        method: 'post',
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: jsonStringify({
            content_text: params.text,
            labeler_id: params.labelerVersionId,
        }),
        handleResponseBody: 'as-json',
        timeoutMs: 5_000,
    });
    if (!response.ok) {
        if (response.status === 404 || response.status === 401) {
            throw makeSignalPermanentError(`Zentropi API error: ${response.status}${response.status === 404
                ? ' (invalid labeler_id)'
                : ' (invalid API key)'}`, { shouldErrorSpan: true });
        }
        // Incident 2026-07-07: a 429 (rate limit) or 5xx here threw a *retryable* Error, and Coop's
        // signal framework retries it with no backoff — turning one rate-limit into a self-sustaining
        // retry storm that pinned Zentropi at its limit (and it never self-heals: the retries keep
        // generating fresh 429s). Treat rate-limit / server errors as PERMANENT for this evaluation:
        // the signal fails once (Coop's fail policy handles the missing score, exactly as when Zentropi
        // is unreachable) instead of hammering the API. The NEXT message is still a fresh single call,
        // so the labeler recovers naturally once the limit clears — it is not disabled.
        if (response.status === 429 || response.status >= 500) {
            throw makeSignalPermanentError(`Zentropi API error: ${response.status}${response.status === 429
                ? ' (rate limited)'
                : ' (server error)'}`, { shouldErrorSpan: true });
        }
        throw new Error(`Zentropi API error: ${response.status}`);
    }
    return response.body;
}
export async function runZentropiLabelerImpl(getZentropiCredentials, input, fetchScores) {
    const { value, orgId, subcategory } = input;
    const credential = await getZentropiCredentials(orgId);
    if (!credential?.apiKey) {
        throw new Error('Missing Zentropi API credentials');
    }
    if (!subcategory) {
        throw new Error('Missing labeler_id in subcategory. ' +
            'Specify a Zentropi labeler_id in the condition subcategory field.');
    }
    const response = await fetchScores({
        text: value.value,
        apiKey: credential.apiKey,
        labelerVersionId: subcategory,
    });
    // Composite score mapping:
    // label=1 (violating) → pass confidence through
    // label=0 (safe) → invert confidence
    // Result: 0 = confidently safe, 0.5 = uncertain, 1 = confidently violating
    const { label, confidence } = response;
    const score = Number(label) === 1 ? confidence : 1 - confidence;
    return {
        score,
        outputType: { scalarType: ScalarTypes.NUMBER },
    };
}
//# sourceMappingURL=zentropiUtils.js.map
