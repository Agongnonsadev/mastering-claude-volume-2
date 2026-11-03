"""Prepare images and PDFs, and foresee their cost in tokens, without a call to the API."""

import base64
import io

import pytest
from PIL import Image

from comptoir.documents import (
    HIGH_RESOLUTION,
    STANDARD,
    document_block,
    expected_tokens,
    file_block,
    image_block,
    image_tokens,
    pdf_block,
    seen_size,
)

# The table of Anthropic's Vision page (October 20, 2026): size seen and tokens.
STANDARD_EXAMPLES = [
    ((200, 200), (200, 200), 64),
    ((1000, 1000), (1000, 1000), 1296),
    ((1092, 1092), (1092, 1092), 1521),
    ((1920, 1080), (1456, 819), 1560),
    # The page's table gives 1269 × 952; the reference implementation of the same
    # documentation gives 1270 × 952. Same cost: 1564 tokens.
    ((2000, 1500), (1270, 952), 1564),
    ((3840, 2160), (1456, 819), 1560),
]
HIGH_RESOLUTION_EXAMPLES = [
    ((1920, 1080), (1920, 1080), 2691),
    ((2000, 1500), (2000, 1500), 3888),
    ((3840, 2160), (2576, 1449), 4784),
]


@pytest.mark.parametrize("size, seen, tokens", STANDARD_EXAMPLES)
def test_the_standard_level_follows_anthropics_table(size, seen, tokens):
    assert seen_size(*size, *STANDARD) == seen
    assert image_tokens(*seen) == tokens


@pytest.mark.parametrize("size, seen, tokens", HIGH_RESOLUTION_EXAMPLES)
def test_high_resolution_follows_anthropics_table(size, seen, tokens):
    assert seen_size(*size, *HIGH_RESOLUTION) == seen
    assert image_tokens(*seen) == tokens


def test_the_example_of_the_a4_page():
    # An A4 page scanned at 130 dots per inch: shrunk in standard, not in high resolution.
    assert seen_size(1075, 1520, *STANDARD) == (924, 1307)
    assert seen_size(1075, 1520, *HIGH_RESOLUTION) == (1075, 1520)


def test_a_phone_photo_costs_at_most_4784_tokens_with_sonnet_5_5():
    assert expected_tokens(3000, 4000, "claude-sonnet-5-5") <= 4784


def _photo(tmp_path, size=(3000, 4000), name="photo.jpg"):
    path = tmp_path / name
    Image.new("RGB", size, (200, 180, 160)).save(path, quality=80)
    return path


def test_an_image_block_in_base64(tmp_path):
    block = image_block(_photo(tmp_path))
    assert block["type"] == "image"
    assert block["source"]["media_type"] == "image/jpeg"
    assert base64.standard_b64decode(block["source"]["data"])[:2] == b"\xff\xd8"  # start of a JPEG


def test_shrink_before_sending(tmp_path):
    block = image_block(_photo(tmp_path), max_side=1000)
    image = Image.open(io.BytesIO(base64.standard_b64decode(block["source"]["data"])))
    assert max(image.size) == 1000 and image.size == (750, 1000)


def test_a_refused_format(tmp_path):
    path = tmp_path / "scan.tiff"
    path.write_bytes(b"II*\x00")
    with pytest.raises(ValueError, match="format not accepted"):
        image_block(path)


def test_a_pdf_block_with_title_and_citations(tmp_path):
    path = tmp_path / "f.pdf"
    path.write_bytes(b"%PDF-1.4\n")
    block = pdf_block(path, title="Invoice", citations=True)
    assert block["source"]["media_type"] == "application/pdf"
    assert block["title"] == "Invoice" and block["citations"] == {"enabled": True}
    assert document_block(path)["type"] == "document"


def test_a_file_from_the_files_api():
    assert file_block("file_abc", citations=True) == {
        "type": "document",
        "source": {"type": "file", "file_id": "file_abc"},
        "citations": {"enabled": True},
    }
