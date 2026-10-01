const util = require('util');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Captured at require time, before app.js replaces console.log with a no-op in
// production. Writing through this reference keeps `force` honest: it is the one
// channel that always reaches stdout, which is what PM2 captures into
// logs/out.log. Without it, "force" silently produced nothing in the web
// process, because both this module and app.js suppress console.log in
// production.
const writeToStdout = (...args) => {
  process.stdout.write(`${util.format(...args)}\n`);
};

const logger = {

  log: (...args) => {
    if (!IS_PRODUCTION) {
      console.log(...args);
    }
  },

  info: (...args) => {
    if (!IS_PRODUCTION) {
      console.info(...args);
    }
  },

  debug: (...args) => {
    if (!IS_PRODUCTION) {
      console.debug(...args);
    }
  },

  warn: (...args) => {
    console.warn(...args);
  },

  error: (...args) => {
    console.error(...args);
  },

  // Always reaches the log, in every environment and in both processes.
  force: (...args) => {
    writeToStdout(...args);
  }
};

module.exports = logger;
