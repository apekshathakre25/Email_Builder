const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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

  force: (...args) => {
    console.log(...args);
  }
};

module.exports = logger;
