import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teamReviewAction } from '../src/standardization/team-review-status.js';

test('current manual decision resolves a historical pending review', () => {
  assert.equal(teamReviewAction({ pending: true, protectedDecision: true, manualDecisionAction: 'assign', nowSupported: false }), 'manual_preserved');
});

test('current quarantine remains pending until evidence changes', () => {
  assert.equal(teamReviewAction({ pending: true, protectedDecision: true, manualDecisionAction: 'quarantine', nowSupported: false }), 'manual_review');
});
