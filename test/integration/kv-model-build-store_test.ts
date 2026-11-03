// test/integration/kv-model-build-store_test.ts — lot W2c, magasin KV.
//
// Une section par règle du magasin :
//   octets exacts (ArrayBuffer exact + put idempotent),
//   absent (→ BUILD_BLOB_MISSING),
//   corruption (octet inversé → BUILD_BLOB_CORRUPT),
//   conflit (même clé autre contenu → BUILD_BLOB_CONFLICT),
//   baux CAS (6 processus × 200, exactement un gagnant),
//   put tué (écriture tuée en plein put : orphelins balayés),
//   indisponible (Deno.openKv indéfini → BUILD_STORE_UNAVAILABLE).
// Imports et helpers : un seul sha256Hex, un seul patternBytes (et
// payloadBytes pour l'incompressible), un seul openTempStore/closeAndRemove,
// une seule interface WriterEvent, un seul runWriter. Deux sections à part :
// écritures concurrentes multi-processus et mesures de réception.
//
// Commande (depuis la racine du dépôt) :
//   nice -n 10 .data/toolchains/deno-v2.9.7/deno test --no-prompt \
//     --allow-read --allow-write --allow-env --allow-run \
//     test/integration/kv-model-build-store_test.ts
// Permissions : read/write (dossiers KV temporaires + sources lues par les
// fils), run (sous-processus kv-writer), env (héritage DENO_DIR) ; drapeau
// KV via deno.json ("unstable": ["kv"]). Chaque test ouvre un dossier KV
// temporaire unique, nettoyé en finally même en échec.
// Unix uniquement pour le test SIGKILL (comme src/adapters/tool-runner.ts:363).
import assert, { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";
import { getMeta, set as setBlob } from "@kitsonk/kv-toolbox/blob";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KvModelBuildStore,
  retryBusy,
} from "../../src/adapters/out/deno-kv/kv-store.ts";
import { BLOB_KEY } from "@kitsonk/kv-toolbox/blob";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";

/** Contenu déterministe : motif pseudo-aléatoire, zéro hasard, zéro temps. */
function patternBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** sha256 hex d'une vue, sans jamais lire hors de la vue (copie exacte). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

async function openTempStore(
  prefix: string,
): Promise<{ store: KvModelBuildStore; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix });
  const store = await KvModelBuildStore.open({ path: `${dir}/cache.kv` });
  return { store, dir };
}

async function closeAndRemove(
  dir: string,
  store: ModelBuildStore,
): Promise<void> {
  try {
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Règle « ArrayBuffer exact + put idempotent » (extrait rule-octets-exacts).
// ---------------------------------------------------------------------------

const OCTETS_N = 200_000;
const OCTETS_OFFSET = 123_456;
const OCTETS_BACKING = OCTETS_OFFSET + OCTETS_N + 71_111;

Deno.test({
  name: "w2c octets exacts — subarray stocke exactement N octets",
  async fn() {
    const { store, dir } = await openTempStore("w2c-octets-exacts-");
    try {
      // Vue décalée sur un grand tampon : byteOffset !== 0, buffer hôte > N.
      const backing = patternBytes(OCTETS_BACKING, 7);
      const view = backing.subarray(OCTETS_OFFSET, OCTETS_OFFSET + OCTETS_N);
      assert.equal(view.byteLength, OCTETS_N);
      assert.ok(view.byteOffset !== 0);
      assert.ok(view.buffer.byteLength > OCTETS_N);
      const digest = await sha256Hex(view);

      const put = await store.put(digest, view);
      assert.equal(put.stored, true);
      assert.equal(put.bytes, OCTETS_N);
      assert.equal(put.digest, digest);

      const got = await store.get(digest);
      assert.equal(got.byteLength, OCTETS_N);
      assert.equal(got.buffer.byteLength, OCTETS_N); // ArrayBuffer exact, pas le backing
      assert.deepEqual(got, view);
      assert.equal(await sha256Hex(got), digest);
      assert.equal(await store.has(digest), true);
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

Deno.test({
  name: "w2c octets exacts — Buffer node poolé stocke exactement N octets",
  async fn() {
    const { store, dir } = await openTempStore("w2c-octets-exacts-");
    try {
      // Vue mémoire partagée via l'API node:buffer (cas du Buffer poolé) :
      // Buffer.from(arrayBuffer, offset, longueur) ne copie pas.
      const backing = Buffer.allocUnsafe(16_384);
      backing.set(patternBytes(16_384, 99));
      const pooled = Buffer.from(backing.buffer, 8, 4096);
      const view = new Uint8Array(
        pooled.buffer,
        pooled.byteOffset,
        pooled.byteLength,
      );
      const wanted = patternBytes(16_384, 99).subarray(8, 8 + 4096);
      assert.equal(view.byteLength, 4096);
      assert.ok(
        view.buffer.byteLength > view.byteLength,
        "le tampon doit être poolé (partagé) pour que le test ait un sens",
      );
      const digest = await sha256Hex(view);

      const put = await store.put(digest, view);
      assert.equal(put.stored, true);
      assert.equal(put.bytes, 4096);

      const got = await store.get(digest);
      assert.equal(got.byteLength, 4096);
      assert.deepEqual(got, wanted);
      assert.equal(await sha256Hex(got), digest);
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

Deno.test({
  name: "w2c put idempotent — second put sauté, aucun changement observable",
  async fn() {
    const { store, dir } = await openTempStore("w2c-octets-exacts-");
    try {
      const bytes = patternBytes(OCTETS_N, 13);
      const digest = await sha256Hex(bytes);

      const first = await store.put(digest, bytes);
      assert.equal(first.stored, true);
      assert.equal(first.bytes, OCTETS_N);

      const statsBefore = await store.stats();
      const gotBefore = await store.get(digest);

      const second = await store.put(digest, bytes);
      assert.equal(second.stored, false); // plan W2c l.652 : « second put saute »
      assert.equal(second.bytes, OCTETS_N);
      assert.equal(second.digest, digest);

      const statsAfter = await store.stats();
      assert.deepEqual(statsAfter, statsBefore);
      assert.equal(statsAfter.blobCount, 1);
      assert.equal(statsAfter.uncompressedBytes, OCTETS_N);

      const gotAfter = await store.get(digest);
      assert.deepEqual(gotAfter, gotBefore);
      assert.equal(gotAfter.byteLength, OCTETS_N);
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

// ---------------------------------------------------------------------------
// Règle « absent » (extrait rule-absent) : has == false sans lever, get lève
// BUILD_BLOB_MISSING (jamais null, jamais BUILD_STORE_UNAVAILABLE).
// ---------------------------------------------------------------------------

// Digests bien formes (64 hex minuscules) mais jamais ecrits : chaque test
// ouvre un magasin frais, donc aucune de ces cles n'a de meta de completude.
const NEVER_WRITTEN_A = "a".repeat(64);
const NEVER_WRITTEN_B = "b".repeat(64);

function assertMissing(error: unknown, digest: string): void {
  assert.ok(error instanceof BuildStoreError, "attendu BuildStoreError");
  assert.equal(error.code, "BUILD_BLOB_MISSING");
  assert.notEqual(error.code, "BUILD_STORE_UNAVAILABLE");
  assert.equal(error.context["digest"], digest);
  assert.equal(typeof error.recovery, "string");
  assert.ok(error.recovery.length > 0, "recovery non vide");
  assert.equal(error.name, "BuildStoreError");
}

Deno.test("w2c absent: has == false et get leve BUILD_BLOB_MISSING", async () => {
  const { dir, store } = await openTempStore("w2c-absent-");
  try {
    assert.equal(await store.has(NEVER_WRITTEN_A), false);
    const error = await store.get(NEVER_WRITTEN_A).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(error !== null, "get sur cle absente doit lever");
    assertMissing(error, NEVER_WRITTEN_A);
    // Le magasin reste vide : comptage exact, la lecture n'a rien cree.
    const stats = await store.stats();
    assert.equal(stats.blobCount, 0);
    assert.equal(stats.projectionCount, 0);
    // Repetabilite : l'absence est stable, pas un accident transitoire.
    assert.equal(await store.has(NEVER_WRITTEN_A), false);
    assertMissing(
      await store.get(NEVER_WRITTEN_A).then(
        () => null,
        (cause: unknown) => cause,
      ),
      NEVER_WRITTEN_A,
    );
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c absent: absence stricte vs panne et vs cle mal formee", async () => {
  const { dir, store } = await openTempStore("w2c-absent-");
  try {
    // Deux digests absents distincts se comportent pareil (pas de faux
    // positif lie a une valeur particuliere).
    for (const digest of [NEVER_WRITTEN_A, NEVER_WRITTEN_B]) {
      assert.equal(await store.has(digest), false);
      assertMissing(
        await store.get(digest).then(
          () => null,
          (cause: unknown) => cause,
        ),
        digest,
      );
    }
    // Cle mal formee : validation de frontiere -> BUILD_STORE_INVALID_INPUT,
    // ni MISSING (absence) ni UNAVAILABLE (panne) ni CORRUPT (donnees).
    for (const bad of ["not-a-digest", "", NEVER_WRITTEN_A.toUpperCase()]) {
      const hasError = await store.has(bad).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(hasError instanceof BuildStoreError, `has(${bad}) doit lever`);
      assert.equal(hasError.code, "BUILD_STORE_INVALID_INPUT");
      const getError = await store.get(bad).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(getError instanceof BuildStoreError, `get(${bad}) doit lever`);
      assert.equal(getError.code, "BUILD_STORE_INVALID_INPUT");
    }
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c absent: projections absentes", async () => {
  const { dir, store } = await openTempStore("w2c-absent-");
  try {
    assert.equal(
      await store.hasProjection("model-json", "p1", NEVER_WRITTEN_A),
      false,
    );
    const projError = await store
      .getProjection("model-json", "p1", NEVER_WRITTEN_A).then(
        () => null,
        (cause: unknown) => cause,
      );
    assert.ok(projError !== null, "getProjection absente doit lever");
    // Meme code MISSING que get, mais contexte nomme la projection
    // (adaptateur getProjection : { kind, projectorVersion, artifactKey }).
    assert.ok(projError instanceof BuildStoreError, "attendu BuildStoreError");
    assert.equal(projError.code, "BUILD_BLOB_MISSING");
    assert.notEqual(projError.code, "BUILD_STORE_UNAVAILABLE");
    assert.equal(projError.context["artifactKey"], NEVER_WRITTEN_A);
    assert.equal(projError.context["kind"], "model-json");
    assert.equal(projError.context["projectorVersion"], "p1");
  } finally {
    await closeAndRemove(dir, store);
  }
});

// ---------------------------------------------------------------------------
// Règle « corruption » (extrait rule-corruption) : un octet inversé dans le
// morceau brut → BUILD_BLOB_CORRUPT, jamais d'octets altérés rendus.
// ---------------------------------------------------------------------------

Deno.test("build blob: un octet inversé dans le morceau brut → BUILD_BLOB_CORRUPT, jamais d'octets altérés", async () => {
  const directory = await Deno.makeTempDir({ prefix: "w2c-corrupt-" });
  const path = `${directory}/cache.kv`;
  const bytes = patternBytes(5000, 7);
  const digest = await sha256Hex(bytes);
  let store = await KvModelBuildStore.open({ path });
  try {
    const put = await store.put(digest, bytes);
    equal(put.stored, true);
    equal(put.bytes, 5000);
    await store.close();

    // Inversion d'un octet directement dans le KV brut : on localise un
    // morceau stocké grâce à la disposition des clés
    // (["build","blob",A,"__kv_toolbox_blob__",n], n observé = 1 ; la
    // découverte par list ne dépend pas de la numérotation).
    const raw = await Deno.openKv(path);
    try {
      let chunkKey: Deno.KvKey | null = null;
      let chunkBytes: Uint8Array | null = null;
      for await (
        const entry of raw.list({ prefix: ["build", "blob", digest] })
      ) {
        const key = entry.key;
        if (
          key.length === 5 && key[3] === "__kv_toolbox_blob__" &&
          typeof key[4] === "number" && entry.value instanceof Uint8Array
        ) {
          chunkKey ??= key;
          chunkBytes ??= entry.value;
        }
      }
      ok(chunkKey !== null, "un morceau brut doit exister sous [build,blob,A]");
      ok(
        chunkBytes !== null && chunkBytes.length > 16,
        "le morceau brut doit être un Uint8Array non vide",
      );
      const mutated = new Uint8Array(chunkBytes);
      mutated[10] ^= 0xff; // inversion d'un seul octet (compressé zstd)
      const set = await raw.set(chunkKey, mutated);
      ok(set.ok, "l'écriture brute de l'octet inversé doit réussir");
    } finally {
      raw.close();
    }

    // Réouverture (le sweep d'ouverture ne touche pas l'entrée : sa méta
    // __kv_toolbox_meta__ est intacte) puis lecture vérifiée.
    store = await KvModelBuildStore.open({ path });
    equal(
      await store.has(digest),
      true,
      "la méta de complétude est intacte : has reste vrai",
    );
    let thrown: unknown = null;
    try {
      await store.get(digest);
    } catch (error) {
      thrown = error;
    }
    ok(thrown instanceof BuildStoreError, "get doit lever BuildStoreError");
    equal((thrown as BuildStoreError).code, "BUILD_BLOB_CORRUPT");
    equal((thrown as BuildStoreError).context["digest"], digest);
    ok(
      "stage" in (thrown as BuildStoreError).context,
      "le contexte porte l'étape de détection",
    );
    ok(
      (thrown as BuildStoreError).recovery.length > 0,
      "recovery non vide",
    );
    // Réparation : put des octets sains sous le même digest réécrit
    // l'entrée illisible, puis get rend les octets exacts.
    const repaired = await store.put(digest, bytes);
    equal(repaired.stored, true);
    const back = await store.get(digest);
    equal(back.byteLength, bytes.byteLength);
    equal(await sha256Hex(back), digest);
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

/** Compression identique à l'adaptateur (zstd-3 + checksum, copie exacte). */
function compressLikeAdapter(bytes: Uint8Array): ArrayBuffer {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const compressed = zstdCompressSync(input.buffer, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 3,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
    },
  });
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  return copy.buffer;
}

// Tue la mutation M5 : un blob zstd parfaitement valide (checksum OK,
// décompression OK) dont le contenu décompressé ne correspond pas au digest
// doit être arrêté par l'étage `verify` (sha256 à la lecture), pas rendu.
Deno.test("build blob: contenu zstd valide mais sha différent du digest → BUILD_BLOB_CORRUPT stage verify", async () => {
  const directory = await Deno.makeTempDir({ prefix: "w2c-verify-" });
  const path = `${directory}/cache.kv`;
  const bytes = patternBytes(5000, 7);
  const digest = await sha256Hex(bytes);
  const other = patternBytes(5000, 42);
  const otherDigest = await sha256Hex(other);
  ok(otherDigest !== digest);
  let store = await KvModelBuildStore.open({ path });
  try {
    equal((await store.put(digest, bytes)).stored, true);
    await store.close();

    // Réécriture brute : sous la clé de `digest`, un blob kv-toolbox complet
    // (méta cohérente) portant la compression valide d'UN AUTRE contenu.
    const raw = await Deno.openKv(path);
    try {
      await setBlob(raw, ["build", "blob", digest], compressLikeAdapter(other));
    } finally {
      raw.close();
    }

    store = await KvModelBuildStore.open({ path });
    let thrown: unknown = null;
    try {
      await store.get(digest);
    } catch (error) {
      thrown = error;
    }
    ok(thrown instanceof BuildStoreError, "get doit lever BuildStoreError");
    equal((thrown as BuildStoreError).code, "BUILD_BLOB_CORRUPT");
    equal((thrown as BuildStoreError).context["stage"], "verify");
    equal((thrown as BuildStoreError).context["actualSha256"], otherDigest);
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

// Tue la mutation M1 : si les octets stockés sont corrompus entre le `set`
// et la relecture, le put vérifié doit lever BUILD_BLOB_CORRUPT
// (stage put-verify) et ne jamais annoncer stored: true. Le blob et sa
// réservation sont conservés : une suppression pourrait effacer le gagnant
// d’une écriture concurrente ; toute lecture vérifiée refuse ces octets.
// A second real KV handle corrupts the first chunk after the completion-meta
// commit and before that commit returns to the writer. The verified read cannot
// overtake injection; this exercises real storage without timing or a huge blob.
Deno.test("w2c put vérifié — corruption pendant l'écriture → BUILD_BLOB_CORRUPT stage put-verify, rien d'annoncé", async () => {
  const directory = await Deno.makeTempDir({ prefix: "w2c-put-verify-" });
  const path = `${directory}/cache.kv`;
  const bytes = payloadBytes(256 * 1024, 0x9e3779b9);
  const digest = await sha256Hex(bytes);
  const raw = await Deno.openKv(path);
  let store: KvModelBuildStore | undefined;
  let restoreWriter = () => {};
  let corrupted = false;
  try {
    const chunkKey: Deno.KvKey = [
      "build",
      "blob",
      digest,
      "__kv_toolbox_blob__",
      1,
    ];
    const openKv = Deno.openKv;
    const openerDescriptor = Object.getOwnPropertyDescriptor(Deno, "openKv");
    ok(openerDescriptor?.configurable, "owned interception must be reversible");
    try {
      // Intercept only the owned writer handle, then restore the public opener
      // immediately. Every commit and read still goes to the real KV database.
      const interceptedOpen: typeof Deno.openKv = async (requestedPath) => {
        const writer = await openKv(requestedPath);
        if (requestedPath !== path) return writer;
        const atomic = writer.atomic;
        restoreWriter = () => {
          writer.atomic = atomic;
        };
        writer.atomic = () => {
          const operation = atomic.call(writer);
          const commit = operation.commit.bind(operation);
          operation.commit = async () => {
            const result = await commit();
            if (!result.ok || corrupted) return result;
            const meta = await getMeta(raw, ["build", "blob", digest]);
            if (meta.value === null) return result;
            const entry = await raw.get<Uint8Array>(chunkKey);
            ok(entry.value !== null && entry.value.byteLength > 200);
            const mutated = new Uint8Array(entry.value);
            for (let i = 100; i < 108; i++) mutated[i] ^= 0xff;
            const injected = await raw.set(chunkKey, mutated);
            ok(injected.ok, "l'injection de corruption brute doit réussir");
            corrupted = true;
            return result;
          };
          return operation;
        };
        return writer;
      };
      Object.defineProperty(Deno, "openKv", {
        configurable: openerDescriptor.configurable,
        enumerable: openerDescriptor.enumerable,
        get: () => interceptedOpen,
      });
      store = await KvModelBuildStore.open({ path });
    } finally {
      Object.defineProperty(Deno, "openKv", openerDescriptor);
    }
    const outcome = await store.put(digest, bytes).then(
      (result) => ({ ok: true as const, result }),
      (error) => ({ ok: false as const, error }),
    );
    ok(corrupted, "corruption committed before the writer's verified read");
    ok(
      !outcome.ok,
      "put ne doit pas annoncer un blob corrompu (stored: true défendu)",
    );
    const error = (outcome as { error: unknown }).error;
    ok(error instanceof BuildStoreError, "put doit lever BuildStoreError");
    equal((error as BuildStoreError).code, "BUILD_BLOB_CORRUPT");
    equal((error as BuildStoreError).context["stage"], "put-verify");
    equal(
      await store.has(digest),
      true,
      "has ne déclare que la présence de la méta de complétude",
    );
    equal(
      await errorCode(store.get(digest)),
      "BUILD_BLOB_CORRUPT",
      "aucune lecture vérifiée ne doit rendre les octets corrompus",
    );
    const reserved = await store.stats();
    equal(reserved.blobCount, 1, "la réservation durable reste comptée");
    equal(reserved.uncompressedBytes, bytes.byteLength);
    const repaired = await store.put(digest, bytes);
    equal(repaired.stored, true);
    deepStrictEqual(await store.get(digest), bytes);
    equal(
      (await store.stats()).uncompressedBytes,
      bytes.byteLength,
      "la réparation réutilise la réservation sans double charge",
    );
  } finally {
    restoreWriter();
    raw.close();
    await store?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("build blob: témoin non corrompu — get rend les octets exacts", async () => {
  const directory = await Deno.makeTempDir({ prefix: "w2c-corrupt-control-" });
  const path = `${directory}/cache.kv`;
  const bytes = patternBytes(5000, 7);
  const digest = await sha256Hex(bytes);
  const store = await KvModelBuildStore.open({ path });
  try {
    await store.put(digest, bytes);
    const out = await store.get(digest);
    equal(out.length, 5000);
    deepStrictEqual(Array.from(out), Array.from(bytes));
    equal(await sha256Hex(out), digest);
  } finally {
    await store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Règle « conflit même clé » (extrait rule-conflit) : second put même digest
// contenu différent → BUILD_BLOB_CONFLICT, A intact, jamais écrasé.
// ---------------------------------------------------------------------------

const CONFLIT_N = 4096;

Deno.test({
  name:
    "w2c conflit — second put même digest contenu différent → BUILD_BLOB_CONFLICT, A intact",
  async fn() {
    const { store, dir } = await openTempStore("w2c-conflit-");
    try {
      const contentA = patternBytes(CONFLIT_N, 7);
      const contentB = patternBytes(CONFLIT_N, 99);
      assert.notDeepEqual(contentA, contentB);
      const digestA = await sha256Hex(contentA);
      const digestB = await sha256Hex(contentB);
      assert.notEqual(digestA, digestB);

      const first = await store.put(digestA, contentA);
      assert.equal(first.stored, true);
      assert.equal(first.bytes, CONFLIT_N);
      assert.equal(first.digest, digestA);

      // Même digest D, contenu B différent : conflit codé, jamais écrasé.
      const conflict = await store.put(digestA, contentB).then(
        () => assert.fail("le second put aurait dû lever BUILD_BLOB_CONFLICT"),
        (error: unknown) => error,
      );
      assert.ok(conflict instanceof BuildStoreError);
      assert.equal(conflict.code, "BUILD_BLOB_CONFLICT");
      assert.equal(conflict.context["digest"], digestA);
      assert.equal(conflict.context["actualSha256"], digestB);
      assert.equal(typeof conflict.recovery, "string");
      assert.ok(conflict.recovery.length > 0);

      // A intact après le conflit : octets exacts, présence, compte.
      const got = await store.get(digestA);
      assert.equal(got.byteLength, CONFLIT_N);
      assert.deepEqual(got, contentA);
      assert.equal(await sha256Hex(got), digestA);
      assert.equal(await store.has(digestA), true);
      const stats = await store.stats();
      assert.equal(stats.blobCount, 1);
      assert.equal(stats.uncompressedBytes, CONFLIT_N);
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

Deno.test({
  name:
    "w2c conflit — put digest mensonger sur magasin vide → BUILD_BLOB_CONFLICT, rien stocké",
  async fn() {
    const { store, dir } = await openTempStore("w2c-conflit-");
    try {
      const contentA = patternBytes(CONFLIT_N, 7);
      const contentB = patternBytes(CONFLIT_N, 99);
      const digestA = await sha256Hex(contentA);

      // B sous le digest de A, sans entrée préalable : refus avant écriture.
      const conflict = await store.put(digestA, contentB).then(
        () =>
          assert.fail("le put mensonger aurait dû lever BUILD_BLOB_CONFLICT"),
        (error: unknown) => error,
      );
      assert.ok(conflict instanceof BuildStoreError);
      assert.equal(conflict.code, "BUILD_BLOB_CONFLICT");
      assert.equal(conflict.context["digest"], digestA);
      assert.equal(typeof conflict.recovery, "string");
      assert.ok(conflict.recovery.length > 0);

      // Rien n'a été écrit : absent → MISSING (jamais un faux présent),
      // has false, compte à zéro.
      assert.equal(await store.has(digestA), false);
      const missing = await store.get(digestA).then(
        () => assert.fail("get aurait dû lever BUILD_BLOB_MISSING"),
        (error: unknown) => error,
      );
      assert.ok(missing instanceof BuildStoreError);
      assert.equal(missing.code, "BUILD_BLOB_MISSING");
      const stats = await store.stats();
      assert.equal(stats.blobCount, 0);
      assert.equal(stats.uncompressedBytes, 0);
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

// ---------------------------------------------------------------------------
// Règle « baux CAS » (extrait rule-baux) : 6 processus × 200 tentatives sur
// la même clé → exactement un gagnant ; bail expiré repris par CAS.
// Sous-processus : test/support/kv-writer.ts, une opération par appel.
// ---------------------------------------------------------------------------

function assertBail(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT baux: ${msg}`);
}

interface LeaseAttemptOutcome {
  readonly successes: number;
  readonly refusals: number;
  readonly errors: Array<Record<string, unknown>>;
}

/** 200 tentatives d'un même propriétaire dans UN processus frais
 * (kv-writer lease --count) : 6 processus au total, pas 1 200 démarrages.
 * Le premier gagnant renouvelle ensuite son bail (même propriétaire) ;
 * aucun bail n'expire (TTL 300 000 ms). */
async function leaseAttempts(
  storePath: string,
  key: string,
  owner: string,
  attempts: number,
): Promise<LeaseAttemptOutcome> {
  const { exitCode, events, stderr } = await runWriter([
    "--config",
    REPO_CONFIG_PATH,
    "--allow-read",
    "--allow-write",
    "--allow-env",
    WRITER_PATH,
    "--store",
    storePath,
    "lease",
    "--key",
    key,
    "--owner",
    owner,
    "--ttl-ms",
    "300000",
    "--count",
    String(attempts),
  ]);
  const errors: Array<Record<string, unknown>> = events
    .filter((e) => e.event === "error")
    .map((e) => e as unknown as Record<string, unknown>);
  const result = events.find((e) => e.event === "result");
  if (result === undefined) {
    if (errors.length === 0) {
      errors.push({ code: exitCode, stderr: stderr.slice(0, 300) });
    }
    return { successes: 0, refusals: 0, errors };
  }
  assertBail(exitCode === 0, `${owner}: ligne result mais exit != 0`);
  return {
    successes: result["successes"] as number,
    refusals: result["refusals"] as number,
    errors,
  };
}

Deno.test("baux CAS : 6 processus x 200 tentatives sur la meme cle, exactement un gagnant", async () => {
  const dir = await Deno.makeTempDir({ prefix: "w2c-baux-race-" });
  try {
    const storePath = `${dir}/cache.kv`;
    const owners = ["p0", "p1", "p2", "p3", "p4", "p5"];
    const results = await Promise.all(
      owners.map((owner) =>
        leaseAttempts(storePath, "leases/race", owner, 200)
      ),
    );
    const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
    assertBail(
      totalErrors === 0,
      `0 erreur codee attendue, obtenu ${totalErrors}: ${
        JSON.stringify(results.flatMap((r) => r.errors).slice(0, 3))
      }`,
    );
    const totalSuccess = results.reduce((n, r) => n + r.successes, 0);
    assertBail(
      totalSuccess === 200,
      `compte exact des succes == 200 attendu, obtenu ${totalSuccess}`,
    );
    const winners = results.filter((r) => r.successes > 0);
    assertBail(
      winners.length === 1,
      `exactement un processus gagnant attendu, obtenu ${winners.length}`,
    );
    assertBail(
      winners[0].successes === 200,
      `le gagnant detient les 200 succes, obtenu ${winners[0].successes}`,
    );
    assertBail(
      winners[0].refusals === 0,
      `le gagnant n'est jamais refuse, obtenu ${winners[0].refusals}`,
    );
    for (const [i, r] of results.entries()) {
      if (r.successes === 0) {
        assertBail(
          r.refusals === 200,
          `${owners[i]}: 200 refus attendus, obtenu ${r.refusals}`,
        );
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("baux CAS : bail expire par expiresAt repris par CAS, ancien detenteur evince", async () => {
  const dir = await Deno.makeTempDir({ prefix: "w2c-baux-handoff-" });
  const store = await KvModelBuildStore.open({ path: `${dir}/cache.kv` });
  try {
    assertBail(
      await store.acquireLease("leases/handoff", "old", 50) === true,
      "old prend le bail libre",
    );
    // Attente reelle bornee au-dela d'expiresAt (50 ms) : 300 ms.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertBail(
      await store.acquireLease("leases/handoff", "new", 60_000) === true,
      "new reprend par CAS le bail expire",
    );
    assertBail(
      await store.acquireLease("leases/handoff", "old", 60_000) === false,
      "l'ancien detenteur est refuse (bail vivant d'un autre), sans erreur",
    );
    await store.releaseLease("leases/handoff", "old"); // non-detenteur : sans effet
    assertBail(
      (await store.stats()).leaseCount === 1,
      "le release de l'ancien detenteur est sans effet : le bail de new subsiste",
    );
    await store.releaseLease("leases/handoff", "new");
    assertBail(
      (await store.stats()).leaseCount === 0,
      "le release du detenteur supprime le bail",
    );
    assertBail(
      await store.acquireLease("leases/handoff", "third", 60_000) === true,
      "le bail est libre a nouveau apres release",
    );
  } finally {
    await closeAndRemove(dir, store);
  }
});

// Tue la mutation « CAS retiré » de façon déterministe : 50 acquireLease
// émis dans la même tick posent tous leur lecture avant tout commit (file
// d'ops KV FIFO) ; seul le check(versionstamp) départage un unique gagnant.
// Sans le CAS, les 50 lectures voient la clé libre et les 50 commits gagnent.
Deno.test("baux CAS : 50 prises concurrentes en processus, exactement un gagnant (CAS)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "w2c-baux-cas-" });
  const store = await KvModelBuildStore.open({ path: `${dir}/cache.kv` });
  try {
    const owners = Array.from({ length: 50 }, (_, i) => `owner-${i}`);
    const results = await Promise.all(
      owners.map((owner) => store.acquireLease("leases/cas", owner, 60_000)),
    );
    const winners = owners.filter((_, i) => results[i]);
    assertBail(
      winners.length === 1,
      `exactement un gagnant attendu, obtenu ${winners.length} : ${winners}`,
    );
    assertBail(
      (await store.stats()).leaseCount === 1,
      "un seul bail stocké après la course",
    );
  } finally {
    await closeAndRemove(dir, store);
  }
});

// ---------------------------------------------------------------------------
// Règle « écriture tuée en plein put » (extrait rule-put-tue, plan W2 règles
// 3 + 8) : SIGKILL pendant store.put → jamais d'octets partiels, orphelins
// balayés à la réouverture, re-put intègre. Unix uniquement.
// ---------------------------------------------------------------------------

/** Charge incompressible déterministe : ~1010 morceaux de 63 000 o une fois
 * compressée, soit une phase d'écriture de plusieurs secondes où le SIGKILL
 * tombe à coup sûr après les premiers morceaux et avant la méta finale. */
const KILLED_BYTES = 64 * 1024 * 1024;
const KILL_SEED = 0xc10c;

/** Octets pseudo-aléatoires déterministes (xorshift32, zéro hasard, zéro
 * temps) ; la sortie est incompressible, contrairement à un motif. */
function payloadBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let state = seed >>> 0 || 1;
  for (let offset = 0; offset < size; offset += 4) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    view.setUint32(offset, state);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WriterEvent {
  event: string;
  step?: unknown;
  detail?: unknown;
  code?: string;
  context?: Record<string, unknown>;
  recovery?: string;
  message?: string;
  [key: string]: unknown;
}

/** Attend la ligne {event:"progress", step:"putting"} : l'enfant est alors
 * entré dans store.put. Rend le digest annoncé dans detail. */
async function waitForPutting(
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<string> {
  const seen = (async () => {
    for await (const event of jsonLines(child.stdout)) {
      if (event.event === "progress" && event.step === "putting") {
        return String(event.detail);
      }
      if (event.event === "error") {
        throw new Error(
          `kv-writer a échoué avant le put : ${JSON.stringify(event)}`,
        );
      }
    }
    throw new Error("kv-writer : stdout fermé avant le put");
  })();
  return await Promise.race([
    seen,
    sleep(timeoutMs).then(() => {
      throw new Error("délai d'attente de l'entrée dans put dépassé");
    }),
  ]);
}

async function* jsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<WriterEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        if (line) yield JSON.parse(line) as WriterEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

Deno.test({
  name:
    "w2c put tué — pas d'octets partiels, orphelins balayés, re-put intègre",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "w2c-put-tue-" });
    const kvPath = join(dir, "cache.kv");
    const payloadFile = join(dir, "payload.bin");
    const bytes = payloadBytes(KILLED_BYTES, KILL_SEED);
    await Deno.writeFile(payloadFile, bytes);
    const expectedDigest = await sha256Hex(bytes);

    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--config",
        REPO_CONFIG_PATH,
        WRITER_PATH,
        "--store",
        kvPath,
        "put-file",
        "--file",
        payloadFile,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    let exited = false;
    child.status.then(() => {
      exited = true;
    });
    const reap = async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Déjà terminé : le statut ci-dessous tranche.
      }
      await child.status;
    };
    try {
      const digest = await waitForPutting(child, 60_000).catch(
        async (error) => {
          await reap();
          throw error;
        },
      );
      assert.equal(digest, expectedDigest);
      // Tuer dès que des morceaux COMMITTÉS sont lisibles par un second
      // handle KV brut (le morceau n°3 existe ⇒ au moins un lot atomique de
      // morceaux est durable, la méta du dernier lot n'existe pas encore).
      // L'ancien critère (croissance des fichiers ≥ 64 Kio) flakait : le WAL
      // sqlite grossit avant le premier commit ⇒ 0 morceau, 0 orphelin.
      const raw = await Deno.openKv(kvPath);
      const probeKey: Deno.KvKey = [
        "build",
        "blob",
        digest,
        "__kv_toolbox_blob__",
        3,
      ];
      const killAt = Date.now() + 120_000;
      let killSent = false;
      try {
        while (Date.now() < killAt) {
          if (exited) {
            await child.status;
            assert.fail(
              "le put s'est terminé avant le SIGKILL : augmenter KILLED_BYTES",
            );
          }
          if ((await raw.get(probeKey)).value !== null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // Tombé entre deux sondages : le statut tranche ci-dessous.
            }
            killSent = true;
            break;
          }
          await sleep(5);
        }
      } finally {
        raw.close();
      }
      if (!killSent) {
        await reap();
        assert.fail("morceaux committés non observés : augmenter KILLED_BYTES");
      }
      const status = await child.status;
      assert.equal(status.success, false);
      assert.equal(status.signal, "SIGKILL");

      // Rouvrir (aucun balayage à l'ouverture), puis sweep() explicite :
      // il supprime les morceaux orphelins du put tué.
      const store = await KvModelBuildStore.open({ path: kvPath });
      try {
        const swept = await store.sweep();
        assert.equal(swept.orphanEntries, 1);
        assert.ok(swept.orphanChunkKeysRemoved >= 1);
        assert.equal(swept.expiredLeasesRemoved, 0);

        // Jamais d'octets partiels : absent proprement, pas de faux présent.
        assert.equal(await store.has(digest), false);
        let code: string | null = null;
        let contextDigest: unknown = null;
        let recovery = "";
        try {
          await store.get(digest);
        } catch (error) {
          assert.ok(error instanceof BuildStoreError);
          code = error.code;
          contextDigest = (error.context as Record<string, unknown>)["digest"];
          recovery = error.recovery;
        }
        assert.equal(code, "BUILD_BLOB_MISSING");
        assert.equal(contextDigest, digest);
        assert.ok(recovery.length > 0);

        const statsBefore = await store.stats();
        // The durable use reservation remains charged after the crash and
        // orphan sweep; freeing it could let a slow concurrent writer spend
        // the same quota twice. Retrying this digest reuses that reservation.
        assert.equal(statsBefore.blobCount, 1);
        assert.equal(statsBefore.uncompressedBytes, KILLED_BYTES);

        // Un nouveau put complet ensuite est intègre, octet pour octet.
        const put = await store.put(digest, bytes);
        assert.equal(put.stored, true);
        assert.equal(put.bytes, KILLED_BYTES);
        assert.equal(put.digest, digest);
        const back = await store.get(digest);
        assert.equal(back.byteLength, KILLED_BYTES);
        assert.equal(await sha256Hex(back), expectedDigest);
        assert.equal(await store.has(digest), true);

        const statsAfter = await store.stats();
        assert.equal(statsAfter.blobCount, 1);
        assert.equal(statsAfter.uncompressedBytes, KILLED_BYTES);

        // Plus rien à balayer : le sweep explicite a tout pris.
        const again = await store.sweep();
        assert.equal(again.orphanEntries, 0);
        assert.equal(again.orphanChunkKeysRemoved, 0);
      } finally {
        await store.close();
      }
    } finally {
      await reap().catch(() => undefined);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Règle « store indisponible » (extrait rule-indisponible) : sous-processus
// SANS le flag KV → BUILD_STORE_UNAVAILABLE codé (exit 6), jamais de
// TypeError nue, aucun fichier créé ; témoin avec le flag → exit 0.
// ---------------------------------------------------------------------------

// Chemins filesystem (pas des file: URLs : --config les refuserait en les
// résolvant comme des chemins relatifs depuis le cwd).
const WRITER_PATH = fileURLToPath(
  new URL("../support/kv-writer.ts", import.meta.url),
);
const REPO_CONFIG_PATH = fileURLToPath(
  new URL("../../deno.json", import.meta.url),
);

/** Config minimale SANS "unstable" : même import map jsr, sans le flag KV. */
const NO_KV_CONFIG = JSON.stringify({
  imports: {
    "@kitsonk/kv-toolbox/blob": "jsr:@kitsonk/kv-toolbox@0.31.0/blob",
  },
});

function parseEventLines(stdout: string): WriterEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WriterEvent);
}

async function runWriter(args: string[]): Promise<{
  exitCode: number;
  events: WriterEvent[];
  stderr: string;
}> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", ...args],
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(120_000),
  });
  const { code, stdout, stderr } = await child.output();
  return {
    exitCode: code,
    events: parseEventLines(new TextDecoder().decode(stdout)),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test({
  name:
    "w2c indisponible — sans flag KV, l'ouverture lève BUILD_STORE_UNAVAILABLE",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "w2c-indisponible-" });
    try {
      const storePath = `${dir}/cache.kv`;
      await Deno.writeTextFile(`${dir}/deno-no-kv.json`, NO_KV_CONFIG);
      const { exitCode, events, stderr } = await runWriter([
        "--config",
        `${dir}/deno-no-kv.json`,
        "--allow-read",
        "--allow-write",
        WRITER_PATH,
        "--store",
        storePath,
        "stats",
      ]);

      // Code de sortie exact de kv-writer pour BUILD_STORE_UNAVAILABLE.
      assert.equal(exitCode, 6);
      // Une seule ligne : l'erreur codée, jamais d'événement "open"/"result"
      // (jamais un faux absent déguisé en succès, jamais de TypeError nue).
      assert.equal(events.length, 1);
      const [only] = events;
      assert.equal(only.event, "error");
      assert.equal(only.code, "BUILD_STORE_UNAVAILABLE");
      assert.equal(only.context?.["reason"], "Deno.openKv is undefined");
      assert.equal(only.context?.["path"], storePath);
      assert.ok(
        typeof only.recovery === "string" && only.recovery.length > 0,
        "recovery non vide",
      );
      assert.ok(
        only.recovery.includes("unstable"),
        "recovery pointe vers le flag manquant",
      );
      assert.ok(
        !stderr.includes("TypeError"),
        `stderr sans TypeError nue : ${stderr}`,
      );
      // L'ouverture ratée ne crée aucun fichier KV.
      let statFailed = false;
      try {
        await Deno.stat(storePath);
      } catch (error) {
        statFailed = error instanceof Deno.errors.NotFound;
      }
      assert.ok(statFailed, "aucun cache.kv créé par l'ouverture ratée");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "w2c indisponible — témoin : avec le flag KV, le même kv-writer ouvre (exit 0)",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "w2c-indisponible-temoin-" });
    try {
      const storePath = `${dir}/cache.kv`;
      const { exitCode, events, stderr } = await runWriter([
        "--config",
        REPO_CONFIG_PATH,
        "--allow-read",
        "--allow-write",
        WRITER_PATH,
        "--store",
        storePath,
        "stats",
      ]);

      // Même binaire, mêmes arguments : seul le flag change. Exit 0 et
      // séquence open → result : l'échec du test précédent vient bien du
      // flag manquant, pas d'un writer ou d'une config cassés.
      assert.equal(stderr, "");
      assert.equal(exitCode, 0);
      assert.equal(events.length, 2);
      assert.equal(events[0].event, "open");
      assert.equal(events[1].event, "result");
      assert.equal(events[1].code, undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Règle « écritures concurrentes » (plan W2c l.653-655, section ajoutée par
// l'intégrateur — aucun extrait ne la couvrait) : 6 processus écrivant mêmes
// et différentes clés, lecteurs qui vérifient le sha256 (0 troncature,
// 0 erreur). Sous-processus kv-writer put/get (même seed + taille = mêmes
// octets, donc même digest : kv-writer.ts deterministicBytes).
// ---------------------------------------------------------------------------

async function writerPut(
  storePath: string,
  seed: number,
  bytes: number,
): Promise<WriterEvent[]> {
  const { exitCode, events, stderr } = await runWriter([
    "--config",
    REPO_CONFIG_PATH,
    "--allow-read",
    "--allow-write",
    "--allow-env",
    WRITER_PATH,
    "--store",
    storePath,
    "put",
    "--seed",
    String(seed),
    "--bytes",
    String(bytes),
  ]);
  assert.equal(stderr, "", `put seed=${seed} : stderr vide attendu`);
  assert.equal(exitCode, 0, `put seed=${seed} : exit 0 attendu`);
  assert.ok(
    events.every((e) => e.event !== "error"),
    `put seed=${seed} : aucune erreur codée, obtenu ${
      JSON.stringify(events.filter((e) => e.event === "error"))
    }`,
  );
  return events;
}

Deno.test({
  name:
    "w2c concurrence — 6 processus mêmes et différentes clés, lecteurs sha256, 0 troncature 0 erreur",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "w2c-concurrence-" });
    try {
      const storePath = `${dir}/cache.kv`;
      // 3 processus même seed (même clé), 3 seeds distincts (clés différentes).
      const seeds = [11, 11, 11, 21, 22, 23];
      const puts = await Promise.all(
        seeds.map((seed) => writerPut(storePath, seed, 8192)),
      );
      const digests = puts.map((events) => {
        const result = events.find((e) => e["event"] === "result");
        assert.ok(result !== undefined, "chaque put rend une ligne result");
        assert.equal(result["ok"], true);
        assert.equal(result["bytes"], 8192);
        assert.equal(typeof result["digest"], "string");
        return result["digest"] as string;
      });
      // Même seed → même digest trois fois ; seeds distincts → digests distincts.
      assert.equal(digests[0], digests[1]);
      assert.equal(digests[1], digests[2]);
      assert.equal(new Set(digests).size, 4);
      // Lecteurs : chaque digest relu vérifie le sha256 (match:true, 0 troncature).
      for (const digest of new Set(digests)) {
        const { exitCode, events } = await runWriter([
          "--config",
          REPO_CONFIG_PATH,
          "--allow-read",
          "--allow-write",
          "--allow-env",
          WRITER_PATH,
          "--store",
          storePath,
          "get",
          "--digest",
          digest,
        ]);
        assert.equal(exitCode, 0, `get ${digest.slice(0, 12)}… : exit 0`);
        const result = events.find((e) => e["event"] === "result");
        assert.ok(result !== undefined, "le get rend une ligne result");
        assert.equal(result["match"], true, "sha256 relu == digest demandé");
        assert.equal(result["bytes"], 8192, "0 troncature");
      }
      // Compte exact : 1 blob partagé + 3 distincts.
      const store = await KvModelBuildStore.open({ path: storePath });
      try {
        assert.equal((await store.stats()).blobCount, 4);
      } finally {
        await store.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Mesures de réception (plan W2c l.659-660, section ajoutée par
// l'intégrateur, clairement séparée des tests par règle) : put vérifié,
// lecture de A et débit 6 processus sont mesurés et consignés
// (console.log), sans assertion de durée : sur machine partagée, les
// seuils temps réel flakent ; seules les assertions de justesse comptent.
// ---------------------------------------------------------------------------

/** A réaliste déterministe : ~12,2 Mo bruts JSON, ~0,94 Mo en zstd-3
 * (ratio ~13, 15 morceaux, plusieurs lots atomiques), comme le A du plan
 * (12,2 Mo bruts / 649 Ko zstd, 11 morceaux). Générateur xorshift seedé
 * par `tag` : ids pseudo-aléatoires + texte répété. */
function representativeArtifactA(
  targetBytes = 12_200_000,
  tag = "reception",
): Uint8Array {
  let state = 0x243f6a88;
  for (let i = 0; i < tag.length; i++) {
    state ^= tag.charCodeAt(i);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  const rnd = (): number => {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state >>> 0;
  };
  const text =
    "semantic relationship endpoint property typed value origin model element ";
  const elements: string[] = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const hex = Array.from(
      { length: 28 },
      () => rnd().toString(16).padStart(8, "0"),
    ).join("");
    const el = `element-${i}-${hex} ` + text.repeat(20) + `tail-${i % 997}`;
    elements.push(el);
    size += el.length + 3;
    i++;
  }
  const json = JSON.stringify({
    provider: `w2c-${tag}`,
    engineVersion: "1",
    elements,
  });
  return new TextEncoder().encode(json);
}

Deno.test({
  name: "w2c réception — put de A mesuré, sans seuil (plan W2c l.659-660)",
  async fn() {
    const { store, dir } = await openTempStore("w2c-reception-put-");
    try {
      // Échauffement hors mesure (JIT, pages SQLite, contexte zstd) : un put
      // d'un autre blob, non chronométré. La mesure porte sur des puts de A
      // en régime établi, comme les 1,5 ms du plan (l.475).
      const warm = patternBytes(4096, 1);
      await store.put(await sha256Hex(warm), warm);
      // 5 variantes de A réaliste (digests distincts, donc 5 vrais chemins
      // d'écriture) ; médiane consignée, jamais assertée.
      const samples: number[] = [];
      let octets = 0;
      for (let v = 0; v < 5; v++) {
        const bytes = representativeArtifactA(12_200_000, `reception-put-${v}`);
        octets = bytes.byteLength;
        const digest = await sha256Hex(bytes);
        const t0 = performance.now();
        const put = await store.put(digest, bytes);
        samples.push(performance.now() - t0);
        assert.equal(
          put.stored,
          true,
          `variante ${v} : vrai chemin d'écriture`,
        );
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[2];
      console.log(JSON.stringify({
        mesure: "w2c-reception-put-A",
        octets,
        variantes: 5,
        msEchantillons: samples.map((s) => Math.round(s * 100) / 100),
        msMediane: Math.round(median * 100) / 100,
      }));
      // Mesure consignée, non assertée (machine partagée).
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

Deno.test({
  name: "w2c réception — lecture et analyse de A mesurées, sans seuil",
  async fn() {
    const bytes = representativeArtifactA();
    const digest = await sha256Hex(bytes);
    const { store, dir } = await openTempStore("w2c-reception-lecture-");
    try {
      const put = await store.put(digest, bytes);
      assert.equal(put.stored, true);
      const t0 = performance.now();
      const got = await store.get(digest);
      const actual = await sha256Hex(got); // « analyse » : re-digest vérifié
      const ms = performance.now() - t0;
      console.log(JSON.stringify({
        mesure: "w2c-reception-lecture-analyse-A",
        octets: got.byteLength,
        ms: Math.round(ms * 100) / 100,
      }));
      assert.equal(got.byteLength, bytes.byteLength);
      assert.equal(actual, digest);
      // Mesure consignée, non assertée (machine partagée).
    } finally {
      await closeAndRemove(dir, store);
    }
  },
});

Deno.test({
  name: "w2c réception — 6 processus, débit mesuré sans seuil, sans erreur",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "w2c-reception-debit-" });
    try {
      const storePath = `${dir}/cache.kv`;
      const COUNT_PER_PROCESS = 25;
      const seeds = [101, 102, 103, 104, 105, 106];
      const t0 = performance.now();
      const runs = await Promise.all(
        seeds.map((seed) =>
          runWriter([
            "--config",
            REPO_CONFIG_PATH,
            "--allow-read",
            "--allow-write",
            "--allow-env",
            WRITER_PATH,
            "--store",
            storePath,
            "loop-put",
            "--seed",
            String(seed),
            "--bytes",
            "4096",
            "--count",
            String(COUNT_PER_PROCESS),
          ])
        ),
      );
      const ms = performance.now() - t0;
      // 0 erreur codée, chaque processus rend ses 25 puts + la ligne result.
      const digests: string[] = [];
      for (const [i, run] of runs.entries()) {
        assert.equal(run.exitCode, 0, `processus ${i} : exit 0`);
        assert.ok(
          run.events.every((e) => e.event !== "error"),
          `processus ${i} : 0 erreur, obtenu ${
            JSON.stringify(run.events.filter((e) => e.event === "error"))
          }`,
        );
        const progresses = run.events.filter((e) => e.event === "progress");
        assert.equal(
          progresses.length,
          COUNT_PER_PROCESS,
          `processus ${i} : 25 puts constatés`,
        );
        for (const p of progresses) {
          assert.equal(typeof p["digest"], "string");
          digests.push(p["digest"] as string);
        }
        const done = run.events.find((e) =>
          e.event === "result" && e["command"] === "loop-put"
        );
        assert.ok(done !== undefined, `processus ${i} : ligne result loop-put`);
        assert.equal(done["ok"], true);
      }
      assert.equal(digests.length, 150);
      assert.equal(new Set(digests).size, 150, "150 artefacts distincts");
      const rate = 150 / (ms / 1000);
      console.log(JSON.stringify({
        mesure: "w2c-reception-debit-6-processus",
        artefacts: 150,
        processus: 6,
        ms: Math.round(ms * 100) / 100,
        artefactsParSeconde: Math.round(rate * 10) / 10,
      }));
      // Mesure consignée, non assertée (machine partagée).
      // Lecteurs : échantillon relu en processus, sha256 vérifié.
      const store = await KvModelBuildStore.open({ path: storePath });
      try {
        assert.equal((await store.stats()).blobCount, 150); // fin réception
        for (const digest of [digests[0], digests[74], digests[149]]) {
          const got = await store.get(digest);
          assert.equal(got.byteLength, 4096);
          assert.equal(await sha256Hex(got), digest);
        }
      } finally {
        await store.close();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// Couverture ajoutée après contradicteur : F3 (règles 2 sortie, 3 has,
// 6 retryBusy), F6 (projections, sweep proj, bail expiré, quota, use),
// réparation MISSING, J1 (sweep concurrent), erreurs codées.
// ---------------------------------------------------------------------------

async function openStoreWith(
  opts: { quotaBytes?: number; now?: () => number },
): Promise<{ store: KvModelBuildStore; dir: string; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "w2c-extra-" });
  const path = `${dir}/cache.kv`;
  const store = await KvModelBuildStore.open({ path, ...opts });
  return { store, dir, path };
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no-error";
  } catch (e) {
    return e instanceof BuildStoreError ? e.code : String(e);
  }
}

Deno.test("w2c F3 règle 2 sortie — octets stockés == meta.size == zstd", async () => {
  const { store, dir, path } = await openStoreWith({});
  try {
    const bytes = patternBytes(4096, 5);
    const digest = await sha256Hex(bytes);
    await store.put(digest, bytes);
    const raw = await Deno.openKv(path);
    try {
      let sum = 0;
      for await (const e of raw.list({ prefix: ["build", "blob", digest] })) {
        if (e.key[3] === BLOB_KEY && e.value instanceof Uint8Array) {
          sum += e.value.byteLength;
        }
      }
      const meta = await getMeta(raw, ["build", "blob", digest]);
      assert.ok(meta.value !== null);
      assert.equal(sum, meta.value.size);
      assert.equal(sum, compressLikeAdapter(bytes).byteLength);
    } finally {
      raw.close();
    }
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F3 règle 3 — morceau sans méta après open : has false, get MISSING", async () => {
  const { store, dir, path } = await openStoreWith({});
  try {
    const raw = await Deno.openKv(path);
    try {
      await raw.set(
        ["build", "blob", NEVER_WRITTEN_A, BLOB_KEY, 0],
        new Uint8Array(10).buffer,
      );
    } finally {
      raw.close();
    }
    assert.equal(await store.has(NEVER_WRITTEN_A), false);
    assert.equal(
      await errorCode(store.get(NEVER_WRITTEN_A)),
      "BUILD_BLOB_MISSING",
    );
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F3 règle 6 — retryBusy reprend sur database is locked, rend les autres erreurs", async () => {
  let calls = 0;
  const okVal = await retryBusy(() => {
    calls++;
    if (calls <= 3) throw new Error("database is locked");
    return Promise.resolve("ok");
  });
  assert.equal(okVal, "ok");
  assert.equal(calls, 4);
  let other = 0;
  const err = await retryBusy(() => {
    other++;
    throw new Error("boom");
  }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error && err.message === "boom");
  assert.equal(other, 1);
});

Deno.test("w2c réparation — méta sans morceaux : put réécrit, get exact", async () => {
  const { store, dir, path } = await openStoreWith({});
  try {
    const bytes = patternBytes(5000, 7);
    const digest = await sha256Hex(bytes);
    await store.put(digest, bytes);
    const raw = await Deno.openKv(path);
    try {
      for await (const e of raw.list({ prefix: ["build", "blob", digest] })) {
        if (e.key[3] === BLOB_KEY) await raw.delete(e.key);
      }
    } finally {
      raw.close();
    }
    assert.equal(await store.has(digest), true);
    assert.equal(await errorCode(store.get(digest)), "BUILD_BLOB_MISSING");
    assert.equal((await store.put(digest, bytes)).stored, true);
    assert.equal(await sha256Hex(await store.get(digest)), digest);
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F6 projection — aller-retour, idempotence, conflit, méta altérée", async () => {
  const { store, dir, path } = await openStoreWith({});
  try {
    const b = patternBytes(5000, 1);
    assert.equal(
      (await store.putProjection("k", "v1", NEVER_WRITTEN_A, b)).stored,
      true,
    );
    assert.deepEqual(await store.getProjection("k", "v1", NEVER_WRITTEN_A), b);
    assert.equal(await store.hasProjection("k", "v1", NEVER_WRITTEN_A), true);
    assert.equal(
      (await store.putProjection("k", "v1", NEVER_WRITTEN_A, b)).stored,
      false,
    );
    assert.equal((await store.stats()).projectionCount, 1);
    assert.equal(
      await errorCode(
        store.putProjection("k", "v1", NEVER_WRITTEN_A, patternBytes(5000, 2)),
      ),
      "BUILD_BLOB_CONFLICT",
    );
    const raw = await Deno.openKv(path);
    try {
      const m = await raw.get<{ bytes: number; sha256: string; at: number }>(
        ["proj-meta", "k", "v1", NEVER_WRITTEN_A],
      );
      await raw.set(["proj-meta", "k", "v1", NEVER_WRITTEN_A], {
        ...m.value!,
        sha256: "0".repeat(64),
      });
      assert.equal(
        await errorCode(store.getProjection("k", "v1", NEVER_WRITTEN_A)),
        "BUILD_BLOB_CORRUPT",
      );
      await raw.set(["proj-meta", "k", "v1", NEVER_WRITTEN_A], {
        ...m.value!,
        bytes: m.value!.bytes + 1,
      });
      assert.equal(
        await errorCode(store.getProjection("k", "v1", NEVER_WRITTEN_A)),
        "BUILD_BLOB_CORRUPT",
      );
    } finally {
      raw.close();
    }
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c réparation projection — morceau inversé : putProjection réécrit", async () => {
  const { store, dir, path } = await openStoreWith({});
  try {
    const b = patternBytes(5000, 3);
    await store.putProjection("k", "v1", NEVER_WRITTEN_A, b);
    const raw = await Deno.openKv(path);
    try {
      const metadata = await raw.get<{ blobDigest?: string }>([
        "proj-meta",
        "k",
        "v1",
        NEVER_WRITTEN_A,
      ]);
      const physical = metadata.value?.blobDigest
        ? ["proj-bytes", metadata.value.blobDigest]
        : ["proj", "k", "v1", NEVER_WRITTEN_A];
      let corrupted = false;
      for await (const e of raw.list({ prefix: physical })) {
        if (
          e.key[physical.length] === BLOB_KEY && e.value instanceof Uint8Array
        ) {
          const mut = new Uint8Array(e.value);
          mut[10] ^= 0xff;
          await raw.set(e.key, mut);
          corrupted = true;
          break;
        }
      }
      assert.ok(corrupted, "a real stored projection chunk must be corrupted");
    } finally {
      raw.close();
    }
    assert.equal(
      await errorCode(store.getProjection("k", "v1", NEVER_WRITTEN_A)),
      "BUILD_BLOB_CORRUPT",
    );
    assert.equal(
      (await store.putProjection("k", "v1", NEVER_WRITTEN_A, b)).stored,
      true,
    );
    assert.deepEqual(await store.getProjection("k", "v1", NEVER_WRITTEN_A), b);
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F6 sweep — morceaux de projection orphelins", async () => {
  const { store, dir, path } = await openStoreWith({});
  try {
    const raw = await Deno.openKv(path);
    try {
      await raw.set(
        ["proj", "k", "v1", NEVER_WRITTEN_A, BLOB_KEY, 0],
        new Uint8Array(10).buffer,
      );
    } finally {
      raw.close();
    }
    const r = await store.sweep();
    assert.equal(r.orphanEntries, 1);
    assert.equal(r.orphanChunkKeysRemoved, 1);
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F6 sweep — bail expiré supprimé sous CAS", async () => {
  let t = 1_000_000;
  const { store, dir } = await openStoreWith({ now: () => t });
  try {
    assert.equal(await store.acquireLease("L", "a", 1000), true);
    assert.equal((await store.stats()).leaseCount, 1);
    t += 5000;
    const r = await store.sweep();
    assert.equal(r.expiredLeasesRemoved, 1);
    assert.equal((await store.stats()).leaseCount, 0);
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F6 quota refusé pour put et putProjection", async () => {
  const { store, dir } = await openStoreWith({ quotaBytes: 1000 });
  try {
    const b1 = patternBytes(600, 1);
    const b2 = patternBytes(600, 2);
    await store.put(await sha256Hex(b1), b1);
    assert.equal(
      await errorCode(store.put(await sha256Hex(b2), b2)),
      "BUILD_STORE_QUOTA_EXCEEDED",
    );
    assert.equal(
      await errorCode(store.putProjection("k", "v1", NEVER_WRITTEN_A, b2)),
      "BUILD_STORE_QUOTA_EXCEEDED",
    );
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c F6 use — get n'écrit plus, put au plus une écriture par heure", async () => {
  let t = 1_000_000;
  const { store, dir, path } = await openStoreWith({ now: () => t });
  try {
    const b = patternBytes(100, 3);
    const d = await sha256Hex(b);
    await store.put(d, b);
    const raw = await Deno.openKv(path);
    try {
      const at0 = (await raw.get<{ at: number }>(["use", d])).value!.at;
      t += 3_600_000;
      await store.get(d);
      assert.equal((await raw.get<{ at: number }>(["use", d])).value!.at, at0);
      await store.put(d, b);
      assert.equal((await raw.get<{ at: number }>(["use", d])).value!.at, t);
    } finally {
      raw.close();
    }
  } finally {
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c J1 — put de 3 Mo pendant sweep() en boucle : jamais stored:true puis get en échec", async () => {
  const { store, dir, path } = await openStoreWith({});
  const other = await KvModelBuildStore.open({ path });
  try {
    const bytes = payloadBytes(3 * 1024 * 1024, 0xbeef);
    const digest = await sha256Hex(bytes);
    let settled = false;
    const putPromise = store.put(digest, bytes).then(
      (result) => {
        settled = true;
        return { ok: true as const, result };
      },
      (error) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    while (!settled) await other.sweep();
    const outcome = await putPromise;
    if (outcome.ok) {
      assert.equal(outcome.result.stored, true);
      assert.equal(await sha256Hex(await store.get(digest)), digest);
    } else {
      assert.ok(outcome.error instanceof BuildStoreError);
    }
  } finally {
    await other.close();
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c J4 — sweep concurrent ne supprime jamais un bail repris par CAS", async () => {
  const { store, dir, path } = await openStoreWith({});
  const other = await KvModelBuildStore.open({ path });
  try {
    const raw = await Deno.openKv(path);
    try {
      for (let round = 0; round < 50; round++) {
        await raw.set(["lease", "race"], {
          expiresAt: Date.now() - 1000,
          owner: "old",
        });
        const [_, acquired] = await Promise.all([
          other.sweep(),
          store.acquireLease("race", "Y", 60_000),
        ]);
        if (acquired) {
          const after = await raw.get(["lease", "race"]);
          assert.ok(
            after.value !== null,
            `round ${round}: bail repris par Y supprimé par sweep`,
          );
          await store.releaseLease("race", "Y");
        }
      }
    } finally {
      raw.close();
    }
  } finally {
    await other.close();
    await closeAndRemove(dir, store);
  }
});

Deno.test("w2c erreurs — close idempotent, bail mal formé en INVALID_INPUT", async () => {
  const { store, dir } = await openStoreWith({});
  try {
    assert.equal(
      await errorCode(store.acquireLease("", "o", 100)),
      "BUILD_STORE_INVALID_INPUT",
    );
    assert.equal(
      await errorCode(store.acquireLease("k", "o", 0)),
      "BUILD_STORE_INVALID_INPUT",
    );
  } finally {
    await store.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
