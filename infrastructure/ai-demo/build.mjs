import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { distInventory } from '../../tools/dist-manifest.mjs';
import { DEFAULT_OPENAI_MODEL } from '../../examples/ai-gateway/openai-provider.mjs';
import { DEFAULT_MODEL } from '../../examples/ai-gateway/provider.mjs';
import { isAiModelLabel } from '../../src/ai/protocol.js';

const root = resolve(import.meta.dirname, '../..'), args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const provider = option('--provider') ?? 'bedrock';
const model = option('--model') ?? (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_MODEL);
if (!['bedrock', 'openai'].includes(provider) || !isAiModelLabel(model) || provider === 'bedrock' && model !== DEFAULT_MODEL) throw new Error('Invalid fixed AI demonstration provider/model.');
const output = resolve(option('--output') ?? resolve(root, 'artifacts/ai-demo'));
if (output === root || root.startsWith(`${output}/`)) throw new Error('Use an isolated build output directory.');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(resolve(tmpdir(), 'easi-ai-lambda-'));
try {
    await build({ absWorkingDir: root, entryPoints: ['examples/ai-gateway/lambda.mjs'], outfile: resolve(temporary, 'index.mjs'),
        platform: 'node', format: 'esm', target: 'node22', bundle: true, minify: true, sourcemap: false, legalComments: 'external',
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    await writeFile(resolve(temporary, 'package.json'), '{"type":"module","private":true}\n');
    await promisify(execFile)('zip', ['-X', '-q', resolve(output, 'gateway.zip'), 'index.mjs', 'index.mjs.LEGAL.txt', 'package.json'], { cwd: temporary });
    const bytes = await readFile(resolve(output, 'gateway.zip')), hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(resolve(output, 'gateway-build.json'), JSON.stringify({ sha256: hash, bytes: bytes.length, codeKey: `ai-demo/${hash}/gateway.zip`, provider, model }, null, 2) + '\n');
    if (option('--viewer-dist')) {
        const viewer = resolve(output, 'viewer');
        await rm(viewer, { recursive: true, force: true }); await cp(resolve(option('--viewer-dist')), viewer, { recursive: true });
        await writeFile(resolve(viewer, 'viewer-config.json'), JSON.stringify({ ai: { enabled: true, workflows: provider === 'openai', ...(provider === 'openai' ? { workflowPreferences: { routineCt: 'blended' } } : {}), baseUrl: '/api/ai', signInUrl: '/api/ai/login', credentials: 'same-origin', label: 'EASI demo AI', recipient: provider === 'openai' ? 'OpenAI API' : 'Amazon Bedrock · AWS us-east-1', model } }, null, 2) + '\n');
        const info = JSON.parse(await readFile(resolve(viewer, 'build-info.json'), 'utf8'));
        info.deploymentVariant = 'isolated-ai-demo'; info.files = await distInventory(viewer);
        await writeFile(resolve(viewer, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
    }
    process.stdout.write(`Built isolated AI gateway ZIP (${bytes.length} bytes, SHA256 ${hash}). No secrets are packaged.\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
