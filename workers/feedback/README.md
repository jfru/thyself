# Feedback Worker

Receives in-app feedback from Thyself and creates GitHub issues. Contact emails are stored privately in Cloudflare KV (not in the public issue).

## Look up a user's email

```bash
cd workers/feedback
npx wrangler kv key get --namespace-id=81e4f2e688cb40e29339a9d316e3bb9d "issue-NUMBER"
```

Replace `NUMBER` with the GitHub issue number. If the user provided an email, it prints it. If not, it prints nothing.

## List all stored emails

```bash
npx wrangler kv key list --namespace-id=81e4f2e688cb40e29339a9d316e3bb9d
```

## Deploy changes

```bash
cd workers/feedback
npx wrangler deploy
```

## Update the GitHub token

If the token expires or you need to rotate it:

```bash
cd workers/feedback
npx wrangler secret put GITHUB_TOKEN
# paste the new token when prompted
```

Create fine-grained PATs at https://github.com/settings/personal-access-tokens/new — only needs "Issues: Read and write" on `jfru/thyself`.

## Auth

If wrangler says you're not authenticated, run `npx wrangler login` first. It opens a browser window to sign in with Cloudflare.
