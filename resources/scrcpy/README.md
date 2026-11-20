# Bundled binary: scrcpy server

`scrcpy-server.jar` is the **unmodified** official server from the scrcpy release
[v3.3.3](https://github.com/Genymobile/scrcpy/releases/tag/v3.3.3) (Genymobile, Apache License 2.0; license in `scrcpy-LICENSE.txt`).

SHA-256: `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`

Verify: `shasum -a 256 scrcpy-server.jar` and compare with the asset digest on the release page.

To upgrade: download `scrcpy-server-vX.Y.Z` from the release, save it as `scrcpy-server.jar`, update `SCRCPY_VERSION` in `src/scrcpy.ts` (the protocol must match exactly), update the version and checksum here and in `THIRD_PARTY_NOTICES.md`.
