# NFL Live Numbers — Vercel Edition

This is the browser-only edition of NFL Live Numbers. It keeps the same live
game screens and connects directly to ESPN Fastcast, with ESPN Core polling as
an automatic fallback. There is no Python server and no saved database history.

## Deploy from GitHub

1. Create an empty GitHub repository.
2. Upload the **contents of this folder** to the repository root.
3. In Vercel, choose **Add New → Project** and import that repository.
4. Leave Framework Preset as **Other** and click **Deploy**.
5. Share the generated `https://...vercel.app` address.

No environment variables, build command, paid service, or running laptop are
required. Each viewer receives ESPN data directly in their own browser.

## Local preview

Static files must be served over HTTP rather than opened with `file://`.
Any static web server works, for example:

```text
npx serve .
```

## Important behavior

- Game and latency data last for the current browser session only.
- `MARK PLAY NOW` and CSV export continue to work during that session.
- The app reconnects Fastcast automatically and continues half-second Core
  checks while a game is selected.
- ESPN's public site feeds are not a documented developer API and could change.
