// PM2 keeps the relay running and restarts it if it crashes or the server reboots.
module.exports = {
  apps: [{
    name: 'game-relay',
    script: 'src/index.js',
    node_args: '--env-file-if-exists=.env',
    max_memory_restart: '700M',
    kill_timeout: 10000,
  }],
};
