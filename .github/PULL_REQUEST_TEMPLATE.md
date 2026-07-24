## What does this change, and why?

<!-- Focus on the "why" — the reasoning, the bug it fixes, the constraint it
     works around. The diff already shows the "what". -->

## How was this verified?

<!-- Ideally: tested against a real Crowdin project. If that's not practical,
     say so and explain what you checked instead (type-check, manual review,
     etc.). -->

## Checklist

- [ ] This is one logical change (not several unrelated fixes bundled together)
- [ ] Frontend type-checks (`npm run build` in `frontend/`) if frontend code changed
- [ ] Any `schema.sql` change includes a migration safe to run against an existing local cache
- [ ] No token/credential ever logged, returned in a response, or written to a file
