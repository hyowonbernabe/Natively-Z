// Personal build (Natively Z): retain upstream identity and attribution, bundle
// the license, and never publish artifacts to upstream's release repository.
const base = require('./package.json').build;
module.exports = {
  ...base,
  publish: null,
  extraResources: [...base.extraResources, { from: 'LICENSE', to: 'LICENSE' }],
  nsis: { ...base.nsis, license: 'LICENSE' },
};
