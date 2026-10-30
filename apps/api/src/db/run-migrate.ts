import pg from "pg";
import { migrate } from "./migrate.js";

const url = process.env.RIZ_DATABASE_URL;
if (!url) {
  throw new Error("RIZ_DATABASE_URL is required");
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(JSON.stringify({ msg: "migrations applied", applied }));
} finally {
  await client.end();
}
