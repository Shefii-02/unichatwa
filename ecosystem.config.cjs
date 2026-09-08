// PM2 process definition for the openwa (wa-chat) gateway.
//
// Keeps the gateway running as a supervised daemon so WhatsApp sessions stay
// connected across crashes, terminal closes and machine reboots. Combined with
// AUTO_START_SESSIONS=true in .env, a restart re-launches every previously
// authenticated session from data/ without a new QR scan.
//
// Usage:
//   npm run build:all                      # build gateway + dashboard first
//   pm2 start ecosystem.config.cjs         # start under pm2
//   pm2 save                               # remember it across reboots
//   pm2 startup                            # print the one-time boot-hook command, then run it
//
//   pm2 logs openwa-gateway                # tail logs
//   pm2 restart openwa-gateway             # restart after a rebuild
//   pm2 stop openwa-gateway                # stop
module.exports = {
  apps: [
    {
      name: 'openwa-gateway',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1, // single instance — matches AUTO_START_SESSIONS=true (see docs/13-horizontal-scaling.md)
      exec_mode: 'fork',
      node_args: '--enable-source-maps',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: '30s',
      kill_timeout: 20000, // give sessions time to tear down engines cleanly on stop/restart
      max_memory_restart: '1536M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
