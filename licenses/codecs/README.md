# Codec notices and binary provenance

The viewer owns its pipeline, frame indexing, scheduling, renderer and tools.
It uses separately licensed pixel decoder libraries. These notices must travel
with the redistributed JavaScript and WebAssembly artifacts.

The unmodified `dcmjs-native-codecs.wasm` comes from the npm package
`dcmjs-codecs@0.0.8`. Its SHA-256 is
`dff1bc9b3872588c231ea90894f05e7eacd7f5074b9db964e64e7f3f29821d30`
(4,117,001 bytes). It exactly matches the binary committed in upstream
[v0.0.8](https://github.com/PantelisGeorgiadis/dcmjs-codecs/tree/v0.0.8),
commit `01efb9f55bdefd75c1b108cd378b1eb9d8d2ebd3`.
See [provenance.json](./provenance.json).

The following inventory follows that revision's
[WASM build script](https://github.com/PantelisGeorgiadis/dcmjs-codecs/blob/v0.0.8/wasm/build.sh)
and vendored source directories. Presence in the binary does not imply that
EASI View exposes or supports every format implemented by that library.

| Component | Upstream version/source | Included notice |
| --- | --- | --- |
| dcmjs-codecs native wrapper | 0.0.8 | `dcmjs-codecs-LICENSE.txt` (MIT) |
| IJG JPEG, 8/12/16-bit builds | 6b, 27 March 1998 | `IJG-README.txt` (full original README including legal terms) |
| OFFIS/DCMTK IJG configuration headers | Copyright 1998–2010 in the vendored headers | `DCMTK-COPYRIGHT.txt` (upstream DCMTK 3.6.8 copyright collection) |
| CharLS | [2.3.4](https://github.com/team-charls/charls/tree/2.3.4) | `CharLS-LICENSE.txt` (BSD 3-clause) |
| OpenJPEG | [2.5.0](https://github.com/uclouvain/openjpeg/tree/v2.5.0) | `OpenJPEG-LICENSE.txt` (BSD 2-clause) |
| OpenJPEG HT block decoder | `ht_dec.c` in the pinned vendored source | `OpenJPEG-HT-decoder-NOTICE.txt` (BSD 2-clause) |
| OpenJPH | [0.18.2](https://github.com/aous72/OpenJPH/tree/0.18.2) | `OpenJPH-LICENSE.txt` (BSD 2-clause) |
| libjxl | [0.11.2](https://github.com/libjxl/libjxl/tree/v0.11.2) | `JPEG-XL-LICENSE.txt`, `JPEG-XL-PATENTS.txt`, `JPEG-XL-AUTHORS.txt` |
| Brotli | [1.2.0](https://github.com/google/brotli/tree/v1.2.0) | `Brotli-LICENSE.txt` (MIT) |
| Highway | [1.2.0](https://github.com/google/highway/tree/1.2.0) | `Highway-LICENSE.txt` (full Apache License 2.0) |
| skcms | Vendored snapshot named `2025_09_16` | `skcms-LICENSE.txt` (BSD 3-clause, copied directly from the pinned source) |
| Better Enums | [0.11.3](https://github.com/aantron/better-enums/tree/0.11.3) | `Better-Enums-LICENSE.txt` (BSD 2-clause) |
| jpeg-js | 0.4.4 npm package | `jpeg-js-LICENSE.txt` and `jpeg-js-source-NOTICES.txt` (package BSD 3-clause; decoder Apache 2.0; encoder Adobe BSD 3-clause) |

This software is based in part on the work of the Independent JPEG Group.
`IJG-README.txt` was obtained from the
[official JPEG 6b source archive](https://www.ijg.org/files/jpegsrc.v6b.tar.gz).
`VENDORED-COPYRIGHTS.txt` retains additional individual copyright lines from
the pinned vendored libraries. These component licenses remain separate from
the EASI View Community License.

Upstream builds with Emscripten but its pinned build workflow does not identify
the toolchain version used for this precompiled binary. The supplementary
`Emscripten-LICENSE.txt`, `musl-COPYRIGHT.txt`, and `LLVM-compiler-rt-LICENSE.txt`
were obtained from the respective official upstream source trees. They are
included for compiler/runtime components, without asserting a reproducible
toolchain version or a complete linker map. Sources:
[Emscripten license](https://github.com/emscripten-core/emscripten/blob/main/LICENSE),
[bundled musl copyright](https://github.com/emscripten-core/emscripten/blob/main/system/lib/libc/musl/COPYRIGHT),
[compiler-rt license](https://github.com/llvm/llvm-project/blob/main/compiler-rt/LICENSE.TXT).

The JavaScript `dcmjs-codecs` package and its `dcmjs` dependency are test/build
tools; EASI View's runtime wrapper calls the copied WASM directly. Their use
in synthetic fixture generation does not add a viewer framework dependency.
