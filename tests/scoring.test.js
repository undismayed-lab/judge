// Tests for the pure scoring logic inlined in index.html.
// Run (from the repository root): node --test
// No dependencies: the block between "@pure-begin" and "@pure-end" is cut out of index.html and evaluated in a sandbox,
// so the site stays a single self-contained file.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* @pure-begin[^*]*\*\/([\s\S]*?)\/\* @pure-end \*\//);
assert.ok(m, 'pure logic block markers not found in index.html');
const sandbox = {};
vm.runInNewContext(m[1] + '\nthis.api = { esc, normRanks, reviewText, tally };', sandbox);
const { esc, normRanks, reviewText, tally } = sandbox.api;
// Values created inside the sandbox have a different Array/Object prototype; normalize before deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));

const IDS = [1, 2, 3];
const row = (name, ranks, reviews = {}, at = '2026-11-01T10:00:00Z') => ({ name, ranks, reviews, at });
const byId = stats => Object.fromEntries(stats.map(s => [s.id, s]));

test('normRanks accepts permutations of the song ids', () => {
  assert.deepEqual(plain(normRanks([3, 1, 2], IDS)), [3, 1, 2]);
  assert.deepEqual(plain(normRanks(['2', ' 3 ', '1'], IDS)), [2, 3, 1]);
});

test('normRanks rejects malformed ballots', () => {
  for (const bad of [
    [1, 1, 1], [1, 2, 2], [1, 2], [1, 2, 3, 1], [1, 2, 4], [0, 1, 2], [-1, 2, 3],
    [1.5, 2, 3], ['1a', 2, 3], ['', 2, 3], [null, 2, 3], [true, 2, 3], [[1], 2, 3],
    '123', null, undefined, {}, { 0: 1, 1: 2, 2: 3, length: 3 },
  ]) assert.equal(normRanks(bad, IDS), null, JSON.stringify(bad));
});

test('tally: 3/2/1 points, gold count and average rank', () => {
  const { submissions, stats } = tally([row('A', [1, 2, 3]), row('B', [2, 1, 3]), row('C', [1, 3, 2])], IDS);
  assert.equal(submissions.length, 3);
  const s = byId(stats);
  assert.equal(s[1].pts, 3 + 2 + 3); assert.equal(s[1].firsts, 2); assert.equal(s[1].avg, (1 + 2 + 1) / 3);
  assert.equal(s[2].pts, 2 + 3 + 1); assert.equal(s[2].firsts, 1);
  assert.equal(s[3].pts, 1 + 1 + 2); assert.equal(s[3].firsts, 0);
  // total points always equal 6 per ballot
  assert.equal(stats.reduce((a, x) => a + x.pts, 0), 6 * 3);
  assert.deepEqual(plain(stats.map(x => [x.id, x.rank])), [[1, 1], [2, 2], [3, 3]]);
});

test('tally: equal entries share a rank and the next rank is skipped', () => {
  const { stats } = tally([row('A', [1, 2, 3]), row('B', [2, 1, 3])], IDS);
  assert.deepEqual(plain(stats.map(x => [x.id, x.pts, x.rank])), [[1, 5, 1], [2, 5, 1], [3, 2, 3]]);
});

test('tally: gold count breaks a points tie', () => {
  // A: 1 > 2 > 3, B: 3 > 2 > 1  ->  every song has 4 points;
  // songs 1 and 3 have one gold each, song 2 has none, so song 2 drops to 3rd and 1 and 3 share 1st.
  const { stats } = tally([row('A', [1, 2, 3]), row('B', [3, 2, 1])], IDS);
  assert.deepEqual(plain(stats.map(x => [x.id, x.pts, x.firsts, x.rank])), [[1, 4, 1, 1], [3, 4, 1, 1], [2, 4, 0, 3]]);
});

test('tally: no submissions gives zero points and no NaN', () => {
  const { submissions, stats } = tally([], IDS);
  assert.equal(submissions.length, 0);
  for (const s of stats) { assert.equal(s.pts, 0); assert.equal(s.avg, 0); assert.equal(s.rank, 1); }
  assert.equal(tally(null, IDS).submissions.length, 0);
});

test('tally: malformed rows are ignored instead of inflating points', () => {
  const rows = [
    row('A', [1, 2, 3]),
    row('dup', [1, 1, 1]),          // would give songs 2 and 3 four points each if counted
    row('short', [1, 2]),
    row('unknown', [1, 2, 9]),
    null, 42, 'x', { name: 'no ranks' },
  ];
  const { submissions, stats } = tally(rows, IDS);
  assert.deepEqual(plain(submissions.map(s => s.name)), ['A']);
  assert.deepEqual(plain(stats.map(x => [x.id, x.pts])), [[1, 3], [2, 2], [3, 1]]);
});

test('tally: string ids from the sheet are counted', () => {
  const { submissions, stats } = tally([row('A', ['3', '1', '2'])], IDS);
  assert.equal(submissions.length, 1);
  assert.equal(stats[0].id, 3);
});

test('tally: non-object reviews and odd names do not throw', () => {
  const { submissions } = tally([
    row('A', [1, 2, 3], 'oops'), row(null, [1, 2, 3], null), row(7, [1, 2, 3], [1, 2]),
  ], IDS);
  assert.equal(submissions.length, 3);
  assert.deepEqual(plain(submissions.map(s => s.name)), ['A', '', '7']);
  assert.equal(typeof submissions[0].reviews, 'object');
  assert.ok(Number.isNaN(tally([row('A', [1, 2, 3], {}, 'not a date')], IDS).submissions[0].at.getTime()));
});

test('reviewText only passes strings through', () => {
  assert.equal(reviewText('  good  '), 'good');
  for (const v of [undefined, null, 0, 123, {}, [], true]) assert.equal(reviewText(v), '');
});

test('esc neutralizes HTML special characters', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(5), '5');
});
