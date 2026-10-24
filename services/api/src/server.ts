import { createApp } from "./app.js";
import { migrate, pool } from "./db.js";
import { startWebhookWorker } from "./webhook-worker.js";
import { startInboundEmailWorker } from "./inbound-email-worker.js";
import { startComplaintAnalysisWorker } from "./complaint-analysis-worker.js";

const port = Number(process.env.PORT ?? 4000);

async function start() {
  await migrate();
  const app = createApp();
  const server = app.listen(port, "0.0.0.0", () => {
    const stopWebhookWorker = startWebhookWorker();
    const stopInboundEmailWorker = startInboundEmailWorker();
    const stopAnalysisWorker = startComplaintAnalysisWorker();
    console.info(`NomaanOS API listening on ${port}`);

    const gracefulShutdown = () => {
      console.info("Shutting down API server and background workers...");
      stopWebhookWorker();
      stopInboundEmailWorker();
      stopAnalysisWorker();
      server.close(() => {
        void pool.end();
        console.info("API server closed gracefully.");
      });
    };

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
  });
}

start().catch((error: unknown) => {
  console.error("API startup failed", error);
  void pool.end();
  process.exit(1);
});
