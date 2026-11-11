const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const context = vm.createContext({
    console: { info() {}, warn() {}, error() {}, groupCollapsed() {}, groupEnd() {} },
    document: { querySelector: () => null, documentElement: {} },
    location: { pathname: '/', search: '' },
    MutationObserver: class { observe() {} },
    URLSearchParams, setTimeout, performance: { getEntriesByType: () => [] },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(__dirname + '/transcript.js', 'utf8'), context);
  return context.wlqaTranscript._internals;
}

const t = load();
const track = (languageCode, kind) => (kind ? { languageCode, kind } : { languageCode });

test('auto-dubbed video: picks the original audio language, not the first ASR track', () => {
  const response = {
    captions: { playerCaptionsTracklistRenderer: {
      captionTracks: [track('bn', 'asr'), track('nl', 'asr'), track('en', 'asr'), track('ru', 'asr')],
      audioTracks: [{ audioTrackId: 'iw.10', defaultCaptionTrackIndex: 2 }, { audioTrackId: 'en-US.4', defaultCaptionTrackIndex: 2 }],
      defaultAudioTrackIndex: 1,
    } },
    streamingData: { adaptiveFormats: [{ audioTrack: { id: 'en-US.4', displayName: 'English (US) original' } }] },
  };
  const choice = t.pickTrack(response, null);
  assert.equal(choice.track.languageCode, 'en');
  assert.equal(choice.kind, 'asr');
  assert.equal(choice.spoken, 'en');
});

test('prefers a manual track in the spoken language, and honours an explicit language', () => {
  const response = { captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [track('de', 'asr'), track('en'), track('de')] } } };
  assert.deepEqual(t.pickTrack(response, null).track, track('de'));
  assert.equal(t.pickTrack(response, null).kind, null);
  assert.deepEqual(t.pickTrack(response, 'en').track, track('en'));
});

test('no caption tracks yields no track', () => {
  assert.equal(t.pickTrack({}, null).track, null);
});

test('parses json3 events and builds a grouped transcript with evidence', () => {
  const cues = t.cuesFrom({ events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: '  world' }] },
    { tStartMs: 2000, dDurationMs: 100, segs: [{ utf8: '\n' }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'again' }] },
    { tStartMs: 3_700_000, dDurationMs: 2000, segs: [{ utf8: 'late' }] },
    { segs: [{ utf8: 'no time' }] },
  ] });
  assert.equal(cues.length, 3);
  const { evidence, text } = t.buildTranscript(
    { videoId: 'abcdefghijk', title: 'T', author: 'C', lengthSeconds: '3720', shortDescription: 'D' },
    track('en', 'asr'), 'asr', cues);
  assert.equal(evidence.caption_kind, 'asr');
  assert.equal(evidence.last_end, 3702);
  assert.equal(evidence.tail_gap_seconds, 18);
  assert.equal(evidence.needs_tail_review, false);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'YOUTUBE-SOURCE TRANSCRIPT');
  assert.equal(JSON.parse(lines[1]).description, 'D');
  assert.deepEqual(lines.slice(3), ['[0:00] Hello world again', '[1:01:40] late']);
});

test('file name strips characters that are invalid in file names', () => {
  assert.equal(t.fileName({ title: 'A/B: "c"?', videoId: 'abcdefghijk' }), 'A B c [abcdefghijk].transcript.txt');
});
