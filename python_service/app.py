"""HTTP layer for the pixel engine. Wire format per DESIGN.md §4: base64-encoded
PNG bytes in/out of JSON bodies. This module only decodes/encodes and dispatches
to masks.py — no pixel math here, no session/persistence concerns.
"""

import base64
from typing import List, Optional, Tuple

from fastapi import FastAPI
from pydantic import BaseModel

import masks

app = FastAPI()


def b64_to_bytes(value):
    return base64.b64decode(value)


def bytes_to_b64(value):
    return base64.b64encode(value).decode("ascii")


class FuzzySelectRequest(BaseModel):
    image: str
    mask: Optional[str] = None
    x: int
    y: int
    tolerance: int = 32


class GradientSelectFromSelectionRequest(BaseModel):
    image: str
    mask: str
    tolerance: int = 32


class CombineRequest(BaseModel):
    mask_a: str
    mask_b: str


class SubtractRequest(BaseModel):
    mask_a: str
    mask_b: str


class InvertRequest(BaseModel):
    mask: str


class SplitSelectionRequest(BaseModel):
    mask: str
    x1: int
    y1: int
    x2: int
    y2: int
    keep_x: int
    keep_y: int


class RemoveHolesRequest(BaseModel):
    mask: str


class GrowSelectionRequest(BaseModel):
    mask: str
    border_size: int = 1


class SelectBorderRequest(BaseModel):
    mask: str
    border_size: int = 1


class DeleteRequest(BaseModel):
    image: str
    mask: str


class SelectAllRequest(BaseModel):
    image: str


class FreeSelectRequest(BaseModel):
    image: str
    points: List[Tuple[int, int]]


class LineSelectRequest(BaseModel):
    image: str
    x1: int
    y1: int
    x2: int
    y2: int
    brush_size: int = 1


class BrushSelectRequest(BaseModel):
    image: str
    strokes: List[List[Tuple[int, int]]]
    brush_size: int = 1


class RectSelectRequest(BaseModel):
    image: str
    x1: int
    y1: int
    x2: int
    y2: int


@app.post("/fuzzy_select")
def fuzzy_select(req: FuzzySelectRequest):
    image = masks.decode_image(b64_to_bytes(req.image))
    result = masks.fuzzy_select(image, req.x, req.y, req.tolerance)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/gradient_select")
def gradient_select(req: FuzzySelectRequest):
    image_bytes = b64_to_bytes(req.image)
    image = masks.decode_image(image_bytes)
    alpha = masks.decode_alpha(image_bytes)
    result = masks.gradient_select(image, req.x, req.y, req.tolerance, alpha=alpha)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/select_by_color")
def select_by_color(req: FuzzySelectRequest):
    image_bytes = b64_to_bytes(req.image)
    image = masks.decode_image(image_bytes)
    alpha = masks.decode_alpha(image_bytes)
    result = masks.select_by_color(image, req.x, req.y, req.tolerance, alpha=alpha)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/gradient_select_from_selection")
def gradient_select_from_selection(req: GradientSelectFromSelectionRequest):
    image_bytes = b64_to_bytes(req.image)
    image = masks.decode_image(image_bytes)
    alpha = masks.decode_alpha(image_bytes)
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.gradient_select_from_selection(image, mask, req.tolerance, alpha=alpha)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/combine")
def combine(req: CombineRequest):
    mask_a = masks.decode_mask(b64_to_bytes(req.mask_a))
    mask_b = masks.decode_mask(b64_to_bytes(req.mask_b))
    result = masks.combine(mask_a, mask_b)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/subtract")
def subtract(req: SubtractRequest):
    mask_a = masks.decode_mask(b64_to_bytes(req.mask_a))
    mask_b = masks.decode_mask(b64_to_bytes(req.mask_b))
    result = masks.subtract(mask_a, mask_b)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/invert")
def invert(req: InvertRequest):
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.invert(mask)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/split_selection")
def split_selection(req: SplitSelectionRequest):
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.split_selection(mask, req.x1, req.y1, req.x2, req.y2, req.keep_x, req.keep_y)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/remove_holes")
def remove_holes(req: RemoveHolesRequest):
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.remove_holes(mask)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/grow_selection")
def grow_selection(req: GrowSelectionRequest):
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.grow_selection(mask, req.border_size)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/select_border")
def select_border(req: SelectBorderRequest):
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.select_border(mask, req.border_size)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/delete")
def delete(req: DeleteRequest):
    rgb, existing_alpha = masks.decode_image_with_alpha(b64_to_bytes(req.image))
    mask = masks.decode_mask(b64_to_bytes(req.mask))
    result = masks.apply_mask_as_alpha(rgb, existing_alpha, mask)
    return {"png": bytes_to_b64(masks.encode_png(result))}


@app.post("/select_all")
def select_all(req: SelectAllRequest):
    image = masks.decode_image(b64_to_bytes(req.image))
    result = masks.select_all(image)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/free_select")
def free_select(req: FreeSelectRequest):
    image = masks.decode_image(b64_to_bytes(req.image))
    result = masks.free_select(image, req.points)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/line_select")
def line_select(req: LineSelectRequest):
    image = masks.decode_image(b64_to_bytes(req.image))
    result = masks.line_select(image, req.x1, req.y1, req.x2, req.y2, req.brush_size)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/brush_select")
def brush_select(req: BrushSelectRequest):
    image = masks.decode_image(b64_to_bytes(req.image))
    result = masks.brush_select(image, req.strokes, req.brush_size)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}


@app.post("/rect_select")
def rect_select(req: RectSelectRequest):
    image = masks.decode_image(b64_to_bytes(req.image))
    result = masks.rect_select(image, req.x1, req.y1, req.x2, req.y2)
    return {"mask": bytes_to_b64(masks.encode_mask(result))}
