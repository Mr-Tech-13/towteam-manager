import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLanguage, translate } from '../public/i18n.js';

test('manager Spanish translations cover primary operations', () => {
  for (const key of ['signIn', 'nodes', 'managementAudit', 'managerUpdates', 'addNodeTitle', 'updateAllNodes']) {
    assert.notEqual(translate('es', key), translate('en', key));
    assert.notEqual(translate('es', key), key);
  }
});

test('manager Polish translations cover primary operations', () => {
  for (const key of ['signIn', 'nodes', 'managementAudit', 'managerUpdates', 'addNodeTitle', 'updateAllNodes']) {
    assert.notEqual(translate('pl', key), translate('en', key));
    assert.notEqual(translate('pl', key), key);
  }
  assert.equal(normalizeLanguage('pl'), 'pl');
});

test('manager translation interpolates values and falls back to English', () => {
  assert.equal(translate('es', 'removed', { name: 'MCO' }), 'MCO eliminado.');
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(translate('fr', 'nodes'), 'Nodes');
});
