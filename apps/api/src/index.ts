import { authenticatorFromEnv } from "./auth/index.js";
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
createApp({ authenticate: authenticatorFromEnv(process.env) }).listen(
  port,
  "0.0.0.0",
  () => {
    console.log(JSON.stringify({ msg: "riz api listening", port }));
  },
);
