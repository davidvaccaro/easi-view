import assert from 'node:assert/strict';

const operations = new Set(['login', 'logout', 'dicom-auth', 'worklist', 'open-study', 'save-context',
    'load-context', 'create-share', 'resolve-share', 'revoke-share']);
const statuses = new Set(['success', 'error', 'canceled']);

/** Validate the exact public audit shape before excluding numeric timing from
 * content matching. A measured 2.25 ms is not a DICOM UID. Other fields and the
 * independently observed state remain subject to the full privacy assertion. */
export function assertEnterpriseAuditPrivacy(audits, forbidden, context = {}) {
    assert.ok(Array.isArray(audits));
    const content = audits.map(event => {
        assert.deepEqual(Reflect.ownKeys(event).sort(), ['durationMs', 'operation', 'status']);
        assert.ok(operations.has(event.operation), 'Audits contain only known operation names.');
        assert.ok(statuses.has(event.status), 'Audits contain only known operation statuses.');
        assert.ok(typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0,
            'Audit durations are finite nonnegative numbers.');
        return { operation: event.operation, status: event.status };
    });
    assert.doesNotMatch(JSON.stringify({ audits: content, context }), forbidden);
}
