// The Nomic model artifact the deployments embed with, identified by its
// Ollama manifest digest (the mutable tag alone is not an identity). Shared by
// the runtime probe, the vector fingerprint and the Ollama early-warning
// runner, which prints it with:
//   deno run scripts/nomic_pin.ts
export const NOMIC_MODEL = "nomic-embed-text:latest";
export const NOMIC_MANIFEST_DIGEST =
  "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f";

if (import.meta.main) {
  console.log(
    JSON.stringify({ model: NOMIC_MODEL, digest: NOMIC_MANIFEST_DIGEST }),
  );
}
