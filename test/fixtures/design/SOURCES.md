# Where the Figma files come from

Both files are real Figma exports, kept as the exporter wrote them (no editor, no re-zip), so the scan is tested on what
Figma makes and not only on files this repository builds. Each is here under its project's MIT licence, and the licence text
is below.

| File            |  Bytes | From                                                                                                                                                                             |
| --------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal.fig`   |    528 | [JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design), `skills/baoyu-design/agents/tests/fixtures/minimal.fig`                                                           |
| `variables.fig` | 274351 | [Figma's Simple Design System](https://github.com/figma/sds) (SDS), the template that the Figma app gives: a local copy saved from it, with its images and its thumbnail removed |

`minimal.fig` holds layers only (a document, a canvas, a frame, and a component), and no variables: it proves the
container, the schema, the message, and the one value form that is easy to get wrong (a float).

`variables.fig` holds the SDS variables: 108 of them in 7 collections, one of which has a light mode and a dark mode, and
the text and colour styles. Its `images/` entries were removed (nothing in them is imported), so the file has no images for
a design to point at.

## SHA-256 of each file here

```text
a5e4e181fb984392afd32b0eabe4bfc7305a57df5408d2ea1c3bd02235a768a5  minimal.fig
ce22d9e60c3d89fa633ca022db9faf6304133fbad6a07d3c0e85c309b26a5fae  variables.fig
```

## minimal.fig: JimLiu/baoyu-design

MIT License

Copyright (c) 2026 Jim Liu 宝玉

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

## variables.fig: Figma's Simple Design System

MIT License

Copyright (c) 2024 Figma

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
