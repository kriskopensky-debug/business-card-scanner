# Business Card Scanner

Scan a business card with your phone camera → Claude reads it → review/edit the fields →
save it to a **Business Card Scanner** folder in your own Google Drive → tap **Add to iPhone
Contacts** to hand it to iOS as a one-tap vCard.

No login system, no custom database: your cards live in your Google Drive as a JSON index
file plus the original photos, so they follow you to any device where you open the site and
sign in with your Google account.

> **Note on "adding to contacts":** no website can silently write into the iOS Contacts app —
> Apple doesn't expose that to Safari. What this app does instead is generate a standard vCard
> (`.vcf`) and open it, which makes iOS show its native "Add Contact" screen pre-filled. That's
> one tap to confirm, instead of typing the card in by hand.

## One-time setup

### 1. Netlify environment variable (for OCR)

The `/netlify/functions/ocr.js` function calls Claude's vision API to read the card. It needs
your own Anthropic API key, kept server-side (never shipped to the browser):

1. Get a key from the [Anthropic Console](https://console.anthropic.com/) (Settings → API Keys).
2. In your Netlify site: **Site configuration → Environment variables → Add a variable**
   - Key: `ANTHROPIC_API_KEY`
   - Value: your key
3. (Optional) Add `CLAUDE_MODEL` to override the default (`claude-haiku-5-5`) — e.g. set it to
   `claude-sonnet-5-5` if you want more accurate reads on messy/stylized cards, at a higher
   per-scan cost.
4. Redeploy the site after adding env vars (Netlify only injects them into new builds/function
   deploys).

### 2. Google OAuth Client ID (for Drive storage)

This app talks to Google Drive directly from the browser using your own Google account — it
only ever touches files it creates itself (the `drive.file` scope), never your whole Drive.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or reuse one you already have).
3. **APIs & Services → Library** → enable the **Google Drive API**.
4. **APIs & Services → OAuth consent screen**:
   - User type: External is fine. Publishing status: leave it in **Testing**.
   - Add yourself (your Gmail address) under **Test users** — this avoids Google's app
     verification process entirely, since you're the only person using it.
   - Scopes: you don't need to add `drive.file` here explicitly; it's a non-sensitive scope.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: add your live Netlify URL, e.g.
     `https://your-site.netlify.app`, and `http://localhost:8888` if you'll test locally with
     `netlify dev`.
   - No redirect URI is needed.
6. Copy the generated **Client ID** (looks like `xxxxx.apps.googleusercontent.com`).
7. Open the deployed site — it'll prompt you once for this Client ID and store it in your
   browser's local storage (not in Netlify, not in the repo — it's not a secret, but keeping it
   out of the code means you never have to redeploy if you regenerate it).

### 3. Deploy

Same flow as your other git-connected Netlify site:

```bash
git init
git add .
git commit -m "Business card scanner"
```

Push to a new GitHub repo, then connect it in Netlify (**Add new site → Import an existing
project**). Build command: none needed. Publish directory: `.` (already set in
`netlify.toml`, along with the functions directory).

## Using it

1. Open the site on your iPhone, tap **Connect Google Drive**, sign in, approve access.
2. Tap **Take / choose photo**, snap the card, tap **Read this card**.
3. Check/edit the extracted fields.
4. **Save to Drive** to keep it in your card library, and/or **Add to iPhone Contacts** to get
   the native "Add Contact" screen.
5. Saved cards show up in the list below, searchable by name/company/email; each has its own
   **Add to iPhone** and **Delete** buttons.

## Notes / limitations

- Google's OAuth access token lasts about an hour per session; if it expires mid-use you'll be
  asked to reconnect with one tap.
- Safari sometimes blocks third-party storage used for *silent* token refresh — this app
  always falls back to a one-tap reconnect rather than relying on that.
- Photos are resized client-side (max 1600px, JPEG ~85% quality) before OCR and before
  uploading to Drive, to keep requests small and cheap.
