// Vitest configuration. Coverage is scoped to lib/ — that's the only
// code that's pure and unit-testable today; background.js and the
// content/ scripts depend on browser globals and live integration.
export default {
  test: {
    coverage: {
      provider: "v8",
      include: ["lib/**/*.js"],
      // fa-icons.js is auto-generated path-data; icons.js touches the DOM
      // (window/document), so neither runs in vitest's Node env.
      exclude: ["lib/fa-icons.js", "lib/icons.js"],
      reporter: ["text", "html", "lcov"],
    },
  },
};
