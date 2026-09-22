export const configuredAddon = (token = 'GroupToken') => ({
  transportUrl: `https://addon.example.invalid/${token}/manifest.json?quality=4K,1080p|HDR`,
  manifest: {
    id: 'same.addon',
    name: 'Original',
    version: '1.0.0',
    description: 'Saved description',
    catalogs: [
      {
        id: 'movies',
        type: 'movie',
        extra: [
          { name: 'search', isRequired: false, options: ['first', 'second'], optionsLimit: 5 },
        ],
      },
    ],
    resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }],
    behaviorHints: { configurable: true, extension: 'preserved' },
    extension: { nested: ['preserved'] },
  },
  flags: { enabled: false, protected: true, official: false },
  metadata: {
    customName: 'Custom',
    customLogo: 'https://logo.invalid/image.png',
    customDescription: 'Customized',
    cinemetaConfig: {
      removeSearchArtifacts: true,
      removeStandardCatalogs: false,
      removeMetaResource: true,
    },
  },
  catalogOverrides: { removed: ['movies'] },
  syncToLibrary: false,
})
