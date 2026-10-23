#!/usr/bin/env node
import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Copy the complete, locally served distribution without rewriting module URLs. */
export async function copyViewerAssets(destination) {
    if (typeof destination !== 'string' || !destination.trim()) throw new TypeError('Choose a new directory for the EASI View assets.');
    const target = resolve(destination);
    try { await stat(target); throw new Error('The destination already exists. Choose a new directory, then update your application asset path.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const source = resolve(import.meta.dirname, '../dist');
    await stat(resolve(source, 'assets/easi-view.js'));
    await stat(resolve(source, 'assets/decode-worker.js'));
    await stat(resolve(source, 'assets/dicom-codecs.wasm'));
    await mkdir(dirname(target), { recursive: true });
    const temporary = await mkdtemp(resolve(dirname(target), `.${basename(target)}-easi-`));
    try { await cp(source, temporary, { recursive: true, dereference: false }); await rename(temporary, target); }
    finally { await rm(temporary, { recursive: true, force: true }); }
    return target;
}
// Node resolves an ESM entry point through symlinks and directory aliases, while
// argv retains the invoked path (including npm's node_modules/.bin symlink).
const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
    if (process.argv.length !== 3) throw new Error('Usage: easi-view-copy-assets <new-public-directory>');
    console.log(`Copied EASI View assets and license notices to ${await copyViewerAssets(process.argv[2])}`);
}
