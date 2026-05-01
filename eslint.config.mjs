import globals from "globals";

const browserScriptRules = {
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "no-undef": "error",
  "no-var": "error",
  "prefer-const": "error",
};

export default [
  { ignores: ["node_modules/", "web-ext-artifacts/", "lib/fa-icons.js"] },

  // All extension scripts — classic (non-module) browser scripts
  {
    files: ["background.js", "content/*.js", "lib/*.js", "options.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        browser: "readonly", // WebExtensions API namespace
        module: "readonly", // CommonJS shim used by lib/pure.js
        // Globals provided by lib/pure.js (loaded before background.js)
        PHAB_HOST: "readonly",
        BUGZILLA_HOST: "readonly",
        PHAB_ATTACHMENT_RE: "readonly",
        TREEHERDER_BASE: "readonly",
        HG_TRY_BASE: "readonly",
        PHAB_BASE: "readonly",
        BUGZILLA_BASE: "readonly",
        escapeHostName: "readonly",
        extractDNums: "readonly",
        extractBugNums: "readonly",
        bugRegex: "readonly",
        normSubject: "readonly",
        stripPhabSuffix: "readonly",
        titleMatchesSubjects: "readonly",
        pushComments: "readonly",
        tryWalkCandidates: "readonly",
        extractDStatus: "readonly",
        dRevisionIsAbandoned: "readonly",
        dRevisionIsLanded: "readonly",
        bugIsClosed: "readonly",
        bugIsLanded: "readonly",
        bugIsDuplicate: "readonly",
        bugIsClosedNoLand: "readonly",
        BUG_OPEN_STATUSES: "readonly",
        backoutTargets: "readonly",
        isBackedOut: "readonly",
        subjectsFromPush: "readonly",
        dedupById: "readonly",
        byPushTimestampDesc: "readonly",
        treeherderJobsUrl: "readonly",
        treeherderPushByRevUrl: "readonly",
        treeherderHealthUrl: "readonly",
        treeherderRecentUrl: "readonly",
        treeherderAuthorHistoryUrl: "readonly",
        hgRevUrl: "readonly",
        phabRevUrl: "readonly",
        bugAttachmentsUrl: "readonly",
        pushCacheKey: "readonly",
        historyCacheKey: "readonly",
        FetchErrorTracker: "readonly",
        safely: "readonly",
        MIN_TITLE_MATCH_LEN: "readonly",
        // Globals provided by lib/fa-icons.js (auto-generated)
        FA_ICONS: "readonly",
      },
    },
    rules: browserScriptRules,
  },

  // Site scripts consume globals injected by panel-controller.js
  {
    files: ["content/phabricator.js", "content/bugzilla.js"],
    languageOptions: {
      globals: {
        initTryPanel: "readonly",
        onDOMReady: "readonly",
      },
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
