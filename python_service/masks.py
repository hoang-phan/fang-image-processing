"""Pixel math for the four selection tools. Stateless: every function takes
plain arrays/bytes in, returns bytes out. No session or persistence concerns
belong in this module or this service — see DESIGN.md §2/§6.
"""

import io
from collections import deque

import cv2
import numpy as np
from PIL import Image


def decode_image(png_bytes):
    image = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)


def decode_image_with_alpha(png_bytes):
    """Like decode_image, but keeps the alpha channel (opaque 255 if the
    source has none) instead of discarding it. Color stays RGB (not BGR like
    decode_image) since the only other caller, apply_mask_as_alpha, feeds it
    straight into encode_png's RGB PIL write. Used by delete/apply_mask_as_alpha
    so previously-cleared pixels from an earlier delete stay transparent when a
    new selection is composited on top — see DESIGN.md §4 on additive delete.
    """
    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    array = np.array(image)
    return array[:, :, :3], array[:, :, 3]


def decode_alpha(png_bytes):
    """Returns just the alpha channel (opaque 255 if the source has none),
    for callers that only need to know which pixels are already transparent
    and get their color data from a separate decode_image (BGR) call — see
    gradient_select/gradient_select_from_selection's alpha param.
    """
    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    return np.array(image)[:, :, 3]


def decode_mask(png_bytes):
    mask = Image.open(io.BytesIO(png_bytes)).convert("L")
    return np.array(mask)


def encode_mask(mask):
    buffer = io.BytesIO()
    Image.fromarray(mask).save(buffer, format="PNG")
    return buffer.getvalue()


def encode_png(rgba_array):
    buffer = io.BytesIO()
    Image.fromarray(rgba_array).save(buffer, format="PNG")
    return buffer.getvalue()


def select_all(image_bgr):
    height, width = image_bgr.shape[:2]
    return np.full((height, width), 255, dtype=np.uint8)


def free_select(image_bgr, points):
    """Rasterizes a closed polygon (list of (x, y) vertices, GIMP free-select
    style) into a selection mask via scanline fill — same 0/255 convention as
    every other mask. `points` needs at least 3 vertices to enclose an area.
    """
    height, width = image_bgr.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    polygon = np.array(points, dtype=np.int32).reshape((-1, 1, 2))
    cv2.fillPoly(mask, [polygon], 255)
    return mask


def line_select(image_bgr, x1, y1, x2, y2, brush_size):
    """Selects every pixel within `brush_size`/2 of the segment from (x1, y1)
    to (x2, y2) — a straight-line brush stroke. `cv2.line`'s `thickness`
    already rasterizes a stroke of a given width along a segment (round caps
    via LINE_AA-independent default cap behavior are not needed here; a plain
    thick line is what "brush size determines line size" calls for), so this
    reuses that rather than hand-rolling distance-to-segment math.
    """
    height, width = image_bgr.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.line(mask, (x1, y1), (x2, y2), color=255, thickness=max(1, brush_size))
    return mask


def brush_select(image_bgr, strokes, brush_size):
    """Strokes freehand brush paths (GIMP foreground-select style) into a
    selection mask. `strokes` is a list of point lists — one per continuous
    mouse-down-to-mouse-up drag the browser recorded — kept separate rather
    than flattened into a single point list so that two disconnected dabs
    don't get spuriously joined by a line between the last point of one
    stroke and the first point of the next.

    Within a stroke, a single point (a click with no drag) is stroked as a
    dot rather than a zero-length line, since cv2.line between a point and
    itself draws nothing at thickness > 1 in some OpenCV builds. Consecutive
    points are connected with cv2.line the same way line_select strokes a
    single segment, and a circle is stamped at every vertex so the joins
    between segments don't look faceted at large brush sizes.
    """
    height, width = image_bgr.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    thickness = max(1, brush_size)
    radius = thickness // 2

    for points in strokes:
        if not points:
            continue

        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            cv2.line(mask, (x1, y1), (x2, y2), color=255, thickness=thickness, lineType=cv2.LINE_8)

        for x, y in points:
            cv2.circle(mask, (x, y), radius, color=255, thickness=-1)

    return mask


def fuzzy_select(image_bgr, x, y, tolerance):
    height, width = image_bgr.shape[:2]
    flood_mask = np.zeros((height + 2, width + 2), dtype=np.uint8)

    cv2.floodFill(
        image_bgr.copy(),
        flood_mask,
        (x, y),
        newVal=0,
        loDiff=(tolerance,) * 3,
        upDiff=(tolerance,) * 3,
        flags=cv2.FLOODFILL_MASK_ONLY | 8,
    )

    selected = flood_mask[1:-1, 1:-1]
    return np.where(selected > 0, np.uint8(255), np.uint8(0))


def select_by_color(image_bgr, x, y, tolerance, alpha=None):
    """GIMP's Select > By Color: selects every pixel in the image within
    `tolerance` of the clicked pixel's color, regardless of whether it's
    connected to the clicked point — unlike fuzzy_select's flood-fill, which
    only reaches contiguous pixels. This is what makes it useful for
    distributed objects (e.g. stray hairs scattered across a background):
    one click selects every matching strand at once instead of requiring a
    separate fuzzy-select/Ctrl+click per disconnected region.

    Tolerance is measured the same way as fuzzy_select/gradient_select (max
    per-channel absolute difference from the seed color), so the Threshold
    tool option means the same thing across all three tools.

    `alpha`, when given, excludes already-deleted pixels (0 = deleted) from
    the result, same reasoning as gradient_select: a cleared region is a
    uniform zeroed-RGB block that would otherwise match almost any tolerance
    against a dark seed color.
    """
    seed = image_bgr[y, x].astype(np.int16)
    diff = np.abs(image_bgr.astype(np.int16) - seed).max(axis=2)
    selected = diff <= tolerance

    if alpha is not None:
        selected &= alpha != 0

    return np.where(selected, np.uint8(255), np.uint8(0))


def gradient_select(image_bgr, x, y, tolerance, alpha=None):
    """Like fuzzy_select, but each candidate pixel is compared against the
    already-selected neighbor it was reached from, not the original seed
    pixel. This lets selection walk gradually across a smooth gradient
    (each step within tolerance of the last) while still stopping at a hard
    edge, whereas fuzzy_select's flood-fill would stop the moment any single
    step drifts far enough from the seed color, even if the drift happened
    gradually one small step at a time.

    Plain BFS rather than cv2.floodFill because floodFill's loDiff/upDiff are
    always relative to the seed color for the life of the fill — there is no
    way to make the comparison reference shift to the most recently accepted
    boundary pixel, which is the whole point of this tool.

    `alpha`, when given, is the image's existing alpha channel (0 = already
    deleted by a prior Clear). Already-deleted pixels are excluded from the
    walk's frontier — the walk can neither land on them nor step past them to
    reach pixels on the far side. This is scoped to gradient select only
    (not fuzzy_select or any mask-only op like invert/grow/border): a
    deleted region reads as a uniform zeroed-RGB block (see
    apply_mask_as_alpha), which is exactly the shape gradient select's
    neighbor-chained tolerance is designed to walk across, so without this
    it can silently bridge through already-cleared area into fresh pixels on
    the other side.
    """
    height, width = image_bgr.shape[:2]
    pixels = image_bgr.astype(np.int16)
    deleted = alpha == 0 if alpha is not None else None
    selected = np.zeros((height, width), dtype=bool)

    seed = (int(y), int(x))
    if deleted is not None and deleted[seed]:
        return np.where(selected, np.uint8(255), np.uint8(0))

    selected[seed] = True
    queue = deque([seed])

    while queue:
        cy, cx = queue.popleft()
        reference = pixels[cy, cx]

        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue

                ny, nx = cy + dy, cx + dx
                if ny < 0 or ny >= height or nx < 0 or nx >= width or selected[ny, nx]:
                    continue
                if deleted is not None and deleted[ny, nx]:
                    continue

                diff = np.abs(pixels[ny, nx] - reference).max()
                if diff <= tolerance:
                    selected[ny, nx] = True
                    queue.append((ny, nx))

    return np.where(selected, np.uint8(255), np.uint8(0))


def gradient_select_from_selection(image_bgr, mask, tolerance, alpha=None):
    """Like gradient_select, but seeded from every pixel already on the
    selection boundary instead of a single clicked point — see DESIGN.md §1
    for the intended flow (gradient select -> grow over the hard edge it
    stopped at -> gradient select from selection again to keep walking
    outward). Each unselected candidate is compared against whichever
    already-selected neighbor it was reached from, exactly like
    gradient_select's single-seed BFS, just with the whole current selection
    as the starting frontier rather than one pixel.

    Only ever adds pixels: the existing selection is preserved unchanged and
    newly-reached pixels are OR'd in, so this can't shrink what's already
    selected even if some interior pixel's neighbor comparison would fail.

    `alpha`, when given, marks already-deleted pixels (0 = deleted) as
    excluded from the walk, same scoping/reasoning as gradient_select.
    """
    height, width = image_bgr.shape[:2]
    pixels = image_bgr.astype(np.int16)
    deleted = alpha == 0 if alpha is not None else None
    selected = mask > 0

    queue = deque(zip(*np.nonzero(selected)))

    while queue:
        cy, cx = queue.popleft()
        reference = pixels[cy, cx]

        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue

                ny, nx = cy + dy, cx + dx
                if ny < 0 or ny >= height or nx < 0 or nx >= width or selected[ny, nx]:
                    continue
                if deleted is not None and deleted[ny, nx]:
                    continue

                diff = np.abs(pixels[ny, nx] - reference).max()
                if diff <= tolerance:
                    selected[ny, nx] = True
                    queue.append((ny, nx))

    return np.where(selected, np.uint8(255), np.uint8(0))


def combine(mask_a, mask_b):
    return cv2.bitwise_or(mask_a, mask_b)


def subtract(mask_a, mask_b):
    """Removes mask_b's selected pixels from mask_a — the Shift+click
    modifier's counterpart to combine's Ctrl/Cmd+click union (see
    DESIGN.md §1/§4).
    """
    return cv2.bitwise_and(mask_a, cv2.bitwise_not(mask_b))


def remove_holes(mask):
    """GIMP-style Select > Remove Holes: fills in any unselected region fully
    enclosed by selected pixels. Labels the connected components of the
    *unselected* area; any component that never touches the image border is
    by definition surrounded on all sides by selection, i.e. a hole, and gets
    folded into the selection. Unselected regions that do touch the border
    are background, not holes, and are left alone.
    """
    inverted = cv2.bitwise_not(mask)
    num_labels, labels = cv2.connectedComponents(inverted, connectivity=8)

    border_labels = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    hole_labels = set(range(1, num_labels)) - border_labels

    holes = np.isin(labels, list(hole_labels)).astype(np.uint8) * 255
    return cv2.bitwise_or(mask, holes)


def grow_selection(mask, border_size):
    """GIMP's Select > Grow: expands the selection outward by `border_size`
    pixels in every direction, unioning the grown area into the existing
    selection. A single square structuring element of that size dilates the
    mask by exactly `border_size` pixels from every boundary — no separate
    union step needed, dilation already only ever adds pixels.
    """
    kernel = np.ones((border_size * 2 + 1, border_size * 2 + 1), dtype=np.uint8)
    return cv2.dilate(mask, kernel)


def select_border(mask, border_size):
    """GIMP's Select > Border: replaces the selection with just the ring of
    `border_size` pixels straddling the original selection boundary, instead
    of keeping the interior like grow_selection does. Dilating and eroding by
    half the border size each and taking the difference centers the ring on
    the original boundary rather than falling entirely outside or inside it,
    matching GIMP's own border behavior.
    """
    half = max(1, border_size // 2)
    kernel = np.ones((half * 2 + 1, half * 2 + 1), dtype=np.uint8)
    outer = cv2.dilate(mask, kernel)
    inner = cv2.erode(mask, kernel)
    return cv2.bitwise_and(outer, cv2.bitwise_not(inner))


def split_selection(mask, x1, y1, x2, y2, keep_x, keep_y):
    """Splits the current selection by the infinite line through (x1, y1) and
    (x2, y2) — the two points only set the line's direction/position, they
    are not endpoints of a segment the way line_select's are — and discards
    whichever side of that line does not contain (keep_x, keep_y), the point
    the user clicked to indicate which half to keep.

    The line's implicit equation is (x - x1)*(y2 - y1) - (y - y1)*(x2 - x1) = 0;
    plugging any point into the left-hand side gives a signed value whose
    sign alone tells you which side of the line it falls on (this is the same
    2D cross-product test used for point-in-polygon/line-side checks). Every
    mask pixel is tested against that same expression and kept only if its
    sign matches the keep point's sign — ties (exactly on the line) are kept,
    since the line has zero width and shouldn't itself remove any selected
    pixels.
    """
    height, width = mask.shape[:2]
    ys, xs = np.mgrid[0:height, 0:width]

    dx = x2 - x1
    dy = y2 - y1
    side = (xs - x1) * dy - (ys - y1) * dx
    keep_side = (keep_x - x1) * dy - (keep_y - y1) * dx

    if keep_side >= 0:
        half_plane = side >= 0
    else:
        half_plane = side < 0

    return np.where(half_plane, mask, np.uint8(0))


def invert(mask):
    return cv2.bitwise_not(mask)


def apply_mask_as_alpha(rgb, existing_alpha, mask):
    """Composites `mask` (selected -> transparent) onto whatever alpha the
    image already had, so previously-cleared pixels stay cleared. AND rather
    than overwrite: a pixel is transparent in the result if it was already
    transparent OR is newly selected for deletion.

    Every transparent pixel also gets its RGB zeroed (uniform #00000000)
    rather than just alpha-masked. Otherwise a fully "deleted" image still
    carries its original RGB values under invisible pixels, which are not
    uniform — a later fuzzy-select flood-fill starting on a transparent
    pixel sees varying RGB neighbors and stops short of selecting every
    transparent pixel (see DESIGN.md §4).
    """
    new_alpha = cv2.bitwise_not(mask)
    alpha = cv2.bitwise_and(existing_alpha, new_alpha)
    transparent = alpha == 0
    rgb = rgb.copy()
    rgb[transparent] = 0
    return np.dstack([rgb, alpha])
