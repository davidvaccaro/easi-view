# Philips private CT pixel profile

EASI View recognizes only transfer syntax `1.3.46.670589.33.1.4.1` with
classic CT storage, modality CT, private owner `ELSCINT1` in `(07A1,0010)`,
and compression type `PMSCT_RLE1` in `(07A1,1011)`. The compressed value must
be a defined, even-length OB attribute at `(07A1,100A)`. A simultaneous
standard Pixel Data attribute is rejected. Every relevant parsed attribute
must use Explicit VR Little Endian dataset encoding, as the vendor's
CT-private-ELE declaration requires. An unknown-syntax heuristic does not
by itself authorize pixel decoding.

The supported pixel layout is one MONOCHROME2 frame, one unsigned sample
per pixel, 16 allocated bits, 12 stored bits, and High Bit 11. Dimensions are
bounded to 8192 per axis and 16 megapixels. Encoded private data and the caller's
output budget are each capped at 64 MiB. Scalar numeric metadata requires its
specified VR and VM 1; native US values require exactly two bytes even when
a model getter exposes only the first component. Metadata recognition does
not materialize, clear, or replace the original private value.

The independently implemented decoder runs a bounded byte-state machine:
run escapes expand byte tokens, and absolute-word or signed-delta tokens
produce unsigned 16-bit predictor words. Predictor arithmetic wraps modulo 65536;
the ordinary native decoder then interprets the declared 12 stored bits.
There is no expanded intermediate byte buffer. Private runs may cross image
rows; this format is distinct from the standard row-packed DICOM RLE codec.

Exactly Rows×Columns words must be produced. A pending run, truncated escape,
incomplete absolute word, extra encoded value, or inconsistent length rejects.
After the final word, the only accepted extra byte is the parity-required
single null OB padding byte specified by DICOM PS3.5 §6.2. Arbitrary trailing
zeros and the GDCM example's odd-output truncation are not accepted. Decoding
returns a new canonical native little-endian byte array; it never aliases the
input. Original attributes, transfer syntax, and source encoding identity
remain available independently of the canonical decode marker
`philips-pmsct-rle1-native16le-v1`.

`PMSCT_RGB1`, other private owners or transfer syntaxes, multiframe private
objects, uncompressed private variants, alternate bit layouts, and absent
private bodies are outside this profile. A DICOM JSON BulkDataURI alone is
insufficient: the complete original instance is required. The codec performs
no HTTP fetches, uploads, or quantitative unit inference. Existing source
presentation, stored-value probes, and native scaling remain separate.

Generated numeric tests cover absolute values, signed deltas and unsigned 16-bit
wrap, RLE markers inside absolute words, row-crossing runs, all truncated
prefixes, parity-specific OB padding, wrong VR/VM, conflicting standard pixels,
encoding identity, cancellation, and byte budgets. Real local files are checked
in memory only; checksums and technical counts may be retained privately.
Read-only validation of the local corpus additionally decoded 84 frames and
matched all canonical bytes against a separately compiled GDCM reference.
No original images or decoded byte arrays were saved. These checks establish
the bounded codec profile, not clinical image validation
or general support for Philips private encodings.

## Technical provenance

Philips' [GEMINI v3.5/3.6 conformance statement](https://www.documents.philips.com/doclib/enc/fetch/2000/4504/577242/577256/588723/5144873/5144488/5144390/DICOM_Conformance_Statement_GEMINI_R3.5_R3.6.pdf)
names this UID CT-private-ELE. GDCM's official
[`rle2img.cxx` example](https://github.com/malaterre/GDCM/blob/master/Examples/Cxx/rle2img.cxx)
describes interoperability with ELSCINT1/PMSCT_RLE1 and its byte grammar; it
explicitly identifies the codec as reverse engineered rather than specified
by DICOM. That example is a technical reference, not a runtime dependency;
its permissive size handling and unchecked reads are not used here. The
runtime decoder is an independent one-pass JavaScript implementation. The
[DICOM OB padding rule](https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_6.2.html)
is applied only after the independently declared image size has been satisfied.
