# Contributing

Thank you for improving Manga PSD Studio.

## License of contributions

By submitting a contribution, you agree that it is your original work (or that
you have the right to submit it) and that it may be distributed under the
project license, **AGPL-3.0-or-later**. Do not contribute code or assets that
cannot be distributed under those terms.

## Preserve upstream notices

This project contains code adapted from Libre Manga Translator, which is
AGPL-3.0-or-later and is itself derived from ComicTL (MIT). Do not remove or
weaken:

- `LICENSE`
- `NOTICE`
- `THIRD_PARTY_NOTICES.md`
- `licenses/` (including the upstream LMT and ComicTL notices)
- copyright or attribution comments in source files

If you add a dependency, font, dictionary, model, or other asset, update
`THIRD_PARTY_NOTICES.md` and add its license text when required.

## Do not commit secrets or copyrighted pages

- Never commit API keys, `.env` files, tokens, or local browser profiles.
- Do not commit manga pages, scans, or other third-party artwork unless you
  have permission and have documented the license.
- Model weights are downloaded at runtime and are intentionally excluded.

## Before opening a pull request

```bash
npm ci
npm run check
npm run build
```

Keep changes focused and describe any user-visible behavior changes in the
pull request. If you deploy a modified version as a network service, remember
that AGPL section 13 requires offering the corresponding source to users.
