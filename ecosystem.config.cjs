// PM2 keeps the relay running and restarts it if it crashes or the server reboots.
module.exports = {
  apps: [{
    name: 'game-relay',
    script: 'src/main.js',
    instances: 1,          // one process: each room lives in this process's memory
    exec_mode: 'fork',
    max_memory_restart: '700M',
    kill_timeout: 10000,
  }],
};
