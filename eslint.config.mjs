import globals from "globals";

export default [
  { ignores: ["node_modules/", "web-ext-artifacts/"] },

  // All extension scripts — classic (non-module) browser scripts
  {
    files: ["background.js", "content/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        browser: "readonly",   // WebExtensions API namespace
      },
    },
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern:       "^_",
        varsIgnorePattern:       "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "no-undef":       "error",
      "no-var":         "error",
      "prefer-const":   "error",
    },
  },

  // Site scripts consume globals injected by panel-controller.js
  {
    files: ["content/phabricator.js", "content/bugzilla.js"],
    languageOptions: {
      globals: {
        initTryPanel: "readonly",
        onDOMReady:   "readonly",
      },
    },
  },

  // Extension options page — classic script, browser + WebExtensions environment
  {
    files: ["options.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        browser: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // Dev/tooling scripts — ES modules, Node.js environment
  {
    files: ["*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },
];
