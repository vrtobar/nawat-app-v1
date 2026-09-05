"""The media consumer: source object in, derivatives under `pending/` out.

WHAT THIS DOES NOT DO IS PUBLISH. Reaching READY means the processing finished,
not that anyone approved it — ADR 20 keeps processing state and review state
separate, and an ADMIN copying `pending/` to `public/` is what makes media
reachable. Nothing here writes a URL, and the IAM makes sure nothing here
could.

THE FAILURE MODEL, because two give-up mechanisms overlap and that reads as a
bug if it is not written down:

    terminal (bad file, unreadable stream)   -> FAILED on the row, ack
    transient (S3, database), under ceiling  -> raise, SQS redelivers
    transient, at the attempt ceiling        -> FAILED on the row, ack
    the database itself unwritable           -> raise, three receives, DLQ

So `attempts` is authoritative for giving up in a way that leaves an
explanation where a reviewer will see it, and the dead-letter queue catches
only what could not be explained on the row at all. That is what schema.prisma
means when it says the counter "lets retries stop without a person inspecting a
dead-letter queue".
"""

import json
import tempfile
import time
from pathlib import Path
from typing import Any

from . import audio, config, contracts, db, images, observability, storage
from .errors import TerminalError, TransientError

logger = observability.configure()

# Keys are RELATIVE to the asset's prefix — `audio.mp3`, not
# `pending/med_1/audio.mp3`. That is what makes approval a prefix swap: the same
# relative key names the object under `pending/` and under `public/`, so the
# gate copies with one component changed and nothing to re-derive.
AUDIO_KEY = "audio.mp3"


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    failures: list[dict[str, str]] = []

    for record in event.get("Records", []):
        message_id = record.get("messageId", "unknown")
        try:
            process_record(record)
        except Exception:
            # Reported rather than raised, so one bad message in a batch does
            # not redeliver the ones beside it. The event source mapping is
            # configured with ReportBatchItemFailures for this.
            logger.exception("record %s failed and will be redelivered", message_id)
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}


def process_record(record: dict[str, Any]) -> None:
    try:
        payload = json.loads(record["body"])
    except (KeyError, json.JSONDecodeError):
        # Nothing to act on and nothing to record it against — there is no
        # asset id to look up. Acknowledged rather than redelivered, because a
        # malformed body is identical on every attempt.
        logger.error("discarding a message whose body is not JSON")
        return

    contracts.validate_message(payload)
    asset_id = payload["assetId"]

    asset = db.load_asset(asset_id)
    if asset is None:
        # Deleted between publish and delivery. Legitimate, not an error.
        logger.warning("asset %s no longer exists; discarding", asset_id)
        return

    if asset["status"] == "READY":
        # A redelivery after a successful run — the work was done and the
        # acknowledgement was lost. Doing it again would be harmless, since the
        # keys are deterministic, but it would also be pointless.
        logger.info("asset %s is already READY; discarding", asset_id)
        return

    if asset["status"] == "AWAITING_UPLOAD":
        # Should be unreachable: the API publishes only after the PENDING write
        # commits (ADR 19's amendment). If it happens, something in that
        # ordering is wrong, and the right outcome is a redelivery followed by
        # a dead-letter that someone looks at — not a FAILED row that makes it
        # look like the contributor's file was bad.
        raise TransientError(f"asset {asset_id} is still AWAITING_UPLOAD")

    attempts = db.increment_attempts(asset_id)
    last_attempt = attempts >= config.MAX_ATTEMPTS
    started = time.monotonic()

    try:
        derivatives = _process(asset)
    except TerminalError as err:
        logger.warning("asset %s failed terminally: %s", asset_id, err)
        db.mark_failed(asset_id, str(err))
        return
    except TransientError as err:
        if last_attempt:
            logger.error("asset %s exhausted %s attempts: %s", asset_id, attempts, err)
            db.mark_failed(asset_id, f"gave up after {attempts} attempts: {err}")
            return
        raise

    contracts.validate_derivatives(derivatives)
    db.mark_ready(asset_id, derivatives)

    # THE LINE THIS FUNCTION EXISTS TO LEAVE BEHIND. A DLQ alarm covers
    # processing that fails; nothing covers processing that succeeds and
    # produces the wrong thing, and without this the only evidence a run
    # happened at all is the row changing state.
    #
    # ⚠️ It does NOT verify the output. The keys and sizes are what was written,
    # not a measurement of it — the loudness defect fixed in `audio` would have
    # produced an identical line, because the file was the right size, the right
    # duration and at the wrong level. Verifying that needs the delivered object
    # measured, which is a second ffmpeg pass and a separate decision.
    observability.log_event(
        logger,
        "media.processed",
        assetId=asset_id,
        kind=asset["kind"],
        attempt=attempts,
        primary=derivatives["primary"],
        files=[f["key"] for f in derivatives["files"]],
        bytes=sum(f["bytes"] for f in derivatives["files"]),
        durationSec=derivatives.get("durationSec"),
        elapsedMs=round((time.monotonic() - started) * 1000),
    )


def _process(asset: dict[str, Any]) -> dict[str, Any]:
    """Downloads the source, derives, uploads, and returns the derivatives JSON.

    Everything happens under a temporary directory that is removed on the way
    out. Lambda's /tmp survives between invocations in a warm container, so
    leaving files behind would eventually fill it — and the failure when it
    fills looks like a transcode fault rather than a disk one.
    """
    asset_id = asset["id"]
    prefix = f"pending/{asset_id}"

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        source = work / "source"
        storage.download_source(asset["source_key"], source)

        if asset["kind"] == "AUDIO":
            duration = audio.probe_duration_seconds(source)
            output = work / AUDIO_KEY
            audio.normalise(source, output)
            size = storage.upload_derivative(f"{prefix}/{AUDIO_KEY}", output, "audio/mpeg")
            return {
                "primary": AUDIO_KEY,
                "files": [{"key": AUDIO_KEY, "contentType": "audio/mpeg", "bytes": size}],
                "durationSec": round(duration, 3),
            }

        if asset["kind"] == "IMAGE":
            renditions = images.derive(source, work)
            files = [
                {
                    "key": r.key,
                    "contentType": "image/webp",
                    "bytes": storage.upload_derivative(f"{prefix}/{r.key}", r.path, "image/webp"),
                    "width": r.width,
                    "height": r.height,
                }
                for r in renditions
            ]
            return {"primary": images.primary_key(renditions), "files": files}

    # The kind is a database enum, so this is only reachable if a new member is
    # added without a branch here — which is worth failing loudly for.
    raise TerminalError(f"unsupported media kind {asset['kind']}")
