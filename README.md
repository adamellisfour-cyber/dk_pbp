# NFL Live Numbers — Vercel Upload

Upload the **contents of this folder** to the top level of a GitHub repository.
Do not upload the ZIP itself.

The GitHub repository homepage must show:

```text
public/
README.md
vercel.json
```

Opening `public/` on GitHub must show:

```text
app.js
browser-api.js
index.html
styles.css
```

In Vercel:

- Framework Preset: `Other`
- Root Directory: leave blank / repository root
- Build Command: leave blank
- Output Directory: `public` (also enforced by `vercel.json`)
- Environment Variables: none

After changing the repository, open the project in Vercel and redeploy the
latest commit.
