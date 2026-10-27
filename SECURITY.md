# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a
vulnerability** / private security advisory feature for this repository. Do not
open a public issue containing exploit details or secrets.

## API keys and local data

Manga PSD Studio is a local browser application. API keys entered in the UI are
stored in the browser's `localStorage`; they are not sent anywhere except the
translation provider selected by the user.

- Do not deploy a public build that contains your own API keys.
- Use restricted keys and monitor provider usage.
- Clear site data to remove stored keys.
- Never commit `.env` files or keys to Git.

## Model downloads

Detection and inpainting weights are downloaded at runtime from third-party
hosts and cached by the browser. Review the licenses and trustworthiness of
those sources before using or redistributing the weights. No model weights are
included in this repository.

## Supported versions

Security fixes are applied to the current `main` branch. There is no separate
long-term support branch.
