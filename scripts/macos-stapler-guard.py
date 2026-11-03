#!/usr/bin/env python3
"""Guard Tauri's xcrun stapler calls; leave every other xcrun command untouched."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

MAX_ATTEMPTS = 5
PROCESS_TIMEOUT = 45.0
TOTAL_TIMEOUT = 300.0
INITIAL_BACKOFF = 2.0


def append_event(log_path, event):
    encoded = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        if os.write(descriptor, encoded) != len(encoded):
            raise OSError("Incomplete stapler diagnostic write")
    finally:
        os.close(descriptor)


def run_stapler(real_xcrun, args, timeout):
    """Every captured command is stapler, never notarytool or another xcrun command."""
    process = subprocess.Popen(
        [real_xcrun, *args], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.kill()
        process.wait(timeout=5)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired as error:
            stdout, stderr = error.output or b"", error.stderr or b""
            process.stdout.close()
            process.stderr.close()
    return {
        "returncode": process.returncode, "timedOut": timed_out,
        "stdout": stdout.decode(errors="replace"),
        "stderr": stderr.decode(errors="replace"),
    }


def guard_staple(args, real_xcrun, log_path, *, process_timeout=PROCESS_TIMEOUT,
                 total_timeout=TOTAL_TIMEOUT, initial_backoff=INITIAL_BACKOFF):
    if args[:2] != ["stapler", "staple"] or len(args) < 3:
        raise ValueError("Expected a stapler staple target")
    target = str(Path(args[-1]).resolve())
    group = uuid.uuid4().hex
    deadline = time.monotonic() + total_timeout
    base = {"group": group, "target": target}
    reason = "attemptsExhausted"
    attempt = 0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            reason = "budgetExhausted"
            break
        result = run_stapler(real_xcrun, args, min(process_timeout, remaining))
        append_event(log_path, {**base, "attempt": attempt, "phase": "staple", **result})
        if result["returncode"] == 0 and not result["timedOut"]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = "budgetExhausted"
                break
            validation = run_stapler(
                real_xcrun, ["stapler", "validate", target],
                min(process_timeout, remaining),
            )
            append_event(log_path, {
                **base, "attempt": attempt, "phase": "validate", **validation,
            })
            if validation["returncode"] == 0 and not validation["timedOut"]:
                append_event(log_path, {
                    **base, "attempt": attempt, "phase": "final", "validated": True,
                })
                return 0
        if attempt < MAX_ATTEMPTS:
            delay = min(initial_backoff * (2 ** (attempt - 1)),
                        max(0, deadline - time.monotonic()))
            time.sleep(delay)
    append_event(log_path, {
        **base, "attempt": attempt, "phase": "final", "validated": False,
        "reason": reason,
    })
    return 1


def verify_log(log_path, expected_app):
    """Tauri may ignore wrapper failures, so CI must validate complete final records."""
    groups = {}
    try:
        expected_target = Path(expected_app).resolve()
        if not expected_target.name.lower().endswith(".app"):
            raise ValueError("Expected an application bundle target")
        lines = Path(log_path).read_text().splitlines()
        if not lines:
            raise ValueError("No stapler attempts were recorded")
        for line in lines:
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get("group"), str):
                raise ValueError("Invalid stapler diagnostic record")
            target = event.get("target")
            if not isinstance(target, str) or not target:
                raise ValueError("Missing stapler target")
            if Path(target).resolve() != expected_target:
                raise ValueError("A stapler attempt targeted a different application")
            events = groups.setdefault(event["group"], [])
            if events and (events[-1]["phase"] == "final" or events[0]["target"] != target):
                raise ValueError("Inconsistent stapler attempt group")
            if event.get("phase") not in ("staple", "validate", "final"):
                raise ValueError("Unknown stapler phase")
            events.append(event)
        validated_apps = 0
        for events in groups.values():
            final = events[-1]
            if final.get("phase") != "final" or final.get("validated") is not True:
                raise ValueError("A stapler attempt group did not finish validated")
            if len(events) < 3:
                raise ValueError("Missing successful staple and validation records")
            staple, validation = events[-3:-1]
            if (staple.get("phase") != "staple" or validation.get("phase") != "validate"
                    or staple.get("attempt") != validation.get("attempt")
                    or validation.get("attempt") != final.get("attempt")
                    or any(event.get("returncode") != 0 or event.get("timedOut") is not False
                           for event in (staple, validation))):
                raise ValueError("A claimed validation has no matching successful command")
            if final["target"].rstrip("/").lower().endswith(".app"):
                validated_apps += 1
        if not validated_apps:
            raise ValueError("No application bundle completed stapling and validation")
        print(f"Verified {validated_apps} stapled application target(s) across {len(groups)} group(s).")
        return 0
    except (OSError, ValueError, TypeError, KeyError):
        # Diagnostic stdout/stderr is exclusively stapler output; no unrelated xcrun argv is logged.
        print("Stapler verification failed: missing, invalid or unsuccessful diagnostic records.", file=sys.stderr)
        for events in groups.values():
            for event in events:
                if event.get("phase") not in ("staple", "validate"):
                    continue
                for stream in ("stdout", "stderr"):
                    output = event.get(stream)
                    if isinstance(output, str) and output:
                        print(f"stapler {event['phase']} {stream}: {output}", file=sys.stderr)
        return 1


def main(args):
    if args[:1] == ["--verify-log"]:
        if len(args) != 4 or args[2] != "--expected-app":
            print("Usage: --verify-log LOG --expected-app APP", file=sys.stderr)
            return 1
        return verify_log(args[1], args[3])
    real_xcrun = os.environ.get("OPENUSAGE_REAL_XCRUN", "/usr/bin/xcrun")
    if args[:2] != ["stapler", "staple"]:
        # Preserve argv, streams and return status. In particular, never log notarytool credentials.
        os.execv(real_xcrun, [real_xcrun, *args])
    log_path = os.environ.get("OPENUSAGE_STAPLER_LOG")
    if not log_path:
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not runner_temp:
            print("Stapler guard requires RUNNER_TEMP or OPENUSAGE_STAPLER_LOG.", file=sys.stderr)
            return 1
        log_path = str(Path(runner_temp) / "openusage-stapler.jsonl")
    try:
        return guard_staple(args, real_xcrun, log_path)
    except (OSError, ValueError):
        print("Stapler guard could not complete or record validation.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
