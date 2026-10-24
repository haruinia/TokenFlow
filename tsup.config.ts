import { defineConfig } from 'tsup';
export default defineConfig([
 {
  entry:{main:'apps/desktop/src/main.ts','credential-store':'apps/desktop/src/secrets.ts',headless:'packages/core/src/headless.ts','local-usage-worker':'packages/core/src/local-usage-worker.ts','codex-reconciliation-worker':'packages/core/src/codex-reconciliation-worker.ts'},
  format:['esm'],platform:'node',target:'node22',outDir:'dist',clean:false,removeNodeProtocol:false,
  // Keep SDK/native loaders and Fastify's filesystem-based plugins intact.
  // Everything else is bundled from the actual imports, not shipped as whole npm packages.
  external:['electron','fastify','@fastify/static','@cursor/sdk','@token-flow/codebuddy-runtime'],
  noExternal:[/^(?!(?:electron|fastify|@fastify\/static|@cursor\/sdk|@token-flow\/codebuddy-runtime)(?:\/|$))/],metafile:true,
  // Bundled CommonJS libraries (e.g. YAML) still require Node builtins in ESM.
  banner:{js:"import { createRequire as __tokenflowCreateRequire } from 'node:module'; const require = __tokenflowCreateRequire(import.meta.url);"},
 },
 {entry:{preload:'apps/desktop/src/preload.ts'},format:['cjs'],platform:'node',outDir:'dist',external:['electron']},
 {entry:{'codex-provider-bridge':'packages/core/src/codex-provider-bridge-entry.ts'},format:['esm'],platform:'node',target:'node22',outDir:'dist',splitting:false}
]);
