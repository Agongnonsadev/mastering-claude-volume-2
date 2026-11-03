"""Prepare an image or a PDF for Claude, and foresee what it will cost (chapter 7).

Rules and limits read on October 20, 2026 on platform.claude.com (Vision, PDF support,
Coordinates and bounding boxes). They change: check them (companion page).
"""

import base64
import io
import math
from pathlib import Path

IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",  # only the first frame of an animation is read
    ".webp": "image/webp",
}

# Through Anthropic's API: 10 MB per image once encoded in base64 (5 MB on Bedrock and
# Google Cloud), 32 MB per request, 8000 px at most per side.
IMAGE_BASE64_MAX = 10 * 1024 * 1024
MAX_REQUEST = 32 * 1024 * 1024
ABSOLUTE_MAX_SIDE = 8000

# Claude sees an image in squares of 28 × 28 pixels: one square, one token.
SQUARE = 28

# Two resolution levels. The 4.7 and later models (all those of the Comptoir) are in
# high resolution: 2576 px per side and 4784 tokens at most. The others: 1568 and 1568.
HIGH_RESOLUTION = (2576, 4784)
STANDARD = (1568, 1568)
HIGH_RESOLUTION_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}


def limits(model: str) -> tuple[int, int]:
    return HIGH_RESOLUTION if model in HIGH_RESOLUTION_MODELS else STANDARD


def image_tokens(width: int, height: int) -> int:
    """Tokens of an image of this size, if Claude sees it without shrinking it."""
    return math.ceil(width / SQUARE) * math.ceil(height / SQUARE)


def seen_size(width: int, height: int, max_side: int, max_tokens: int) -> tuple[int, int]:
    """The size to which Claude shrinks an image before reading it.

    Translation of Anthropic's reference implementation: the largest size, with the
    same proportions, that respects both the maximum side and the number of tokens.
    """

    def fits(w: int, h: int) -> bool:
        return (
            math.ceil(w / SQUARE) * SQUARE <= max_side
            and math.ceil(h / SQUARE) * SQUARE <= max_side
            and image_tokens(w, h) <= max_tokens
        )

    if fits(width, height):
        return width, height
    if height > width:
        h, w = seen_size(height, width, max_side, max_tokens)
        return w, h
    ratio = width / height
    low, high = 1, width  # low always fits, high never
    while low + 1 < high:
        middle = (low + high) // 2
        if fits(middle, max(round(middle / ratio), 1)):
            low = middle
        else:
            high = middle
    return low, max(round(low / ratio), 1)


def expected_tokens(width: int, height: int, model: str) -> int:
    """Tokens the image will cost with this model, shrinking included."""
    return image_tokens(*seen_size(width, height, *limits(model)))


def image_type(path: Path) -> str:
    try:
        return IMAGE_TYPES[path.suffix.lower()]
    except KeyError:
        raise ValueError(f"{path.name}: format not accepted (JPEG, PNG, GIF or WebP only).") from None


def shrink(data: bytes, max_side: int) -> tuple[bytes, str]:
    """Shrinks an image so that its long side does not exceed max_side, as a good-quality JPEG.

    Shrinking before sending costs fewer tokens and lightens the request; shrinking too much makes
    the writing illegible. Measure before choosing (step 6 of the chapter).
    """
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))  # puts the photo upright
    image.thumbnail((max_side, max_side))
    out = io.BytesIO()
    image.convert("RGB").save(out, format="JPEG", quality=90)
    return out.getvalue(), "image/jpeg"


def image_block(path: str | Path, max_side: int | None = None) -> dict:
    """An image block in base64, ready for the API."""
    path = Path(path)
    media_type = image_type(path)
    data = path.read_bytes()
    if max_side:
        data, media_type = shrink(data, max_side)
    encoded = base64.standard_b64encode(data).decode("ascii")
    if len(encoded) > IMAGE_BASE64_MAX:
        raise ValueError(f"{path.name}: more than 10 MB once encoded; shrink it (max_side).")
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": encoded}}


def pdf_block(path: str | Path, title: str | None = None, citations: bool = False) -> dict:
    """A PDF document block in base64. Claude reads the text of each page and its image."""
    path = Path(path)
    if path.suffix.lower() != ".pdf":
        raise ValueError(f"{path.name}: a PDF is expected.")
    encoded = base64.standard_b64encode(path.read_bytes()).decode("ascii")
    if len(encoded) > MAX_REQUEST:
        raise ValueError(f"{path.name}: too heavy for a request; split it or go through the Files API.")
    block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": encoded}}
    if title:
        block["title"] = title
    if citations:
        block["citations"] = {"enabled": True}
    return block


def file_block(file_id: str, kind: str = "document", citations: bool = False) -> dict:
    """A block that designates a file already sent through the Files API (kind: document or image)."""
    block = {"type": kind, "source": {"type": "file", "file_id": file_id}}
    if citations and kind == "document":
        block["citations"] = {"enabled": True}
    return block


def document_block(path: str | Path, max_side: int | None = None) -> dict:
    """Image or PDF, according to the file's extension."""
    path = Path(path)
    if path.suffix.lower() == ".pdf":
        return pdf_block(path)
    return image_block(path, max_side)
