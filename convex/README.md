# Convex Feed Identity & Multi-Device Auth

This directory contains the Convex backend for PrairieRun multi-device feed identity.

## Architecture

- **Account Layer**: Convex Auth with Google OAuth (`@convex-dev/auth`).
- **Data Model**:
  - `authTables`: Users, sessions, accounts, verifiers.
  - `feeds`: Stores `{ userId, feedId, createdAt }` with `by_user` and `by_feedId` indexes.
- **Relay Publication**: The existing Vercel relay (`/relay`) continues to store and publish ICS blobs.
- **Security & Key Derivation**:
  - The master `PUBLISH_KEY` is shared between Convex and the Vercel relay via server-side environment variables.
  - The per-feed HMAC publish key is derived server-side on demand: `HMAC-SHA256(PUBLISH_KEY, feedId)`.
  - The master key and derived keys are **never** stored in the database.
  - `linkLegacyFeed` requires a valid HMAC signature matching the legacy feed ID before attaching it to a user's account.

## Setup Instructions for Project Owner

### 1. Initialize & Link Convex Project

```bash
npx convex dev
# or
npx convex deploy
```

### 2. Configure Environment Variables in Convex

Set the required environment variables in the Convex dashboard or via CLI:

```bash
# Must match PUBLISH_KEY set on the Vercel relay deploy
npx convex env set PUBLISH_KEY <your-relay-publish-key>

# Google OAuth Credentials for Convex Auth
npx convex env set AUTH_GOOGLE_ID <your-google-oauth-client-id>
npx convex env set AUTH_GOOGLE_SECRET <your-google-oauth-client-secret>

# Site URL for your Convex deployment
npx convex env set SITE_URL https://moonlit-mink-208.convex.site
```

Production deployment (team `neel-kumar`, project `prairierun-feed`):
- Cloud: `https://moonlit-mink-208.convex.cloud`
- Site: `https://moonlit-mink-208.convex.site`
- Dashboard: `https://dashboard.convex.dev/t/neel-kumar/prairierun-feed/moonlit-mink-208`

Dev deployment: `https://decisive-perch-472.convex.site`

### 3. Google Cloud Console OAuth Configuration

1. In the Google Cloud Console, navigate to **APIs & Services > Credentials**.
2. Under your OAuth 2.0 Web Application Client, add the following to **Authorized redirect URIs**:
   - `https://moonlit-mink-208.convex.site/api/auth/callback/google`
3. Convex Auth will handle the Google OAuth handshake and redirect back to the extension via `PrairieRunExt.identityLaunchWebAuthFlow` (format: `https://<extension-id>.chromiumapp.org/convex`).

### 4. Vercel Relay Alignment

Ensure the Vercel relay has the identical `PUBLISH_KEY`:
```bash
# In relay/ directory:
vercel env add PUBLISH_KEY
```
When both environments share the same secret, per-feed HMAC keys derived by Convex are recognized by the relay's `/api/publish` endpoint.
