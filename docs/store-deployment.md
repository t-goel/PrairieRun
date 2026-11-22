# PrairieRun Store Deployment & Release Guide

This guide details how to build release packages for PrairieRun, deploy the Vercel landing page and privacy policy, and submit to the **Chrome Web Store** and **Mozilla Add-on Hub (AMO)**.

---

## 1. Automated Release Packaging

PrairieRun includes a zero-dependency packaging tool (`scripts/package-extensions.js`):

```bash
# Run tests and build all distribution archives:
npm test
npm run package
```

This builds ready-to-upload zip archives in the `dist/` directory:
- `dist/prairierun-chrome.zip` (and versioned `dist/prairierun-chrome-v<version>.zip`)
- `dist/prairierun-firefox.zip` (and versioned `dist/prairierun-firefox-v<version>.zip`)

### Automated GitHub Releases
Pushing a version tag (e.g., `git tag v0.1.0 && git push origin v0.1.0`) triggers `.github/workflows/release.yml`. GitHub Actions runs the test suite, builds the Chrome and Firefox zip packages, and creates a GitHub Release with the attached zip files.

---

## 2. Deploying the Landing Page & Privacy Policy (Vercel)

Both Chrome Web Store and Mozilla Add-ons **strictly require a publicly accessible Privacy Policy URL** before an extension can be published.

PrairieRun's landing page and policies live under `relay/public/` and deploy to the official Vercel domain:
`https://prairierun-feed.vercel.app`

### Available Endpoints
- **Landing Page**: `https://prairierun-feed.vercel.app/`
- **Privacy Policy**: `https://prairierun-feed.vercel.app/privacy`
- **About Page**: `https://prairierun-feed.vercel.app/about`
- **Terms of Service**: `https://prairierun-feed.vercel.app/terms`
- **Feed API**: `/api/claim` and `/api/publish`

### How to Deploy Updates
```bash
cd relay
vercel --prod
```
*(If the repository is connected to Vercel via GitHub integration, merging changes to the default branch will auto-deploy.)*

---

## 3. Chrome Web Store Submission

1. **Dashboard**: Navigate to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. **Upload Package**: Click **New Item** and upload `dist/prairierun-chrome.zip`.
3. **Store Listing Details**:
   - **Name**: `PrairieRun`
   - **Summary**: `Automated calendar synchronization and assignment digest across PrairieLearn, Canvas, Gradescope, and PrairieTest.`
   - **Description**: Highlight multi-source scanning, local-first storage, 1-click iCal feeds, and direct course links.
   - **Privacy Policy URL**: `https://prairierun-feed.vercel.app/privacy`
4. **Privacy & Permissions Disclosure**:
   - **Single Purpose**: `Academic deadline aggregation and calendar synchronization for university students.`
   - **Permission Justifications**:
     - `storage`: Store parsed deadlines, course codes, and keyword filters locally on user's device.
     - `alarms`: Schedule periodic background checks for deadline updates.
     - `identity`: Support optional Google Calendar OAuth 2.0 connection.
     - `host_permissions` (`https://us.prairielearn.com/*`, `https://canvas.illinois.edu/*`, etc.): Extract enrolled course assignment dates using user's existing active session.
   - **Data Usage Certification**: Certify that user data is not sold, transferred to data brokers, or used for creditworthiness/lending.

---

## 4. Mozilla Add-ons (Firefox AMO) Submission

1. **Dashboard**: Navigate to the [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution).
2. **Distribution**: Choose **On this site** (listed on AMO) or **On your own** (unlisted, self-distributed).
3. **Upload Package**: Upload `dist/prairierun-firefox.zip`.
   - The Firefox package includes the pre-generated `manifest.json` configured with `browser_specific_settings.gecko` and `scripts` array background support for Firefox 115+ ESR.
4. **Listing Details**:
   - Provide the Privacy Policy link: `https://prairierun-feed.vercel.app/privacy`
   - Provide support / GitHub link.
