/**
 * Round R4 (H120): Clef-Omni's published request and answer (src/decision/clef-contract.ts, the lead's), checked against
 * the FAKE fixtures in tests/fixtures/clef-omni. No service is called.
 */
import { describe, expect, it } from 'vitest';
import {
  base64Bytes, checkAnswer, checkMedia, checkRequest, CLEF_LIMITS, CLEF_OMNI_MODEL, unwrapBody,
  type ClefQuestion, type ClefRequest, type MediaCandidate,
} from '../src/decision/clef-contract.js';
import { readFixture } from './fixtures/clef-omni/fake.js';

const MiB = 1024 * 1024;

/** The questions Timmy asks for a route over codex, pi and openhands (as src/decision/service.ts builds them). */
const ASKED: Record<string, ClefQuestion> = {
  route: { type: 'choice', instructions: 'Which runtime should take this task?', criteria: { codex: 'Codex', pi: 'Pi', openhands: 'OpenHands', needs_review: 'A person should decide' } },
  human_review: { type: 'noul', instructions: 'Should a person review this before anything runs?', criteria: { true: 'yes', false: 'no' } },
};

const request = (over: Partial<ClefRequest> = {}): ClefRequest => ({ model: CLEF_OMNI_MODEL, state: { task: 'FAKE' }, questions: ASKED, ...over });

describe('checkRequest', () => {
  it('accepts the request Timmy builds', () => {
    expect(checkRequest(request())).toEqual([]);
    expect(checkRequest(request({ model: '  clef-omni ' as typeof CLEF_OMNI_MODEL }))).toEqual([]);
  });

  it('names each problem in words', () => {
    expect(checkRequest(request({ model: 'gpt' as typeof CLEF_OMNI_MODEL })).join()).toMatch(/model must be "clef-omni"/);
    expect(checkRequest(request({ state: undefined })).join()).toMatch(/state is required/);
    expect(checkRequest(request({ questions: {} })).join()).toMatch(/questions must number 1 to 64, not 0/);
    const many: Record<string, ClefQuestion> = {};
    for (let i = 0; i < 65; i++) many[`q${i}`] = { type: 'noul', instructions: 'x' };
    expect(checkRequest(request({ questions: many })).join()).toMatch(/not 65/);
    expect(checkRequest(request({ questions: { 'bad id!': { type: 'noul', instructions: 'x' } } })).join()).toMatch(/question id "bad id!"/);
    expect(checkRequest(request({ questions: { q: { type: 'noul', instructions: '  ' } } })).join()).toMatch(/needs instructions/);
    expect(checkRequest(request({ questions: { q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } } })).join()).toMatch(/2 to 255 options, not 1/);
    expect(checkRequest(request({ questions: { q: { type: 'score', instructions: 'x', criteria: ['low'] } } })).join()).toMatch(/2 to 10 levels, not 1/);
    expect(checkRequest(request({ questions: { q: { type: 'rank', instructions: 'x' } as unknown as ClefQuestion } })).join()).toMatch(/unknown type "rank"/);
  });
});

describe('checkMedia', () => {
  const img = (over: Partial<MediaCandidate> = {}): MediaCandidate => ({ kind: 'image', contentType: 'image/png', bytes: 1000, width: 100, height: 100, ...over });

  it('accepts media inside the published limits', () => {
    const r = checkMedia([img(), { kind: 'audio', contentType: 'audio/wav', bytes: 1000, seconds: 10 }, { kind: 'video', contentType: 'video/mp4', bytes: 1000, seconds: 10 }]);
    expect(r.refused).toEqual([]);
    expect(r.accepted).toHaveLength(3);
  });

  it('refuses over the counts: a fifth image, a third video, a fifth audio clip', () => {
    expect(checkMedia([img(), img(), img(), img(), img()]).refused.map((x) => x.reason)).toEqual(['more than 4 images']);
    const vid = { kind: 'video' as const, contentType: 'video/mp4', bytes: 10, seconds: 1 };
    expect(checkMedia([vid, vid, vid]).refused.map((x) => x.reason)).toEqual(['more than 2 videos']);
    const aud = { kind: 'audio' as const, contentType: 'audio/mpeg', bytes: 10, seconds: 1 };
    expect(checkMedia([aud, aud, aud, aud, aud]).refused.map((x) => x.reason)).toEqual(['more than 4 audio clips']);
  });

  it('refuses over the sizes, each and in total', () => {
    expect(checkMedia([img({ bytes: 4 * MiB + 1 })]).refused[0].reason).toBe('image over 4 MiB');
    expect(checkMedia([img({ width: 5000, height: 4000 })]).refused[0].reason).toBe('image over 16 megapixels');
    expect(checkMedia([img({ bytes: 3 * MiB }), img({ bytes: 3 * MiB }), img({ bytes: 3 * MiB })]).refused.map((x) => x.reason)).toEqual(['images over 8 MiB in total']);
    expect(checkMedia([{ kind: 'audio', contentType: 'audio/wav', bytes: 8 * MiB + 1, seconds: 1 }]).refused[0].reason).toBe('audio clip over 8 MiB');
    expect(checkMedia([{ kind: 'audio', contentType: 'audio/wav', bytes: 1, seconds: 301 }]).refused[0].reason).toBe('audio clip over 300 seconds');
    expect(checkMedia([{ kind: 'video', contentType: 'video/mp4', bytes: 16 * MiB + 1, seconds: 1 }]).refused[0].reason).toBe('video over 16 MiB');
    expect(checkMedia([{ kind: 'video', contentType: 'video/mp4', bytes: 1, seconds: 61 }]).refused[0].reason).toBe('video over 60 seconds');
    const av = checkMedia([{ kind: 'video', contentType: 'video/mp4', bytes: 10 * MiB, seconds: 5 }, { kind: 'audio', contentType: 'audio/wav', bytes: 7 * MiB, seconds: 5 }]);
    expect(av.refused.map((x) => x.reason)).toEqual(['audio and video over 16 MiB in total']);
  });

  it('refuses unknown dimensions and durations rather than assume them small', () => {
    expect(checkMedia([img({ width: undefined })]).refused[0].reason).toMatch(/size unknown/);
    expect(checkMedia([{ kind: 'audio', contentType: 'audio/wav', bytes: 1 }]).refused[0].reason).toMatch(/length unknown/);
    expect(checkMedia([{ kind: 'video', contentType: 'video/mp4', bytes: 1 }]).refused[0].reason).toMatch(/length unknown/);
  });

  it('refuses the wrong types', () => {
    expect(checkMedia([img({ contentType: 'image/gif' })]).refused[0].reason).toMatch(/not PNG, JPEG or WebP/);
    expect(checkMedia([{ kind: 'audio', contentType: 'video/mp4', bytes: 1, seconds: 1 }]).refused[0].reason).toMatch(/not audio/);
    expect(checkMedia([{ kind: 'video', contentType: 'image/png', bytes: 1, seconds: 1 }]).refused[0].reason).toMatch(/not video/);
  });

  it('counts decoded base64 bytes without decoding', () => {
    expect(base64Bytes(Buffer.from('hello world').toString('base64'))).toBe(11);
    expect(base64Bytes(Buffer.from('ab').toString('base64'))).toBe(2);
    expect(CLEF_LIMITS.images.max).toBe(4);
  });
});

describe('unwrapBody', () => {
  it('takes the result out of an envelope that succeeded', () => {
    const r = unwrapBody(readFixture('envelope-route-ok.json'));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.response as { model: string }).model).toBe('clef-omni');
  });

  it('refuses an envelope that failed, with its messages', () => {
    const r = unwrapBody(readFixture('envelope-error.json'));
    expect(r).toEqual({ ok: false, problem: 'the service answered success=false: FAKE: error from the fixture' });
  });

  it('refuses an envelope with no result, and anything that is not an object', () => {
    expect(unwrapBody({ success: true, result: null, errors: [] })).toEqual({ ok: false, problem: 'the envelope has no result' });
    expect(unwrapBody('text')).toEqual({ ok: false, problem: 'the answer is not a JSON object' });
    expect(unwrapBody(null)).toEqual({ ok: false, problem: 'the answer is not a JSON object' });
  });

  it('accepts a bare body as it is', () => {
    const bare = readFixture('response-route-ok.json');
    expect(unwrapBody(bare)).toEqual({ ok: true, response: bare });
  });
});

describe('checkAnswer against every fixture', () => {
  const answerOf = (name: string): unknown => {
    const u = unwrapBody(readFixture(name));
    if (!u.ok) throw new Error(u.problem);
    return u.response;
  };

  it.each(['response-route-ok.json', 'envelope-route-ok.json', 'response-route-tie.json', 'response-route-low.json', 'response-route-needs-review.json'])('%s matches the schema', (name) => {
    const r = checkAnswer(answerOf(name), ASKED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usageReported).toBe(true);
  });

  it.each([
    ['malformed-choice-not-argmax.json', /choice pi is not the highest probability/],
    ['malformed-missing-answer.json', /no answer for "route"/],
    ['malformed-missing-probabilities.json', /probabilities missing/],
    ['malformed-negative.json', /probability of codex is not a number from 0 to 1/],
    ['malformed-sum.json', /sum to 1\.800, not 1/],
    ['malformed-unknown-option.json', /options Timmy did not offer: hermes/],
    ['malformed-wrong-type.json', /answered as score, asked as choice/],
  ])('%s is malformed', (name, problem) => {
    const r = checkAnswer(answerOf(name), ASKED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join('; ')).toMatch(problem);
  });

  it('an unknown option is also a choice that was not offered, and a missing offered one is named', () => {
    const r = checkAnswer(answerOf('malformed-unknown-option.json'), ASKED);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join('; ')).toMatch(/choice hermes was not offered/);
      expect(r.problems.join('; ')).toMatch(/no probability for: openhands/);
    }
  });

  it('a human_review question left unanswered is malformed (the noul was renamed from needs_review)', () => {
    const body = answerOf('response-route-ok.json') as { answers: Record<string, unknown> };
    const { human_review: _h, ...rest } = body.answers;
    const r = checkAnswer({ ...body, answers: rest }, ASKED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toContain('no answer for "human_review"');
  });

  it('usage that is reported must be counts; usage left out is recorded as not reported', () => {
    const body = answerOf('response-route-ok.json') as Record<string, unknown>;
    const bad = checkAnswer({ ...body, usage: { input_tokens: 'many', output_tokens: 0 } }, ASKED);
    expect(bad.ok).toBe(false);
    const { usage: _u, ...noUsage } = body;
    const none = checkAnswer(noUsage, ASKED);
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.usageReported).toBe(false);
  });
});
