// NOTE: ecosystem.config.cjs is for development convenience only.
// For production deployment, use server/hypereels-api.service (systemd unit).
// PM2 does NOT reliably load .env files — use EnvironmentFile in systemd instead.
module.exports = {
  apps: [{
    name: 'hypereels-api',
    script: 'dist/index.js',
    cwd: '/opt/hypereels/server',
    // For production: set env vars via EnvironmentFile in the systemd unit, not here
    // For local dev: env vars are loaded from the shell environment
    exp_backoff_restart_delay: 5000,
    max_restarts: 20,
    restart_delay: 2000,
  }]
};
