import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __private__ } from '../../orchestrator/synthesizer.js';

test('synthesizer detects explicit source requests', () => {
  assert.equal(__private__.userExplicitlyAskedForSources('Kaynakları da paylaşır mısın?'), true);
  assert.equal(__private__.userExplicitlyAskedForSources('Bunu kısa ve net anlat'), false);
});

test('synthesizer strips trailing sources section for clean answer mode', () => {
  const raw = 'Ana cevap burada.\n\nSources:\n- https://example.com/a\n- https://example.com/b';
  const cleaned = __private__.stripTrailingSourcesSection(raw);

  assert.equal(cleaned, 'Ana cevap burada.');
});

test('on_demand mode attaches sources only when explicitly requested', () => {
  const asked = __private__.shouldAttachSources({
    query: 'Lütfen kaynak ver',
    hasCitations: true,
    verification: { sufficient: true, confidence: 0.9, reason: 'ok' }
  });

  const notAsked = __private__.shouldAttachSources({
    query: 'Kısa özet çıkar',
    hasCitations: true,
    verification: { sufficient: true, confidence: 0.9, reason: 'ok' }
  });

  assert.equal(asked, true);
  assert.equal(notAsked, false);
});
