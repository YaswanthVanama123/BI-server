// PM2 process definition for the BI API on the DigitalOcean droplet.
// Used by .github/workflows/deploy.yml: `pm2 start ecosystem.config.js`
// on first deploy and `pm2 reload ecosystem.config.js` on every push to main.
module.exports = {
  apps: [
    {
      name: 'bi-server',
      script: 'src/server.js',
      cwd: '/var/www/bi-backend',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Playwright/chromium (daily RouteStar scheduler) can be memory-heavy.
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
    },
  ],
};
