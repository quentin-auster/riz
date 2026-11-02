// An Express service that asks riz before returning a document.
//
// The caller sends their own token as `Authorization: Bearer <token>`; riz verifies it and
// decides whether that user may read the document. See README.md.
import { Riz, RizApiError, RizValidationError } from "@riz/sdk";
import express from "express";

const riz = new Riz({
  baseUrl: process.env.RIZ_API_URL,
  credentials: process.env.RIZ_WORKLOAD_TOKEN,
  application: process.env.RIZ_APPLICATION,
});

const app = express();

app.get("/documents/:id", async (req, res) => {
  const [scheme, endUserToken] = (req.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !endUserToken) {
    return res.status(401).json({ error: "no user credential" });
  }
  try {
    const { allowed } = await riz.check({
      action: "read",
      resource: `document:${req.params.id}`,
      endUserToken,
    });
    if (!allowed) return res.status(403).json({ error: "denied by riz" });
    return res.json({ id: req.params.id, body: "the document" });
  } catch (err) {
    if (err instanceof RizValidationError) {
      return res.status(404).json({ error: "no such document" });
    }
    if (err instanceof RizApiError && err.code === "invalid_end_user_token") {
      return res.status(401).json({ error: "invalid user credential" });
    }
    // Includes "could not decide": an undecided check is a refusal.
    return res.status(503).json({ error: "authorization unavailable" });
  }
});

app.listen(Number(process.env.PORT ?? 3001));
