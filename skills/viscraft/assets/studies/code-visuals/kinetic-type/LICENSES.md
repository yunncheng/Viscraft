# Licences — kinetic-type

Viscraft-owned code, documentation, original artwork, animation, music and
rendered previews in this reference are licensed under Apache-2.0. Adapted
upstream portions retain their MIT copyright and permission notices; fonts
and other third-party material retain their stated terms. A mixed code Asset
uses `Apache-2.0 AND MIT` to retain both sets of applicable obligations.

This reference carries two independent grants: the author implementation and the
font. The font text ships verbatim beside it; neither grant is replaced by a
summary table.

## Reference code — Apache-2.0 and upstream notices

The Viscraft implementation uses Apache-2.0; upstream MIT notices remain
with the mechanisms credited below.

### Viscraft implementation

The canvas-2D implementation in `kinetic-type.mjs` and its scene entry are an
original Viscraft implementation, released under Apache-2.0 below. Their
grid, clipped line-rise, reading-hold, weighted-word and wipe mechanisms were
studied from the sources credited in the next section.

Copyright (c) 2026 The Viscraft Authors

Licensed under the Apache License, Version 2.0. The full text is reproduced below.

### Studied upstream mechanisms

The implementation was studied from:

- Lemo-Opuscar `styles/swiss-motion/demo/film.js` and `ease.js` at
  `e3cb16f63768c68693ff0e15171d6e755457cc32` (LemoLab), MIT.
- huashu-art-motion `scripts/engine/clips/y5_kinetic_type.js` at
  `f178bd7754a71d6d399473af1501634548efa6cb` (MIT, Copyright (c) 2026
  alchaincyf). Only its page hierarchy and page-progression method were
  studied; no source line, story, score, voice, media or font from it is
  included, so no huashu bytes are distributed here.

The LemoLab grant is reproduced verbatim:

MIT License

Copyright (c) 2026 LemoLab

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

No upstream 44-second story, score, voice, illustration or sample is included.

## Font — SIL Open Font License 1.1

`fonts/NotoSansSC-VF.woff2` is the complete Noto Sans SC variable font. The
verbatim licence text is `fonts/OFL-NotoSansSC.txt` and is shipped with the
reference and copied into every authored Project.

Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name
'Source'.

Source identity:

- Repository: `https://github.com/google/fonts`
- Commit: `47d54ca1ebb14fd864695f1d39dc734f39017c33`
- Original path: `ofl/notosanssc/NotoSansSC[wght].ttf`
- GitHub blob: `fb0637bafbcd804fe32152370a1225990745b4bc`
- Original size: 17,772,300 bytes
- Original SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Original licence SHA-256: `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`

Conversion (lossless font-data conversion, no subsetting):

```sh
python3 -c "from fontTools.ttLib.woff2 import compress; compress('NotoSansSC-VF.ttf', 'NotoSansSC-VF.woff2')"
```

- Tool: fontTools 4.65.0 (`fontTools.ttLib.woff2.compress`)
- WOFF2 size: 7,782,072 bytes
- WOFF2 SHA-256: `aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a`
- The original 17,772,300-byte TTF is research input only and is **not**
  shipped; the delivered font is the complete WOFF2.

### Conversion record

The delivered WOFF2 carries the same font data as the original TTF, compared as
font data rather than file size:

- `getBestCmap()` dictionaries are equal: **30,890 code points**.
- Glyph order is equal: **31,036 glyphs**.
- `hmtx` metrics are equal; `gvar`, `fvar`, `name`, `post`, `GDEF`, `GPOS`,
  `GSUB`, `cmap`, `hhea`, `maxp` and `OS/2` table bytes are equal.
- Every glyph outline was serialized and hashed: the digest
  `9c6bbef0f2f5c97dbd3e23214c8a16da358d1cc6316d1113256f1c7951583cdc` is
  identical. Instancing the variable font at `wght` 100, 400, 700 and 900
  produced equal cmap, metrics and outline digests from both files.
- `head` differs only in `checkSumAdjustment` and in `flags` bit 11
  (`0x0800`, the lossless-compressed marker); unitsPerEm (1000), bbox,
  timestamps, `fontRevision` and all other `head` fields are equal.
- The authored default text has no missing code points. `U+1F600`, `U+20000`
  and `U+10FFFF` are absent from the cmap and are not promised; `U+9FA6` is
  present.
- There is no sample-only subsetting: the complete cmap and all 31,036 glyphs
  survive the conversion. The smaller file is WOFF2 compression of the complete
  font.

The CSS/FontFace family alias `Noto Sans SC Kinetic` is a runtime name only;
the font's `name` table is unchanged and the OFL Reserved Font Name is not
applied to a modified font, because the font data is not modified.

## Apache License 2.0 — Viscraft contributions (full text)

Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
