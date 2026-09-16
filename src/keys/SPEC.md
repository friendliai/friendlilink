# keys/

- `resolveApiKey` (`api-key.ts`) is the ONE key path for every harness (via
  key-preamble) and `status`/`models`: `--api-key` > `FRIENDLIAI_API_KEY`
  > aliases `FRIENDLI_API_KEY`, `FRIENDLI_TOKEN` (resolved silently) > OS
  > keychain.
- hermes and dsh read the key from a dotenv, so `on` writes it there via
  `writeOwnedEnvKey` (`env.ts`): record what `FRIENDLIAI_API_KEY` held
  (fatal when unrecordable), then the atomic 0o600 matched-line write
  (drop all `KEY=` lines, append fresh). `off` undoes it via
  `revertOwnedEnvKey`: pre-`on` user lines restored, only our line
  dropped, user-edited or record-less files untouched, a locked file
  can't block the uninstall (record survives for retry). Records:
  SHA-256(envPath + key) under the harness data dir.
- `login` writes only the keychain; `logout` never touches a `.env`.
- Tests: `test/keys/{api-key,env,env-revert}.test.ts`.
