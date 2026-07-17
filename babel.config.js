/**
 * Babel config shared by react-native-builder-bob (build) and babel-jest (tests).
 *
 * The library source is plain TypeScript with no React Native runtime imports, so
 * we do not need `@react-native/babel-preset` here — `@babel/preset-env` with the
 * default `modules: 'auto'` lets Bob's per-target callers pick ESM (module target)
 * or CommonJS (commonjs target / Jest) automatically, and `@babel/preset-typescript`
 * strips the types.
 */
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
};
