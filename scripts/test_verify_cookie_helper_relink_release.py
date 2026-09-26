import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "scripts/verify-cookie-helper-relink-release.py"
SPEC = importlib.util.spec_from_file_location("relink_verifier", MODULE)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)
TAG = "v0.6.43"
COMMIT = "a" * 40


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_tar(path, entries):
    with tarfile.open(path, "w:gz") as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))


class RelinkReleaseVerifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.license = (ROOT / "LICENSES/JavaScriptCore-LGPL-2.0.txt").read_bytes()
        self.tinycc_license = (ROOT / "LICENSES/TinyCC-LGPL-2.1.txt").read_bytes()
        self.proof_patch = b"modified JSC source patch"
        kit = self.directory / "sources.tar.gz"
        kit_entries = {
            "kit/Bun/LICENSE.md": b"Bun license",
            "kit/Bun/CMakeLists.txt": b"Bun build",
            "kit/Bun/scripts/build.mjs": b"Bun build script",
            "kit/Bun/cmake/targets/BuildTinyCC.cmake": b"TinyCC build source",
            "kit/Bun/vendor/tinycc/libtcc.c": b"TinyCC vendor source",
            "kit/WebKit/mac-release.bash": b"WebKit build script",
            "kit/WebKit/Source/JavaScriptCore/COPYING.LIB": self.license,
            "kit/WebKit/Source/JavaScriptCore/runtime/DateConstructor.cpp": b"Date.now source",
            "kit/TinyCC/COPYING": self.tinycc_license,
            "kit/TinyCC/libtcc.c": b"TinyCC source",
            "kit/OpenUsage/node_modules/@steipete/sweet-cookie/package.json": b'{"version":"0.4.1"}',
            "kit/OpenUsage/node_modules/@steipete/sweet-cookie/dist/index.js": b"export {}",
            "kit/OpenUsage/node_modules/@steipete/sweet-cookie/LICENSE": b"MIT",
            "kit/README.md": b"relink instructions",
            "kit/relink.sh": b"#!/bin/sh\n",
            "kit/proof/modified-jsc.patch": self.proof_patch,
            "kit/proof/probe-date.mjs": b"console.log(Date.now())\n",
        }
        helper_sources = [Path("package.json"), Path("bun.lock")]
        helper_sources.extend(source.relative_to(ROOT) for source in sorted((ROOT / "tools/cookie-helper").glob("*.mjs")))
        for relative in helper_sources:
            kit_entries[f"kit/OpenUsage/{relative.as_posix()}"] = (ROOT / relative).read_bytes()
        write_tar(kit, kit_entries)
        self.manifest = {
            "schemaVersion": 1,
            "tag": TAG,
            "commit": COMMIT,
            "distributionMethods": {
                "WebKit": "LGPL-2.0-section-6c",
                "TinyCC": "LGPL-2.1-section-6d",
            },
            "bunCommit": verifier.BUN_COMMIT,
            "webkitCommit": verifier.WEBKIT_COMMIT,
            "tinyccCommit": verifier.TINYCC_COMMIT,
            "sourceKit": {"name": kit.name, "sha256": sha(kit.read_bytes())},
            "targets": {},
        }
        for target, name in verifier.TARGET_ARCHIVES.items():
            helper = f"helper-{target}".encode()
            app = self.directory / name
            write_tar(app, {
                "OpenUsageCN.app/Contents/MacOS/openusage-cookie-helper": helper,
                "OpenUsageCN.app/Contents/Resources/JavaScriptCore-LGPL-2.0.txt": self.license,
                "OpenUsageCN.app/Contents/Resources/TinyCC-LGPL-2.1.txt": self.tinycc_license,
                "OpenUsageCN.app/Contents/Resources/THIRD_PARTY_NOTICES.md": b"Bun 1.3.6 JavaScriptCore TinyCC",
            })
            proof = self.directory / f"proof-{target}.json"
            proof.write_text(json.dumps({
                "bunCommit": verifier.BUN_COMMIT,
                "webkitCommit": verifier.WEBKIT_COMMIT,
                "tinyccCommit": verifier.TINYCC_COMMIT,
                "target": target,
                "sourceBuiltBunSha256": "1" * 64,
                "modifiedJscPatchSha256": sha(self.proof_patch),
                "modifiedJscRelinkPassed": True,
                "modifiedRuntimeProbePassed": True,
                "modifiedRuntimeProbeOutput": "42424242",
                "modifiedHelperSmokePassed": True,
                "toolchain": {"llvm": "22.1.7"},
            }))
            log = self.directory / f"log-{target}.txt"
            log.write_text("source build and modified-JSC relink log\n")
            self.manifest["targets"][target] = {
                "archiveName": name,
                "buildBunRevision": "1.3.6+d530ed993",
                "archiveSha256": sha(app.read_bytes()),
                "packagedHelperSha256": sha(helper),
                "proof": {"name": proof.name, "sha256": sha(proof.read_bytes())},
                "relinkLog": {"name": log.name, "sha256": sha(log.read_bytes())},
            }
        self.save_manifest()

    def save_manifest(self):
        (self.directory / "cookie-helper-relink-manifest.json").write_text(json.dumps(self.manifest))

    def test_accepts_matched_source_proof_and_both_packages(self):
        verifier.verify(self.directory, TAG, COMMIT)

    def test_rejects_a_package_that_does_not_match_the_manifest(self):
        archive = self.directory / verifier.TARGET_ARCHIVES["aarch64-apple-darwin"]
        with archive.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            verifier.verify(self.directory, TAG, COMMIT)

    def test_rejects_a_missing_architecture_proof(self):
        self.manifest["targets"].pop("x86_64-apple-darwin")
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "exactly both macOS architectures"):
            verifier.verify(self.directory, TAG, COMMIT)

    def test_rejects_an_incomplete_packaged_license_even_with_updated_archive_hash(self):
        target = "aarch64-apple-darwin"
        archive = self.directory / verifier.TARGET_ARCHIVES[target]
        write_tar(archive, {
            "OpenUsageCN.app/Contents/MacOS/openusage-cookie-helper": f"helper-{target}".encode(),
            "OpenUsageCN.app/Contents/Resources/JavaScriptCore-LGPL-2.0.txt": b"LGPL heading only",
            "OpenUsageCN.app/Contents/Resources/TinyCC-LGPL-2.1.txt": self.tinycc_license,
            "OpenUsageCN.app/Contents/Resources/THIRD_PARTY_NOTICES.md": b"Bun 1.3.6 JavaScriptCore TinyCC",
        })
        self.manifest["targets"][target]["archiveSha256"] = sha(archive.read_bytes())
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "Packaged LGPL copy mismatch"):
            verifier.verify(self.directory, TAG, COMMIT)


if __name__ == "__main__":
    unittest.main()
