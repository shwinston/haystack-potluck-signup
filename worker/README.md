# Haystack potluck Worker

This Worker is the shared signup list for the static page in the repo root. GitHub Pages cannot store sign-ups, so the page calls this API. Claims are saved in D1. The reset code is a Worker secret named `RESET_CODE` and is never written into the page or this folder.

Developed with Wrangler 4.157. Run commands from this `worker/` directory.

## One-time setup and deploy

1. Install dependencies:

```bash
cd worker
npm install
```

2. Create the D1 database:

```bash
npx wrangler d1 create haystack-potluck
```

Wrangler prints a `database_id`. Open `wrangler.jsonc` and replace the placeholder `00000000-0000-0000-0000-000000000000` with that id. Leave `database_name` as `haystack-potluck` and `binding` as `DB`.

3. Apply the schema to the remote database. Deploy does not apply migrations.

```bash
npx wrangler d1 migrations apply haystack-potluck --remote
```

Confirm when Wrangler asks. The SQL file is `migrations/0001_init.sql`.

4. Deploy, and set the reset code in the same step. This Worker does not exist yet, and Wrangler will not accept `secret put` until it does. A required secret has to ride along on the first deploy. Create a gitignored file `worker/.prod.secrets` (that name is already in `.gitignore`) containing one line:

```bash
RESET_CODE=your-code-here
```

Use your own code. The old one was committed in `index.html` and is still in git history, so pick a new one if you can. Then:

```bash
npx wrangler deploy --secrets-file .prod.secrets
```

Delete `.prod.secrets` when the deploy finishes if you don't want it sitting on disk. `.dev.vars` is only for local `wrangler dev`. Deploy does not read it.

To change the code later, after the Worker exists:

```bash
npx wrangler secret put RESET_CODE
```

5. The deploy command prints the Worker URL, like `https://haystack-potluck-signup.<account>.workers.dev`.

6. Paste that URL into the page. In the repo root `index.html`, set `API_BASE_URL` (search for that name, near the top of the script) to the Worker URL with no trailing slash. Commit and push so GitHub Pages updates. Until you do, the public page shows that the shared list is not connected.

No dashboard steps are required. CORS already allows `https://shwinston.github.io`.

## Local testing

```bash
cd worker
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set `RESET_CODE` to the code you want to use locally. That file is gitignored.

```bash
npx wrangler d1 migrations apply haystack-potluck --local
npx wrangler dev
```

The API listens on `http://127.0.0.1:8787`. The checked-in page already points `API_BASE_URL` there. From the repo root:

```bash
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080`. Sign-ups you create are shared with every browser tab hitting this Worker.

`npx wrangler dev` uses a local D1 database, not the production one.

With the dev server running, `node scripts/check-api.mjs` checks claims, conflicts, cancel, admin remove, and reset. It reads `RESET_CODE` from `.dev.vars` and does not print it.

## What the API does

- `GET /api/signups` returns every signup (name, party size, items, notes) and a headcount. Cancel tokens are not included.
- `POST /api/signups` claims items. Exclusive items use a unique key inside one D1 batch, which is a single transaction. If two people claim the same item, one gets `201` and the other gets `409` with `error: "just_taken"`. Cooked Rice can be claimed more than once.
- A later signup with the same name inserts a new row. It does not change an earlier row's party size. Several items on one signup count as one party size in the headcount.
- `DELETE /api/signups/:id` with `{ "cancelToken": "..." }` cancels the signup that this device saved in `localStorage`.
- `DELETE /api/signups/:id` with `{ "resetCode": "..." }` removes that one signup. The code is checked against the `RESET_CODE` secret.
- `POST /api/reset` with `{ "resetCode": "..." }` clears the list.
- Names are trimmed. Empty names, party sizes outside 1–99, unknown items, and oversized notes are rejected.
- Writes are rate limited per IP (a whole church on one network still has room to sign up). Reads are not limited, so the page can poll.

Reads and writes start a D1 session with `first-primary`, so a refresh sees the latest claim even if read replication is turned on later.
