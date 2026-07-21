module.exports = {
  apps: [
    {
      name: 'web-collection-api',
      cwd: __dirname,
      script: 'apps/api/src/index.js',
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
}

