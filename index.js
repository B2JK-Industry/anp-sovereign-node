const { app } = require("./backend/src/app");
const { Hunter } = require("./backend/src/services/hunter");
const {
  getAcpManager,
  getAnpManager,
  getHunter
} = require("./backend/src/services/runtime");
const { parseBoolean, toNumber } = require("./backend/src/lib/common");

const HUNTER_OVERRIDE_KEYS = new Set([
  "anpManager",
  "acpManager",
  "sendBidOnMatch",
  "requireHumanConsent",
  "autoCreateJobOnClient",
  "autoFundClientJob",
  "autoSetBudgetAsProvider",
  "autoSubmitProviderWork",
  "idleSleepMs",
  "busySleepMs",
  "errorSleepMs",
  "maxIdleSleepMs"
]);

function createHunter(overrides = {}) {
  const hasHunterOverrides = Object.keys(overrides).some((key) =>
    HUNTER_OVERRIDE_KEYS.has(key)
  );

  if (!hasHunterOverrides) {
    return getHunter();
  }

  return new Hunter({
    anpManager: overrides.anpManager || getAnpManager(),
    acpManager: overrides.acpManager || getAcpManager(),
    sendBidOnMatch: overrides.sendBidOnMatch,
    requireHumanConsent: overrides.requireHumanConsent,
    autoCreateJobOnClient: overrides.autoCreateJobOnClient,
    autoFundClientJob: overrides.autoFundClientJob,
    autoSetBudgetAsProvider: overrides.autoSetBudgetAsProvider,
    autoSubmitProviderWork: overrides.autoSubmitProviderWork,
    idleSleepMs: overrides.idleSleepMs,
    busySleepMs: overrides.busySleepMs,
    errorSleepMs: overrides.errorSleepMs,
    maxIdleSleepMs: overrides.maxIdleSleepMs
  });
}

async function startHttpServer(options = {}) {
  if (options.enableHttp === false) {
    return null;
  }

  const port = toNumber(options.port || process.env.PORT, 3000);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[HTTP] Dashboard listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}

async function startAgentNode(options = {}) {
  const hunter = options.hunter || createHunter(options);
  const enableHttp = parseBoolean(
    options.enableHttp,
    parseBoolean(process.env.ANP_ENABLE_HTTP, true)
  );
  const runOnce = parseBoolean(
    options.runOnce,
    parseBoolean(process.env.ANP_RUN_ONCE, false)
  );
  const server = await startHttpServer({
    enableHttp,
    port: options.port
  });
  const startup = await hunter.start();

  if (runOnce) {
    const summary = await hunter.runCycle();
    return {
      hunter,
      server,
      startup,
      summary
    };
  }

  void hunter.runForever().catch((error) => {
    console.error(`[NODE] Agent lifecycle crashed: ${error.message}`);
    process.exitCode = 1;
  });

  return {
    hunter,
    server,
    startup
  };
}

async function stopAgentNode(system) {
  if (!system) {
    return;
  }

  if (system.hunter) {
    system.hunter.stop();
  }

  if (system.server) {
    await new Promise((resolve, reject) => {
      system.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

module.exports = {
  createHunter,
  startAgentNode,
  startHttpServer,
  stopAgentNode
};

if (require.main === module) {
  let system = null;
  let shuttingDown = false;

  const handleStopSignal = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[NODE] Received ${signal}, shutting down...`);

    try {
      await stopAgentNode(system);
    } catch (error) {
      console.error(`[NODE] Shutdown failed: ${error.message}`);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  process.on("SIGINT", () => {
    void handleStopSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleStopSignal("SIGTERM");
  });

  startAgentNode().then((result) => {
    system = result;

    if (parseBoolean(process.env.ANP_RUN_ONCE, false)) {
      console.log("[NODE] Run-once summary:");
      console.log(JSON.stringify(result.summary, null, 2));
      return stopAgentNode(result);
    }

    return null;
  }).then(() => {
    if (parseBoolean(process.env.ANP_RUN_ONCE, false)) {
      process.exit();
    }
  }).catch((error) => {
    console.error(`[NODE] Startup failed: ${error.message}`);
    process.exit(1);
  });
}
