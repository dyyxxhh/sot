# Interoperability fixtures

- `hello-world.txt` and `hello-world.txt.ots`: [OpenTimestamps Python client examples](https://github.com/opentimestamps/opentimestamps-client/tree/master/examples).
- `header.json`: Bitcoin mainnet block at height 358391, retrieved via the Blockstream API. This is a test vector, not a general source of trust for imported proofs.
- `incomplete.txt` and `incomplete.txt.ots`: [OpenTimestamps JavaScript examples](https://github.com/opentimestamps/javascript-opentimestamps/tree/c07ba8be0dae4e8721a84f32820abf7b2547a6ce/examples); the calendar can now upgrade this old pending proof to height 428648.
- `probe.sig`: standalone test string used as the DigiCert input, not an actual OpenPGP signature. `probe-digicert.tsr` is a real receipt for those bytes.
- `hello-freetsa.tsr`: real FreeTSA receipt for `hello-world.txt`.
- `test/browser.mjs` generates actual GnuPG signing keys in a temporary scratch homedir; the key is not a repo fixture.
