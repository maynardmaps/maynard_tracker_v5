import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

async function main() {
  const clientPath = process.argv[2];
  if (!clientPath) throw new Error("Usage: node tools/gmail-oauth-setup.js <installed-oauth-client.json>");

  const clientDocument = JSON.parse(await readFile(clientPath, "utf8"));
  const client = clientDocument.installed;
  if (!client || !client.client_id || !client.client_secret || !client.auth_uri || !client.token_uri) {
    throw new Error("OAuth JSON must be a Google Desktop app (installed) client configuration");
  }

  const state = randomBytes(32).toString("hex");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizationUrl = new URL(client.auth_uri);
  authorizationUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state
  });

  console.log("Open this URL in the Google account whose inbox should be polled:");
  console.log(authorizationUrl.toString());
  console.log("Waiting for the local OAuth callback...");

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Google authorization"));
    }, 5 * 60 * 1000);
    server.on("request", (request, response) => {
      const callback = new URL(request.url, redirectUri);
      if (callback.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const receivedState = Buffer.from(callback.searchParams.get("state") || "");
      const expectedState = Buffer.from(state);
      if (receivedState.length !== expectedState.length || !timingSafeEqual(receivedState, expectedState)) {
        response.writeHead(400).end("OAuth state validation failed. You can close this window.");
        clearTimeout(timer);
        server.close();
        reject(new Error("OAuth state validation failed"));
        return;
      }
      const oauthError = callback.searchParams.get("error");
      const authorizationCode = callback.searchParams.get("code");
      if (oauthError || !authorizationCode) {
        response.writeHead(400).end("Google authorization failed. You can close this window.");
        clearTimeout(timer);
        server.close();
        reject(new Error(`Google authorization failed: ${oauthError || "no authorization code returned"}`));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Gmail authorization complete. You can close this window.");
      clearTimeout(timer);
      server.close();
      resolve(authorizationCode);
    });
  });

  const tokenResponse = await fetch(client.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(`Google token exchange failed (HTTP ${tokenResponse.status}): ${token.error_description || token.error || "unknown error"}`);
  if (!token.refresh_token) {
    throw new Error("Google did not return a refresh token; rerun the tool and approve the requested access");
  }

  console.log("\nSet these as Cloudflare Worker secrets using `wrangler secret put <NAME>`.");
  console.log("Enter each value only at Wrangler's interactive prompt; do not put it in a command argument.");
  console.log(`GMAIL_CLIENT_ID=${client.client_id}`);
  console.log(`GMAIL_CLIENT_SECRET=${client.client_secret}`);
  console.log(`GMAIL_REFRESH_TOKEN=${token.refresh_token}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
