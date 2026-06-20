// ecosystem.config.js — PM2 config for VPS deployment
module.exports = {
  apps: [
    {
      name: 'tradepulse-api',
      script: 'src/server.js',
      cwd: '/var/www/tradepulse/backend',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      env_file: '/var/www/tradepulse/backend/.env',
      max_memory_restart: '512M',
      error_file: '/var/log/tradepulse/error.log',
      out_file: '/var/log/tradepulse/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
