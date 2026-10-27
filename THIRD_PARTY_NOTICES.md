# Third-Party Notices

Manga PSD Studio is licensed under **AGPL-3.0-or-later**. See `LICENSE`,
`NOTICE`, and the files under `licenses/`.

## Upstream source code

This project is a modified/adapted work. Parts of the detection, inpainting,
canvas, and pipeline code were adapted in 2026 from **Libre Manga Translator**,
which is licensed under **AGPL-3.0-or-later**:

- Upstream: <https://github.com/mrdhnto/libre-manga-translator>
- Copyright (C) 2026 Libre Manga Translator
- Full upstream license and attributions:
  `licenses/LibreMangaTranslator-LICENSE.txt`
- The upstream project's model, font, technique, and dependency credits are
  preserved there.

Libre Manga Translator is itself a derivative of **ComicTL**, MIT licensed:

- Upstream: <https://github.com/kiuyha/ComicTL>
- Copyright (c) 2025-2026 Ketut Shridhara
- MIT notice preserved in `licenses/ComicTL-MIT.txt` and in the upstream
  license file. As permitted by MIT, the combined work is conveyed under
  AGPL-3.0-or-later.

The app is an independent standalone project; it does not modify or bundle the
upstream browser extension.

## Bundled assets

### PaddleOCR PP-OCRv6 dictionary

`public/dicts/ppocrv6_dict.txt` is a character dictionary derived from
PaddleOCR's PP-OCRv6 stock dictionary, with space and blank entries added for
the browser pipeline.

- PaddleOCR: <https://github.com/PaddlePaddle/PaddleOCR>
- Copyright (c) PaddlePaddle Authors
- Apache License 2.0; full text in `licenses/Apache-2.0.txt`

### Sample page

`samples/sample-page.png` is a synthetic test image created for this project,
not a third-party manga page. It is dedicated to CC0 1.0 Universal; see
`samples/README.md`.

## Runtime dependencies

### ag-psd 33.0.0

MIT License. Copyright (c) 2016 Agamnentzar.

Used to write Photoshop PSD files, including editable text layers.

### jszip 3.10.2

Dual-licensed MIT / GPL-3.0-or-later. This project uses it under the **MIT**
option. Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz
Buchinger, António Afonso.

Used for the optional batch ZIP download.

### onnxruntime-web 1.31.1

MIT License. Copyright (c) Microsoft Corporation.

Used to run the detection and inpainting ONNX models in the browser. The WASM
loader and binary files copied to `public/ort/` come from this package.

### Vite 7.3.7

MIT License. Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors.

Build tooling only; not part of the PSD output.

### TypeScript 5.9.3

Apache License 2.0. Copyright (c) Microsoft Corporation.

Type-checking and build tooling only.

## Fonts

The following fonts are bundled in `public/fonts/` under the **SIL Open Font
License 1.1**. Full license texts are in `licenses/fonts/`.

| Font | File | License |
|---|---|---|
| Noto Naskh Arabic | `NotoNaskhArabic-Regular.ttf` | OFL-1.1 |
| Noto Sans Arabic | `NotoSansArabic-Regular.ttf` | OFL-1.1 |
| Amiri | `Amiri-Regular.ttf` | OFL-1.1 |

- Noto fonts: Google Fonts / Noto Project.
- Amiri: Khaled Hosny and the Amiri Project.

The PSD writer stores font names, not font binaries. Installing a font on the
viewer's machine is the user's responsibility.

## Models downloaded at runtime

These files are **not** included in this repository. The app downloads them
from Hugging Face or GitHub when the user selects the relevant model. Review
each model's license before redistributing weights or hosting them yourself.

| Model | Source | License |
|---|---|---|
| Comic Text Detector | [`zyddnys/manga-image-translator` release](https://github.com/zyddnys/manga-image-translator/releases) | GPL-3.0 |
| RT-DETR v4 (`detector-v4-s_int8.onnx`) | [`ogkalu/comic-text-and-bubble-detector`](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) | Apache-2.0 |
| LaMa manga dynamic | [`ogkalu/lama-manga-onnx-dynamic`](https://huggingface.co/ogkalu/lama-manga-onnx-dynamic) | Apache-2.0 |

The Comic Text Detector is fetched at runtime and is not linked into the app.
If you redistribute a build together with model weights, comply with the
applicable model licenses. The LaMa model card currently declares Apache-2.0;
the upstream LMT license text lists LaMa as MIT. This project follows the model
card and does not redistribute the weights.

## MIT License text

The following text applies to the MIT-licensed dependencies listed above.

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apache License 2.0

The Apache-licensed components are used under the Apache License, Version 2.0.
A copy of the license is included at `licenses/Apache-2.0.txt` and is also
available at:

<https://www.apache.org/licenses/LICENSE-2.0>

Model weights are downloaded at runtime; consult the model repositories for
their notices and attribution requirements.

## Transitive npm dependencies

The runtime dependency graph is pinned in `package-lock.json`. Production builds
collect the license files installed for runtime npm packages into
`dist/legal/npm/`, with an index at `dist/legal/npm/README.md`. Keep that
directory with any redistributed build. Packages that do not ship a standalone
license file get a `README.txt` pointing to their package page and declared
license.

## Source code and network use

The complete corresponding source for Manga PSD Studio is available at
<https://github.com/lifemoon2456/psdTRManga->. The production build copies
`LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `licenses/` into
`dist/legal/` so release artifacts carry the notices. It also collects runtime
npm license files under `dist/legal/npm/`.

If you deploy a modified version as a network service, AGPL section 13
requires you to offer the corresponding source code to users of that service.
Do not remove the notices when redistributing the app.
