import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOriginAllowed } from '../../security/origin-guard.js';

test('isOriginAllowed allows requests without origin header', () => {
  assert.equal(isOriginAllowed(undefined, ['https://example.com']), true);
});

test('isOriginAllowed enforces allowlist when configured', () => {
  assert.equal(isOriginAllowed('https://dashboard.example.com', ['https://dashboard.example.com']), true);
  assert.equal(isOriginAllowed('https://evil.example.com', ['https://dashboard.example.com']), false);
});

test('isOriginAllowed rejects malformed origin values', () => {
  assert.equal(isOriginAllowed('javascript:alert(1)', ['https://dashboard.example.com']), false);
});
