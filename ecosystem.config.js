/**
 * PM2 process definitions.
 *
 * Instance counts are read from the environment so capacity can be tuned per
 * host without editing this file. The defaults preserve the previous values.
 *
 * Cluster mode for the web app is only safe because shared state (login OTPs,
 * rate-limit counters) now lives in Redis. Reintroducing in-process state would
 * break it: a request handled by one worker would not see state written by
 * another.
 */

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

module.exports = {
  apps: [
    {
      name: "bulk-email-sender",
      script: "app.js",
      instances: toInt(process.env.WEB_INSTANCES, 4),
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "4G",

      // app.js calls process.send('ready') once it is listening, so a reload
      // waits for a working instance before cycling the next one.
      wait_ready: true,
      listen_timeout: 10000,
      // Must exceed the graceful-shutdown drain in app.js (25s backstop).
      kill_timeout: 30000,

      env_file: "./.env",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },

      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      merge_logs: false,
      time: true // timestamp log lines; needed to correlate incidents
    },

    {
      name: "bulk-email-worker",
      script: "workprocess/mailer.js",
      instances: toInt(process.env.WORKER_INSTANCES, 14),
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",

      // emailQueue.close() waits for active jobs, so allow time to finish a
      // send rather than killing mid-delivery.
      kill_timeout: 30000,
      listen_timeout: 20000,
      max_restarts: 20,
      restart_delay: 2000,

      env_file: "./.env",
      env: {
        NODE_ENV: "production",
        WORKER_CONCURRENCY: "50"
      },

      // Previously /dev/null, which discarded all worker output and left no
      // record of what was sent or skipped. Rotate these with pm2-logrotate.
      error_file: "./logs/worker-err.log",
      out_file: "./logs/worker-out.log",
      log_file: "./logs/worker-combined.log",
      merge_logs: false,
      time: true
    }
  ]
};
