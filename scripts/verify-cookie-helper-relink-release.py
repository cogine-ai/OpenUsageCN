#!/usr/bin/env python3
"""Block publication unless both macOS packages have matching relink materials."""

import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

BUN_COMMIT = "d530ed993d62be7c7f8f01a3d52627b6845dfd93"
WEBKIT_COMMIT = "1d0216219a3c52cb85195f48f19ba7d5db747ff7"
TINYCC_COMMIT = "29985a3b59898861442fa3b43f663fc1af2591d7"
LGPL_SHA256 = "5094ecb9c9dcd0eadc34f3c11511d9b5535063032bc150164ecd1a5d5a445547"
TINYCC_LICENSE_SHA256 = "512d2d21b6b3384ba64781abb0208a1b87740bc31e2df48e2b206ddb7e4d5779"
TARGET_ARCHIVES = {
    "aarch64-apple-darwin": "OpenUsageCN_aarch64.app.tar.gz",
    "x86_64-apple-darwin": "OpenUsageCN_x64.app.tar.gz",
}
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def asset(directory, name):
    require(isinstance(name, str) and Path(name).name == name, "Invalid asset name")
    file = directory / name
    require(file.is_file(), f"Missing release asset: {name}")
    return file


def digest(stream):
    sha = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        sha.update(block)
    return sha.hexdigest()


def verify_hash(file, expected):
    require(isinstance(expected, str) and SHA256.fullmatch(expected), f"Invalid SHA-256 for {file.name}")
    with file.open("rb") as stream:
        require(digest(stream) == expected, f"SHA-256 mismatch: {file.name}")


def archive_member(archive, suffix):
    matches = [member for member in archive if member.isfile() and member.name.endswith(suffix)]
    require(len(matches) == 1, f"Expected one {suffix} in {archive.name}; found {len(matches)}")
    return matches[0]


def verify_source_kit(file):
    with tarfile.open(file, "r:gz") as archive:
        proof_patch_hash = None
        release_files = {
            "README.md": "scripts/relink-kit/README.md",
            "relink.sh": "scripts/relink-kit/relink.sh",
            "proof/modified-jsc.patch": "scripts/relink-kit/modified-jsc.patch",
            "proof/bun-use-bundled-vendor.patch": "scripts/relink-kit/bun-use-bundled-vendor.patch",
            "proof/probe-date.mjs": "scripts/relink-kit/probe-date.mjs",
        }
        for suffix in (
            "Bun/LICENSE.md",
            "Bun/CMakeLists.txt",
            "Bun/.git/HEAD",
            "Bun/scripts/build.mjs",
            "Bun/cmake/scripts/GitClone.cmake",
            "Bun/cmake/targets/BuildTinyCC.cmake",
            "Bun/vendor/tinycc/libtcc.c",
            "WebKit/mac-release.bash",
            "WebKit/Source/JavaScriptCore/COPYING.LIB",
            "WebKit/Source/JavaScriptCore/runtime/DateConstructor.cpp",
            "TinyCC/COPYING",
            "TinyCC/libtcc.c",
            "OpenUsage/node_modules/@steipete/sweet-cookie/package.json",
            "OpenUsage/node_modules/@steipete/sweet-cookie/dist/index.js",
            "OpenUsage/node_modules/@steipete/sweet-cookie/LICENSE",
            "README.md",
            "relink.sh",
            "proof/modified-jsc.patch",
            "proof/bun-use-bundled-vendor.patch",
            "proof/probe-date.mjs",
        ):
            matches = [member for member in archive if member.isfile() and member.name == f"kit/{suffix}"]
            require(len(matches) == 1, f"Source kit is missing kit/{suffix}")
            member = matches[0]
            if suffix.endswith("COPYING.LIB"):
                with archive.extractfile(member) as stream:
                    require(digest(stream) == LGPL_SHA256, "Source kit LGPL copy differs from pinned WebKit")
            if suffix.endswith("TinyCC/COPYING"):
                with archive.extractfile(member) as stream:
                    require(digest(stream) == TINYCC_LICENSE_SHA256,
                            "Source kit LGPL copy differs from pinned TinyCC")
            if suffix.endswith("proof/modified-jsc.patch"):
                with archive.extractfile(member) as stream:
                    proof_patch_hash = digest(stream)
            if suffix in release_files:
                with archive.extractfile(member) as stream, \
                        (REPOSITORY_ROOT / release_files[suffix]).open("rb") as local:
                    require(digest(stream) == digest(local),
                            f"Source kit {suffix} does not match this release")
            if suffix.endswith("sweet-cookie/package.json"):
                with archive.extractfile(member) as stream:
                    dependency = json.load(stream)
                require(dependency.get("version") == "0.4.1",
                        "Source kit contains the wrong sweet-cookie package")
        helper_sources = [Path("package.json"), Path("bun.lock")]
        helper_sources.extend(
            source.relative_to(REPOSITORY_ROOT)
            for source in sorted((REPOSITORY_ROOT / "tools/cookie-helper").glob("*.mjs"))
        )
        for relative in helper_sources:
            matches = [member for member in archive if member.isfile() and
                       member.name == f"kit/OpenUsage/{relative.as_posix()}"]
            require(len(matches) == 1, f"Source kit is missing OpenUsage/{relative}")
            with archive.extractfile(matches[0]) as stream, (REPOSITORY_ROOT / relative).open("rb") as local:
                require(digest(stream) == digest(local),
                        f"Source kit OpenUsage/{relative} does not match this release")
        return proof_patch_hash


def verify_app_archive(file, expected_helper_hash):
    require(isinstance(expected_helper_hash, str) and SHA256.fullmatch(expected_helper_hash),
            "Invalid packaged helper SHA-256")
    with tarfile.open(file, "r:gz") as archive:
        helper = archive_member(archive, "Contents/MacOS/openusage-cookie-helper")
        license_copy = archive_member(archive, "JavaScriptCore-LGPL-2.0.txt")
        tinycc_license_copy = archive_member(archive, "TinyCC-LGPL-2.1.txt")
        notices = archive_member(archive, "THIRD_PARTY_NOTICES.md")
        with archive.extractfile(helper) as stream:
            require(digest(stream) == expected_helper_hash, f"Packaged helper mismatch: {file.name}")
        with archive.extractfile(license_copy) as stream:
            require(digest(stream) == LGPL_SHA256, f"Packaged LGPL copy mismatch: {file.name}")
        with archive.extractfile(tinycc_license_copy) as stream:
            require(digest(stream) == TINYCC_LICENSE_SHA256,
                    f"Packaged TinyCC LGPL copy mismatch: {file.name}")
        with archive.extractfile(notices) as stream:
            notice = stream.read().decode("utf-8")
        require("JavaScriptCore" in notice and "TinyCC" in notice and "Bun 1.3.6" in notice,
                f"Missing prominent cookie helper notice: {file.name}")


def verify_proof(file, target, manifest, proof_patch_hash):
    proof = json.loads(file.read_text("utf-8"))
    for key in ("bunCommit", "webkitCommit", "tinyccCommit"):
        require(proof.get(key) == manifest[key], f"Relink proof {file.name} has wrong {key}")
    require(proof.get("target") == target, f"Relink proof {file.name} has wrong target")
    for key in ("sourceBuiltBunSha256", "modifiedJscPatchSha256"):
        require(isinstance(proof.get(key), str) and SHA256.fullmatch(proof[key]),
                f"Relink proof {file.name} lacks {key}")
    require(proof["modifiedJscPatchSha256"] == proof_patch_hash,
            f"Relink proof {file.name} does not match the source kit patch")
    require(proof.get("modifiedJscRelinkPassed") is True, f"Relink proof failed: {file.name}")
    require(proof.get("modifiedRuntimeProbePassed") is True and
            proof.get("modifiedRuntimeProbeOutput") == "42424242",
            f"Modified JSC runtime probe failed: {file.name}")
    require(proof.get("modifiedHelperSmokePassed") is True, f"Modified helper smoke failed: {file.name}")
    require(isinstance(proof.get("toolchain"), dict) and proof["toolchain"],
            f"Relink proof {file.name} lacks toolchain details")


def verify(directory, tag, commit):
    manifest_file = asset(directory, "cookie-helper-relink-manifest.json")
    manifest = json.loads(manifest_file.read_text("utf-8"))
    require(manifest.get("schemaVersion") == 1, "Unsupported relink manifest schema")
    require(manifest.get("tag") == tag and manifest.get("commit") == commit,
            "Relink manifest does not match this release")
    require(manifest.get("distributionMethods") == {
        "WebKit": "LGPL-2.0-section-6c",
        "TinyCC": "LGPL-2.1-section-6d",
    }, "Relink materials must be downloadable beside the packages")
    require(manifest.get("bunCommit") == BUN_COMMIT and
            manifest.get("webkitCommit") == WEBKIT_COMMIT and
            manifest.get("tinyccCommit") == TINYCC_COMMIT,
            "Relink manifest has unreviewed Bun/WebKit/TinyCC revisions")

    source = manifest.get("sourceKit")
    require(isinstance(source, dict), "Relink manifest lacks sourceKit")
    source_file = asset(directory, source.get("name"))
    verify_hash(source_file, source.get("sha256"))
    proof_patch_hash = verify_source_kit(source_file)

    targets = manifest.get("targets")
    require(isinstance(targets, dict) and set(targets) == set(TARGET_ARCHIVES),
            "Relink manifest must cover exactly both macOS architectures")
    for target, archive_name in TARGET_ARCHIVES.items():
        entry = targets[target]
        require(isinstance(entry, dict), f"Relink manifest has invalid target {target}")
        require(entry.get("archiveName") == archive_name, f"Wrong updater archive for {target}")
        require(entry.get("buildBunRevision") == "1.3.6+d530ed993",
                f"Wrong Bun compiler revision for {target}")
        app_file = asset(directory, archive_name)
        verify_hash(app_file, entry.get("archiveSha256"))
        verify_app_archive(app_file, entry.get("packagedHelperSha256"))
        proof = entry.get("proof", {})
        require(isinstance(proof, dict), f"Relink manifest has invalid proof for {target}")
        proof_file = asset(directory, proof.get("name"))
        verify_hash(proof_file, proof.get("sha256"))
        verify_proof(proof_file, target, manifest, proof_patch_hash)
        log = entry.get("relinkLog", {})
        require(isinstance(log, dict), f"Relink manifest has invalid log for {target}")
        verify_hash(asset(directory, log.get("name")), log.get("sha256"))


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 4, "Usage: verify-cookie-helper-relink-release.py ASSET_DIR TAG COMMIT")
        verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
        print("Verified both macOS cookie helper packages and their relink materials.")
    except (OSError, ValueError, KeyError, tarfile.TarError, json.JSONDecodeError) as error:
        print(f"Cookie helper relink materials: {error}", file=sys.stderr)
        sys.exit(1)
