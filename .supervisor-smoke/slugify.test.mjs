import test from 'node:test';
import assert from 'node:assert/strict';

import { slugify } from './slugify.mjs';

test('ordinary words are lowercased and joined with a single hyphen', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('quick brown fox'), 'quick-brown-fox');
  assert.equal(slugify('hello world 2'), 'hello-world-2');
});

test('surrounding whitespace is trimmed', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
  assert.equal(slugify('\tHello World\n'), 'hello-world');
});

test('punctuation becomes a single hyphen', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('foo.bar'), 'foo-bar');
  assert.equal(slugify('what? yes!'), 'what-yes');
  assert.equal(slugify('e-mail me'), 'e-mail-me');
});

test('repeated separators collapse to one hyphen', () => {
  assert.equal(slugify('hello---world'), 'hello-world');
  assert.equal(slugify('hello     world'), 'hello-world');
  assert.equal(slugify('hello :: world'), 'hello-world');
  assert.equal(slugify('a ___ b'), 'a-b');
});

test('empty and whitespace-only input yield an empty string', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('\t\n'), '');
});

test('leading and trailing separators are removed', () => {
  assert.equal(slugify('---foo---bar---'), 'foo-bar');
  assert.equal(slugify('-hello-world-'), 'hello-world');
  assert.equal(slugify('  !!! Hello !!!  '), 'hello');
  assert.equal(slugify('----'), '');
});

test('non-ASCII characters are not ASCII word characters and become hyphens', () => {
  assert.equal(slugify('Ünïcödé Tëst'), 'n-c-d-t-st');
  assert.equal(slugify('café'), 'caf');
  assert.equal(slugify('naïve café'), 'na-ve-caf');
  assert.equal(slugify('你好 world'), 'world');
});
