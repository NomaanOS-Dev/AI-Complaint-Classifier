import cors from "cors";
import express from "express";
import { databaseIsReady, migrate } from "./db.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_request, response) => {
  try {
    await databaseIsReady();
    response.json({ status: "ok", service: "api", database: "ok" });
  } catch {
    response.status(503).json({ status: "error", service: "api", database: "unavailable" });
  }
});

async function start() {
  await migrate();
  app.listen(port, "0.0.0.0", () => console.info(`NomaanOS API listening on ${port}`));
}

start().catch((error: unknown) => {
  console.error("API startup failed", error);
  process.exit(1);
});
