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
    files: ["background/**/*.js", "calendar/**/*.js", "content/**/*.js", "options/**/*.js", "popup/**/*.js", "reconcile/**/*.js", "src/**/*.js", "usage/**/*.js"],
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
