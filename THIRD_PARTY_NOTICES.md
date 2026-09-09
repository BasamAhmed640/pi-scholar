# Third-party notices and release status

Scholar's package is marked `private: true` and `UNLICENSED` because a public
distribution license has not been selected and the quiz adaptation needs its
upstream permission resolved. These fields do not assign a license to upstream
work. Do not publish or redistribute this package until those matters are
resolved.

## Quiz interface provenance

`quiz.ts` records that it adapts Amos Blomqvist's learn extension at commit
`7cfd8942f82ab9476e63572387e1fe9bcea5082c` from
[amosblomqvist/learn](https://github.com/amosblomqvist/learn/tree/7cfd8942f82ab9476e63572387e1fe9bcea5082c).
The locally inspected checkout's origin is that repository. No license,
COPYING, or NOTICE file is tracked at that commit. Attribution alone does not
establish redistribution permission; permission or a suitable replacement is
required before public release. No license for this material is invented here.

Scholar adapts the interaction for its own tool contract and omits free-text
capture. The original attribution in `quiz.ts` remains intact.

## Alvarmethod teaching material

The teaching workflow was developed with reference to
[Vasanth Sreeram's Alvarmethod](https://github.com/vasanthsreeram/Alvarmethod/tree/5d3905613ae660e2f261c7d4ac4b107032a51a26).
The inspected upstream checkout contains the following license, reproduced
verbatim for any adapted portions. It applies to that upstream material and
does not establish a license for all of Scholar.

```text
MIT License

Copyright (c) 2026 Vasanth Sreeram

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

## Separately installed software and content

The release file list does not bundle Pi, Poppler, Node.js, or test dependency
source. Those installations retain their own licenses. User PDFs and vaults are
not package contents. Saved Wikimedia Commons images carry their source and
license attribution in the generated note and are also not distributed with
Scholar.
