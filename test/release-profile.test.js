import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_PROFILE, RELEASE_DOCUMENTS, releaseModules, assertReleaseModules, assertReleaseRuntime } from '../tools/release-profile.mjs';

test('base release inventory uses actual bundler inputs and rejects disabled or tree-shaken AI modules', () => {
    assert.equal(RELEASE_PROFILE, 'core-no-ai');
    assert.deepEqual(releaseModules(
        {inputs: {'src/main.js': {}, 'src/data/DicomSource.js': {}, 'node_modules/@xinonix/easi-js/src/EASI.js': {}}},
        {inputs: {'src/integration/viewer.js': {}, 'src/data/DicomSource.js': {}}}
    ), ['src/data/DicomSource.js', 'src/integration/viewer.js', 'src/main.js']);
    for (const path of [
        'src/ai/AiClient.js', '/tmp/viewer/src/ai/unused.js', 'src/integration/AiAssistIntegration.js',
        'src/integration/ViewerWorkflow.js', 'src/ui/AiWorkflowPanel.js', 'examples/ai-gateway/gateway.mjs',
        'infrastructure/ai-demo/build.mjs', 'C:\\viewer\\src\\ai\\AiClient.js'
    ]) assert.throws(() => releaseModules({inputs: {[path]: {}}}), /AI experiment input/);
    for (const value of [null, 'src/main.js', [null]]) assert.throws(() => assertReleaseModules(value), /valid bundled-module inventory/);
});

test('base runtime rejects AI endpoints, controls, public API and startup profile loading', () => {
    for (const text of [
        'fetch("viewer-config.json")', 'fetch("/api/ai/plan")', 'openAiAssist() {}',
        'interface AiConfiguration {}', '"aichange"', 'AI Assist (Preview)',
        'https://api.openai.com/v1/responses', 'https://bedrock-runtime.us-east-1.amazonaws.com'
    ]) assert.throws(() => assertReleaseRuntime('assets/app.js', text), /AI runtime code or configuration/);
    for (const path of ['viewer-config.json', 'nested/viewer-config.json', 'api/ai/plan.js', 'ai-gateway/index.js']) {
        assert.throws(() => assertReleaseRuntime(path, '{}'), /AI deployment asset/);
    }
});

test('ordinary DICOM derived results and historical backlog are distinct from AI execution', () => {
    assert.doesNotThrow(() => assertReleaseModules(['src/derived/OverlayStore.js', 'src/catalog/workflow-metadata.js']));
    assert.doesNotThrow(() => assertReleaseRuntime('assets/easi-view.js', 'export function addOverlay(input) { return {source: "ai", ...input}; }'));
    assert.equal(RELEASE_DOCUMENTS.includes('AI_BACKLOG.md'), true);
    assert.equal(RELEASE_DOCUMENTS.includes('AI_ASSIST.md'), false);
    assert.equal(RELEASE_DOCUMENTS.includes('AI_WORKFLOWS.md'), false);
    for (const name of ['EMBEDDING.md', 'OPENING.md', 'DERIVED_OBJECTS.md', 'RELEASE_PLAN.md', 'RELEASING.md']) {
        assert.equal(RELEASE_DOCUMENTS.includes(name), true);
    }
});
