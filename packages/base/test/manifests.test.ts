import { describe, expect, it } from 'vitest';
import {
  createBaseExtensionManifests,
  createBaseManifestSet,
  createBaseToolManifests,
} from '../src/manifests/index.js';

describe('manifest helpers', () => {
  it('creates base tool/extension manifests', () => {
    const tools = createBaseToolManifests();
    const extensions = createBaseExtensionManifests();

    expect(tools.length).toBe(6);
    expect(extensions.length).toBe(6);

    expect(tools.every((item) => item.kind === 'Tool')).toBe(true);
    expect(extensions.every((item) => item.kind === 'Extension')).toBe(true);
    expect(tools.some((item) => item.metadata.name === 'wait')).toBe(true);
    expect(extensions.some((item) => item.metadata.name === 'message-compaction')).toBe(true);
    expect(extensions.some((item) => item.metadata.name === 'message-window')).toBe(true);
    expect(extensions.some((item) => item.metadata.name === 'context-message')).toBe(true);

    const extensionNames = extensions.map((item) => item.metadata.name);
    const extensionEntries = extensions.map((item) => item.spec.entry);
    expect(new Set(extensionNames).size).toBe(extensionNames.length);
    expect(new Set(extensionEntries).size).toBe(extensionEntries.length);

    const contextMessage = extensions.find(
      (item) => item.metadata.name === 'context-message'
    );
    expect(contextMessage?.spec.entry).toBe('./src/extensions/context-message.ts');
    expect(contextMessage?.spec.config?.includeAgentPrompt).toBe(true);
    expect(contextMessage?.spec.config?.includeRouteSummary).toBe(false);
  });

  it('creates aggregate manifest set', () => {
    const manifests = createBaseManifestSet();
    expect(manifests.length).toBe(12);

    const manifestIdentities = manifests.map((item) => `${item.kind}/${item.metadata.name}`);
    expect(new Set(manifestIdentities).size).toBe(manifestIdentities.length);
  });
});
