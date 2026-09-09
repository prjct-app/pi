// Direct file import so Pi's extension loader (jiti) does not mis-resolve the
// typebox/schema export subpath to index.mjs/schema.
export { default } from '../node_modules/typebox/build/schema/index.mjs';
