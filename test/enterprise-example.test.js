import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnterpriseServices } from '../examples/gateway/client.js';

test('host wiring performs no implicit operation and exercises separate archive/workflow/share HTTP contracts', async () => {
    const originalFetch = globalThis.fetch, calls = [], audits = [];
    const identity = { subject: 'synthetic-user', realm: 'synthetic-host', expiresAt: Date.now() + 60000 };
    const reference = { archiveKey: 'primary', studyUid: '2.25.800' };
    const context = { version: 1, layout: 1, activeViewport: 0, viewports: [{ slot: 0, reference, frameIndex: 0 }] };
    const receipt = { shareId: 'synthetic-share', capability: 'synthetic-private-receipt' };
    let revoked = false, expiresAt, operations = 0, archiveHeaders = 0, hostHeaders = 0;
    const services = createEnterpriseServices({
        archiveBaseUrl: 'https://gateway.invalid/dicom-web', workflowBaseUrl: 'https://host.invalid/api', viewerOrigin: 'https://viewer.invalid',
        identityAdapter: { async login() { operations++; return identity; }, async logout() { operations++; }, async current() { operations++; return identity; },
            async getHeaders() { archiveHeaders++; return { Authorization: 'synthetic-archive-header' }; } },
        workflowHeaders: async () => { hostHeaders++; return { Authorization: 'synthetic-host-header' }; }, audit: value => audits.push(value)
    });
    assert.equal(operations, 0); assert.equal(archiveHeaders, 0); assert.equal(hostHeaders, 0);
    globalThis.fetch = async (url, options) => {
        url = String(url);
        calls.push({ url, options }); const path = new URL(url).pathname;
        if (url.startsWith('https://gateway.invalid')) return new Response(JSON.stringify([{ '0020000D': { vr: 'UI', Value: [reference.studyUid] } }]), { headers: { 'content-type': 'application/dicom+json' } });
        let value;
        if (path.endsWith('/worklist')) value = { items: [{ key: 'case-1', title: 'Generated case', reference }], nextOffset: null };
        else if (path.endsWith('/study-context') || path.includes('/contexts/')) value = context;
        else if (path.endsWith('/shares')) { expiresAt = Date.now() + JSON.parse(options.body).ttlMs; value = receipt; }
        else if (path.endsWith('/shares/verify')) value = { ...identity, origin: 'https://viewer.invalid', expiresAt, shareId: receipt.shareId, reference, revoked, permissions: ['view'] };
        else if (options.method === 'DELETE') { revoked = true; value = receipt; }
        else throw new Error('Unexpected synthetic route.');
        return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    };
    try {
        await services.session.login();
        assert.equal((await services.client.searchStudies({}, { limit: 1 })).items.length, 1);
        assert.equal((await services.workflow.listWorklist()).items[0].reference.studyUid, reference.studyUid);
        assert.deepEqual(await services.workflow.openStudy(reference), context);
        await services.workflow.saveContext('case-1', context); assert.deepEqual(await services.workflow.restoreContext('case-1'), context);
        const issued = await services.shares.create(reference, { ttlMs: 1000 });
        assert.deepEqual((await services.shares.resolve(receipt)).reference, reference); await services.shares.revoke(issued.shareId);
        assert.equal(archiveHeaders, 1); assert.equal(hostHeaders, 9);
        assert.ok(calls.every(({ options }) => options.credentials === 'omit' && options.redirect === 'error'));
        assert.ok(!/synthetic|2\.25|https:|receipt|reference/.test(JSON.stringify(audits)));
        assert.equal(services.shares.getState().activeShareCount, 0);
    } finally { globalThis.fetch = originalFetch; services.dispose(); }
    assert.equal(services.session.getState().disposed, true);
});

test('host wiring requires a deliberate independent workflow header provider', () => {
    assert.throws(() => createEnterpriseServices({}), /separate host API header provider/);
});
