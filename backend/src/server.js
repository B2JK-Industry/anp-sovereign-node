const { app } = require("./app");

function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 3000);
  return app.listen(port, () => {
    console.log(`[HTTP] ANP backend listening on http://localhost:${port}`);
  });
}

module.exports = {
  startServer
};

if (require.main === module) {
  startServer();
}
