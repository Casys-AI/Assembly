# Vendored Rust sources

`rust-vendor.tar.gz` contains the full sources of the 125 registry crates locked
by `native/toolkit/Cargo.lock` and `native/semantic-index/Cargo.lock`. License
documents, notices, sources and manifests present in every `.crate` archive are
preserved. The tracked manifest authorizes the archive size and SHA-256 before
extraction, then each crate's files and both locks. Added `.cargo-checksum.json`
files let Cargo verify its directory source.

The USTAR archive sorts paths, fixes metadata and uses gzip without a name or
date. The script requires Python 3.11+ and local `.crate` caches. It contacts no
registry and never overwrites divergent output. To reproduce and verify both
files from the repository root:

```sh
python3 vendor/rust/generate.py \
  --cache-root /path/to/cargo-home/registry/cache \
  --verify
```

Repeat `--cache-root` if the addons use separate caches. To prepare output in a
new directory, replace `--verify` with `--output-dir /path/to/new-directory`.
Verify its SHA-256 before updating the tracked manifest.

`tools/setup-rust-vendor.ts` verifies the manifest, archive and locks, then
atomically publishes `.data/toolchains/rust-vendor`. It refuses a divergent tree
and preserves its bytes. The returned `cargoConfig` is a TOML file usable with
`cargo --config <file>`. It replaces `crates-io` with this directory source and
enforces offline mode. Builds must retain `--frozen` and separate targets. The
vendor archive includes neither Rust, npm nor the N-API CLI.
