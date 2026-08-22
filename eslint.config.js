import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "web-ext-artifacts/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["extension/background/**/*.js", "extension/calendar/**/*.js", "extension/content/**/*.js", "extension/options/**/*.js", "extension/popup/**/*.js", "extension/reconcile/**/*.js", "extension/src/**/*.js", "extension/usage/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions
      }
    }
  },
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        indexedDB: "readonly",
        IDBKeyRange: "readonly"
      }
    }
  }
];
