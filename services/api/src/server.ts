import { createApp } from "./app.js";
import { migrate, pool } from "./db.js";

const port = Number(process.env.PORT ?? 4000);

async function start() {
  await migrate();
  createApp().listen(port, "0.0.0.0", () => console.info(`NomaanOS API listening on ${port}`));
}

start().catch((error: unknown) => {
  console.error("API startup failed", error);
  void pool.end();
  process.exit(1);
});
