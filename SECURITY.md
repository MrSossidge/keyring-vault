# Security

Keyring holds credentials, so it's worth being precise about what it protects you from and
what it doesn't.

## The design in one paragraph

Your master password is stretched with PBKDF2-SHA256 (310,000 iterations, 16-byte random
salt) into a 256-bit AES key. The entire vault — every key, secret, note and entry name — is
serialised to JSON and encrypted with AES-256-GCM under a fresh 96-bit IV on every save.
Only that ciphertext is written to `localStorage` or sent to the sync server. The derived key
is marked non-extractable and lives in the tab's memory until you lock, close it, or the idle
timer fires.

## What this protects against

- **Someone reading the server's disk.** Backups, snapshots, a stolen drive, a nosy
  administrator, another container on the host — they all get the same base64 blob.
- **Someone on your network.** The sync endpoint only ever carries ciphertext. Set
  `KEYRING_TOKEN` and they can't even fetch or overwrite it.
- **The server itself being compromised.** It has no key material. There is nothing on it to
  steal that would decrypt your vault.
- **Casual shoulder-surfing.** Values are masked until you reveal them, and the vault
  auto-locks when idle.

## What it does not protect against

- **A compromised browser or machine.** If something is running as you on the machine where
  you unlock the vault, it can read the decrypted contents. No browser-based vault can fix
  this.
- **A weak master password.** PBKDF2 raises the cost of guessing; it doesn't rescue
  `password1`. The blob is the only thing standing between an attacker with your backup file
  and your keys. Use a passphrase.
- **A malicious modification of the page.** The app is served from your own host. If someone
  can rewrite `keyring.html` there, they can make it exfiltrate whatever you type. Treat
  write access to `/opt/keyring/site` as equivalent to access to the vault.
- **Losing the password.** There is no recovery, no reset, no backdoor. This is deliberate,
  and it means an encrypted backup is worthless to you without the password too.
- **Traffic analysis.** Someone watching the network learns when you save and roughly how
  large your vault is. Not the contents.

## Why HTTPS is mandatory

Browsers only expose `crypto.subtle` in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
On a plain `http://` LAN address it is simply `undefined` — the page cannot encrypt at all.

Rather than silently degrade to storing your keys in plain text, Keyring detects this and
refuses, explaining what to do about it. If you deliberately opt into the unencrypted mode
it offers as a last resort, a red banner stays on screen for as long as the vault is in that
state.

`https://` (self-signed is fine), `localhost` and `file://` all qualify as secure contexts.

## Deliberate choices

- **The server refuses unencrypted vaults.** A `PUT` whose record doesn't have `enc: true` is
  rejected with `400`, so plaintext can't reach the disk even by accident or misconfiguration.
- **The vault file is written `0600`**, and the service drops to an unprivileged uid after
  taking ownership of its data directory.
- **The page makes no outbound requests** other than to its own `/api` endpoint. No fonts, no
  analytics, no CDN. The CSP in the Caddyfile enforces this.
- **Clipboard clearing is off by default**, because it is unreliable across browsers and a
  security feature that silently doesn't work is worse than none.

## Reporting something

If you find a problem with the crypto or the sync logic, open an issue. If you'd rather not
do that in public, say so in an issue without details and we'll find another channel.
