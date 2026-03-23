const path = require("node:path");

const express = require("express");

const { router: apiRouter } = require("./routes/api");
const { FRONTEND_ROOT } = require("./services/runtime");

const app = express();
const frontendIndexPath = path.join(FRONTEND_ROOT, "index.html");

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/api", apiRouter);
app.use(express.static(FRONTEND_ROOT));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) {
    next();
    return;
  }

  res.sendFile(frontendIndexPath);
});
app.use((error, req, res, next) => {
  const status = error.status || 500;
  console.error(`[HTTP] ${status} ${error.message}`);

  res.status(status).json({
    ok: false,
    error: error.message
  });
});

module.exports = {
  app
};
