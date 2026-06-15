import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const PUBLIC_KEY_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const CONFIG_PATH = "src-tauri/tauri.conf.json"
const BUNDLE_ROOT = "src-tauri/target"

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readBase64Text(value, label) {
  const encoded = String(value || "").trim()
  if (!encoded) fail(`Missing ${label}`)
  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  if (!decoded.startsWith("untrusted comment: ")) {
    fail(`${label} is not a base64-encoded minisign text block`)
  }
  return decoded
}

function parsePublicKey() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  const pubkeyText = readBase64Text(config.plugins?.updater?.pubkey, "updater pubkey")
  const lines = pubkeyText.trim().split(/\r?\n/)
  if (lines.length < 2) fail("updater pubkey is missing its key line")

  const bytes = Buffer.from(lines[1].trim(), "base64")
  if (bytes.length !== 42) fail(`updater pubkey has invalid length: ${bytes.length}`)

  const algorithm = bytes.subarray(0, 2).toString("ascii")
  if (algorithm !== "Ed" && algorithm !== "ED") {
    fail(`updater pubkey uses unsupported algorithm: ${algorithm}`)
  }

  return {
    keyId: bytes.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([PUBLIC_KEY_DER_PREFIX, bytes.subarray(10, 42)]),
      format: "der",
      type: "spki",
    }),
  }
}

function parseSignature(signaturePath) {
  const signatureText = readBase64Text(readFileSync(signaturePath, "utf8"), signaturePath)
  const lines = signatureText.trim().split(/\r?\n/)
  if (lines.length < 4) fail(`${signaturePath} is missing minisign signature lines`)
  if (!lines[2].startsWith("trusted comment: ")) {
    fail(`${signaturePath} is missing the trusted comment line`)
  }

  const signatureBytes = Buffer.from(lines[1].trim(), "base64")
  if (signatureBytes.length !== 74) {
    fail(`${signaturePath} has invalid signature length: ${signatureBytes.length}`)
  }

  const globalSignature = Buffer.from(lines[3].trim(), "base64")
  if (globalSignature.length !== 64) {
    fail(`${signaturePath} has invalid global signature length: ${globalSignature.length}`)
  }

  const algorithm = signatureBytes.subarray(0, 2).toString("ascii")
  if (algorithm !== "Ed" && algorithm !== "ED") {
    fail(`${signaturePath} uses unsupported algorithm: ${algorithm}`)
  }

  return {
    algorithm,
    keyId: signatureBytes.subarray(2, 10),
    signature: signatureBytes.subarray(10, 74),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature,
  }
}

function findUpdaterArchives(dir) {
  if (!existsSync(dir)) return []

  const archives = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      archives.push(...findUpdaterArchives(path))
    } else if (path.endsWith(".app.tar.gz")) {
      archives.push(path)
    }
  }
  return archives
}

function buffersEqual(a, b) {
  return a.length === b.length && a.equals(b)
}

function verifyArchive(publicKey, archivePath) {
  const signaturePath = `${archivePath}.sig`
  if (!existsSync(signaturePath)) fail(`Missing updater signature: ${signaturePath}`)

  const signature = parseSignature(signaturePath)
  if (!buffersEqual(publicKey.keyId, signature.keyId)) {
    fail(`${signaturePath} was signed by a different updater key`)
  }

  const archive = readFileSync(archivePath)
  const signedPayload =
    signature.algorithm === "ED" ? createHash("blake2b512").update(archive).digest() : archive

  if (!verifySignature(null, signedPayload, publicKey.key, signature.signature)) {
    fail(`${signaturePath} does not verify against ${CONFIG_PATH}`)
  }

  const trustedPayload = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8"),
  ])
  if (!verifySignature(null, trustedPayload, publicKey.key, signature.globalSignature)) {
    fail(`${signaturePath} trusted comment does not verify against ${CONFIG_PATH}`)
  }

  console.log(`Verified updater signature: ${archivePath}`)
}

const publicKey = parsePublicKey()
const archives = findUpdaterArchives(BUNDLE_ROOT)
if (archives.length === 0) {
  fail(`No updater archives found under ${BUNDLE_ROOT}`)
}

for (const archive of archives) {
  verifyArchive(publicKey, archive)
}
