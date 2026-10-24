/** Boundaries of the independently releasable viewer. AI experiments live on a separate branch. */
export const RELEASE_PROFILE = 'core-no-ai';

export const RELEASE_DOCUMENTS = Object.freeze([
    'AI_BACKLOG.md', 'ANNOTATIONS.md', 'ARCHITECTURE.md', 'ARTIFACTS.md',
    'BROWSER_VALIDATION.md', 'COMPRESSED.md', 'CORPUS_TESTING.md',
    'DERIVED_OBJECTS.md', 'DICOMWEB.md', 'EMBEDDING.md', 'ENTERPRISE.md',
    'INSPECTOR.md', 'LICENSING.md', 'LOCAL_LIBRARY.md', 'OPENING.md', 'STORAGE_SOURCES.md',
    'PERFORMANCE.md', 'PHILIPS_PRIVATE.md', 'PRESENTATION.md', 'PRIOR_STUDIES.md',
    'READING_PROTOCOLS.md', 'RECONSTRUCTION.md', 'RELEASE_PLAN.md', 'RELEASING.md',
    'ROADMAP.md', 'SPECIALTIES.md', 'STATUS.md', 'WORKSPACE.md',
    'easi-view-plan.html', 'feature-catalog.json', 'proposal.json'
]);

/** Inspect actual bundler inputs, including modules whose exports might be tree-shaken. */
export function releaseModules(...metafiles) {
    const inputs = [...new Set(metafiles.flatMap(file => Object.keys(file.inputs)))].sort();
    assertReleaseModules(inputs);
    return inputs.filter(path => path.startsWith('src/'));
}

export function assertReleaseModules(inputs) {
    if (!Array.isArray(inputs) || inputs.some(path => typeof path !== 'string')) {
        throw new Error('The release needs a valid bundled-module inventory.');
    }
    for (const input of inputs) {
        const path = input.replaceAll('\\', '/');
        if (/(?:^|\/)src\/(?:ai\/|integration\/(?:AiAssistIntegration|ViewerWorkflow)\.js$|ui\/Ai[^/]*\.js$)/.test(path)
            || /(?:^|\/)(?:examples\/ai-gateway|infrastructure\/ai-demo)(?:\/|$)/.test(path)) {
            throw new Error(`AI experiment input must not enter the base viewer: ${input}`);
        }
    }
}

/** Inspect public runtime text, rather than banning harmless imported-result provenance such as source: 'ai'. */
export function assertReleaseRuntime(path, text) {
    if (/(?:^|\/)viewer-config\.json$/i.test(path)
        || /(?:^|\/)(?:api\/ai|ai-gateway|ai-demo)(?:\/|$)/i.test(path)) {
        throw new Error(`AI deployment asset must not enter the base viewer: ${path}`);
    }
    if (!/\.(?:js|mjs|css|html|json|ts)$/i.test(path)) return;
    if (/(?:\bopenAiAssist\b|\bcloseAiAssist\b|\bcancelAiAssist\b|\bgetAiState\b|\bgetAiDraft\b|\bAiConfiguration\b|\baichange\b|\bAI Assist\b|\bAI Tasks\b|\/api\/ai(?:\/|["'`\s])|viewer-config\.json|api\.openai\.com|bedrock-runtime\.)/i.test(text)) {
        throw new Error(`AI runtime code or configuration must not enter the base viewer: ${path}`);
    }
}
