// The app imports shared TypeScript from ../../packages/shared/src (types, and any zod schema the
// phone also checks). Metro is told about that folder, and anything it imports resolves from this
// app's own node_modules, so the web build's dependency tree is never touched.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.extraNodeModules = { zod: path.resolve(projectRoot, 'node_modules/zod') };

// packages/shared is ESM TypeScript: its relative imports name the compiled file ('./driver.js').
// Metro resolves sources, so inside that folder a relative '.js' specifier is tried as the '.ts'
// file first (the same mapping tsc's NodeNext resolution does).
const sharedSrc = path.join(sharedRoot, 'src');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && path.resolve(context.originModulePath).startsWith(sharedSrc)) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // not a TypeScript source: fall through to the name as written
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
