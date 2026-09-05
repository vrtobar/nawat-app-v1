from pathlib import Path

import pytest
from PIL import Image

from media_consumer import images
from media_consumer.errors import TerminalError


def _write(path: Path, size: tuple[int, int], exif: bytes | None = None) -> Path:
    image = Image.new("RGB", size, (120, 90, 60))
    image.save(path, format="JPEG", **({"exif": exif} if exif else {}))
    return path


class TestTargetWidths:
    def test_produces_the_standard_ladder_for_a_wide_source(self):
        assert images.target_widths(2000) == [320, 640, 960]

    def test_never_upscales(self):
        # A 500px source has no 640 or 960 of real detail to offer, and a
        # srcset advertising them would be claiming resolution that is not there.
        assert images.target_widths(500) == [320, 500]

    def test_a_source_narrower_than_every_step_yields_only_itself(self):
        assert images.target_widths(200) == [200]


class TestDerive:
    def test_writes_one_webp_per_width(self, tmp_path):
        source = _write(tmp_path / "in.jpg", (1600, 900))

        renditions = images.derive(source, tmp_path)

        assert [r.width for r in renditions] == [320, 640, 960]
        for r in renditions:
            assert r.key == f"{r.width}.webp"
            with Image.open(r.path) as out:
                assert out.format == "WEBP"
                assert out.width == r.width
                # The REPORTED height is the file's height. This is the whole
                # point of carrying it: a caller that reserved a box from it
                # must get the box the image actually fills.
                assert (out.width, out.height) == (r.width, r.height)

    def test_preserves_aspect_ratio(self, tmp_path):
        source = _write(tmp_path / "in.jpg", (1600, 800))

        renditions = images.derive(source, tmp_path)

        with Image.open(renditions[0].path) as out:
            assert (out.width, out.height) == (320, 160)
        assert (renditions[0].width, renditions[0].height) == (320, 160)

    def test_drops_metadata(self, tmp_path):
        # A real EXIF block, so the assertion is about stripping rather than
        # about a source that never carried any.
        exif = Image.Exif()
        exif[0x010E] = "a description that must not survive"
        source = _write(tmp_path / "in.jpg", (800, 600), exif=exif.tobytes())

        renditions = images.derive(source, tmp_path)

        with Image.open(renditions[0][1]) as out:
            assert not dict(out.getexif())

    def test_applies_orientation_before_stripping_it(self, tmp_path):
        # Orientation 6 means "rotate 90°": the stored pixels are 800x600 and
        # the image is meant to be seen as 600x800. Strip the tag without
        # applying it and every phone photo is silently sideways.
        exif = Image.Exif()
        exif[0x0112] = 6
        source = _write(tmp_path / "in.jpg", (800, 600), exif=exif.tobytes())

        renditions = images.derive(source, tmp_path)

        with Image.open(renditions[0][1]) as out:
            assert out.height > out.width

    def test_a_file_that_is_not_an_image_is_terminal(self, tmp_path):
        broken = tmp_path / "in.jpg"
        broken.write_bytes(b"this is not a JPEG")

        with pytest.raises(TerminalError):
            images.derive(broken, tmp_path)


class TestPrimaryKey:
    def test_prefers_the_standard_width(self):
        renditions = [
            images.Rendition("320.webp", Path("a"), 320, 180),
            images.Rendition("640.webp", Path("b"), 640, 360),
        ]

        assert images.primary_key(renditions) == "640.webp"

    def test_falls_back_to_the_widest_produced(self):
        renditions = [
            images.Rendition("320.webp", Path("a"), 320, 180),
            images.Rendition("500.webp", Path("b"), 500, 281),
        ]

        assert images.primary_key(renditions) == "500.webp"
