# Haystack Potluck Signup

Shared signup page for the Ceres SDA Church haystack potluck on Sabbath, November 7, 2026.

Live page: https://shwinston.github.io/haystack-potluck-signup/

The page is a single static `index.html` file (GitHub Pages, no build step). Sign-ups are stored by a Cloudflare Worker in `worker/` using D1, so everyone sees the same list. They used to live only in each browser's `localStorage`.

## Change the event or the amounts

In `index.html`:

- `EVENT` is the block at the top (date, time, place, drop-off, serving utensils, contact). Replace each `TODO`. The date and place are already set. Do not invent a time or a contact name.
- `ITEMS` is the menu. Each `amount` is the total for 25 people, including the store hint. Dessert is unchanged (`25 servings`). Item names must stay in sync with `ITEM_NAMES` in `worker/src/index.ts`.
- `API_BASE_URL` is the Worker URL. See below.

Rice is optional and can be claimed more than once. Every other item can be claimed once. A signup stores its own party size. Submitting again with the same name does not change an earlier signup. The headcount adds each signup's party size once, even when that signup covers several items.

Someone can cancel their own signup on the same phone or computer (the page keeps a server-issued token in `localStorage`). The reset code can remove one signup or clear the whole list. The code is checked on the Worker. It is not in this page.

## Deploy the shared list

Full notes, including local testing, are in [worker/README.md](worker/README.md). From a checkout of this repo:

```bash
cd worker
npm install
npx wrangler d1 create haystack-potluck
```

Copy the printed `database_id` into `worker/wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`.

```bash
npx wrangler d1 migrations apply haystack-potluck --remote
```

Create a gitignored file `worker/.prod.secrets` with one line, `RESET_CODE=your-code-here`. Do not commit it. The old code was in `index.html` and remains in git history, so choose a new one if you can. The Worker does not exist yet, so the first deploy has to carry the secret. `wrangler secret put` cannot run before that.

```bash
npx wrangler deploy --secrets-file .prod.secrets
```

Run that from `worker/`. After this Worker exists, change the code with `npx wrangler secret put RESET_CODE`. Local `wrangler dev` reads `.dev.vars` instead, and deploy does not upload that file.

`deploy` does not apply the database schema. The `migrations apply` command above is what creates the tables (`worker/migrations/0001_init.sql`).

Paste the Worker URL (no trailing slash) into `API_BASE_URL` in `index.html`, then commit and push so GitHub Pages picks it up. Search the file for `API_BASE_URL`. It is the only place the page looks for the API. The checked-in value is `http://127.0.0.1:8787` for local `wrangler dev`. A public Pages visit keeps showing "not connected" until that constant is the `https://…workers.dev` URL.

CORS already allows `https://shwinston.github.io`. Nothing else has to be set in the Cloudflare dashboard.

## Run it locally

```bash
cd worker
cp .dev.vars.example .dev.vars
# Put a local RESET_CODE in .dev.vars. That file stays uncommitted.
npm install
npx wrangler d1 migrations apply haystack-potluck --local
npx wrangler dev
```

In another terminal, from the repo root:

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080. The page polls the Worker about every 12 seconds and again when the tab is focused.
