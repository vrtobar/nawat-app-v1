"""Image renditions: WebP at several widths, with metadata removed."""

from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageOps, UnidentifiedImageError

from . import config
from .errors import TerminalError

# Pillow refuses images above this many pixels as a decompression-bomb guard.
# The default is already conservative; it is named here so that raising it is a
# deliberate act rather than a silent one.
Image.MAX_IMAGE_PIXELS = 64_000_000


class Rendition(NamedTuple):
    """One produced file. Named rather than a bare tuple because `height` took
    it to four fields, and `for key, path, width, height in ...` reads as a
    puzzle at the two call sites that unpack it.

    `height` is carried out of here rather than recomputed by the caller: it is
    the resized pixel height, so deriving it again from the source's aspect
    ratio would be a second rounding of the same number and the two could
    disagree by a pixel. The reader needs it to reserve a box before the image
    loads, and a box off by one is a layout shift.
    """

    key: str
    path: Path
    width: int
    height: int


def target_widths(source_width: int) -> list[int]:
    """Which renditions to produce for a source of this width.

    Never upscales. A 500px source yields 320 and 500 rather than 320, 640 and
    960 — three copies of the same detail at three file sizes would make a
    srcset that lies about what it offers.
    """
    widths = {w for w in config.IMAGE_WIDTHS if w < source_width}
    widths.add(min(source_width, max(config.IMAGE_WIDTHS)))
    return sorted(widths)


def derive(source: Path, out_dir: Path) -> list[Rendition]:
    """Returns a Rendition per produced file, narrowest first."""
    try:
        with Image.open(source) as opened:
            # ⚠️ ORIENTATION IS APPLIED BEFORE METADATA IS DROPPED. A phone
            # writes an upright-looking photo plus an EXIF rotation tag; strip
            # the tag first and the image is silently sideways forever. This
            # single call is the whole reason the order matters.
            image = ImageOps.exif_transpose(opened)

            # A new image built from the pixels, so nothing from the original
            # container survives — EXIF, GPS, ICC, XMP. Re-encoding drops most
            # of it anyway, but "drops it by default" is not a property to rely
            # on when the thing being dropped can locate a speaker's home.
            image = image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB")
            source_width = image.width

            results = []
            for width in target_widths(source_width):
                height = round(image.height * (width / source_width))
                rendition = image.resize((width, height), Image.Resampling.LANCZOS)
                path = out_dir / f"{width}.webp"
                rendition.save(path, format="WEBP", quality=config.IMAGE_QUALITY, method=6)
                results.append(Rendition(f"{width}.webp", path, width, height))
            return results
    except UnidentifiedImageError as err:
        raise TerminalError("the file is not an image any decoder here recognises") from err
    except (OSError, ValueError) as err:
        # Truncated uploads and malformed headers land here. All terminal: the
        # same bytes will fail the same way on redelivery.
        raise TerminalError(f"the image could not be processed: {err}") from err


def primary_key(renditions: list[Rendition]) -> str:
    """Which rendition the public URL points at.

    Named rather than inferred, because the approval gate copies whatever this
    says and writes it onto the entry. Prefers the standard width; falls back
    to the widest produced, which is what a source narrower than 640 leaves.
    """
    for rendition in renditions:
        if rendition.width == config.IMAGE_PRIMARY_WIDTH:
            return rendition.key
    return renditions[-1].key
