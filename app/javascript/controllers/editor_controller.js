import { Controller } from "@hotwired/stimulus"

// Owns canvas rendering and click input for the sprite editor. Sends tool +
// coordinates to Rails and redraws whatever mask/image comes back. No pixel
// math happens here — see DESIGN.md §5.
const TOLERANCE_STORAGE_KEY = "fang-editor:tolerance"
const TOLERANCE_STEP = 0.1
const TOLERANCE_MIN = 0
const TOLERANCE_MAX = 128
const TOLERANCE_DEFAULT = 32.0

const ZOOM_STORAGE_KEY = "fang-editor:zoom"
const ZOOM_STEP = 0.25
const ZOOM_MIN = 0.25
const ZOOM_MAX = 8
const ZOOM_DEFAULT = 1

const BRUSH_SIZE_STORAGE_KEY = "fang-editor:brush-size"
const BRUSH_SIZE_STEP = 1
const BRUSH_SIZE_MIN = 1
const BRUSH_SIZE_MAX = 200
const BRUSH_SIZE_DEFAULT = 10

// Radius (in image pixels) of the enlarged first-point handle for the free
// select tool — GIMP-style: made big enough to click on deliberately, since
// clicking within this radius of the first point is how the path is closed.
const FREE_SELECT_HANDLE_RADIUS = 6

// Grow Selection and Select Border (GIMP-style) share one dialog and one
// persisted border-size preference — GIMP itself remembers a single "grow/
// shrink/border size" across those operations rather than one per tool, so
// this follows that convention instead of splitting into two storage keys.
const BORDER_SIZE_STORAGE_KEY = "fang-editor:border-size"
const BORDER_SIZE_STEP = 1
const BORDER_SIZE_MIN = 1
const BORDER_SIZE_MAX = 500
const BORDER_SIZE_DEFAULT = 10

export default class extends Controller {
  static targets = [
    "imageCanvas", "overlayCanvas", "brushCanvas", "canvasStack", "editorMain", "status",
    "toolbar", "toolOptions", "toleranceControl", "toleranceSlider", "toleranceInput",
    "brushSizeControl", "brushSizeSlider", "brushSizeInput", "brushSubmitControl",
    "zoomLevel",
    "borderSizeDialog", "borderSizeDialogTitle", "borderSizeInput",
    "mergeSelectionDialog", "savedSelectionList",
  ]
  static values = {
    imageUrl: String,
    maskUrl: String,
    fuzzySelectUrl: String,
    gradientSelectUrl: String,
    selectByColorUrl: String,
    gradientSelectFromSelectionUrl: String,
    selectAllUrl: String,
    deselectAllUrl: String,
    freeSelectUrl: String,
    lineSelectUrl: String,
    brushSelectUrl: String,
    rectSelectUrl: String,
    splitSelectionUrl: String,
    smoothAutoFillUrl: String,
    invertUrl: String,
    removeHolesUrl: String,
    growSelectionUrl: String,
    selectBorderUrl: String,
    deleteUrl: String,
    undoUrl: String,
    redoUrl: String,
    saveSelectionUrl: String,
    savedSelectionsUrl: String,
    mergeSelectionUrl: String,
    exportUrl: String,
  }

  connect() {
    this.tool = "fuzzy_select"
    this.selectionPath = null
    this.marchOffset = 0
    this.freeSelectPoints = []
    this.lineSelectStart = null
    this.rectSelectStart = null
    this.splitSelectionLine = null
    this.smoothAutoFillStart = null
    this.brushStrokes = []
    this.brushDrawing = false
    this.brushPointer = null

    this.image = new Image()
    this.image.onload = () => {
      this.imageCanvasTarget.width = this.image.width
      this.imageCanvasTarget.height = this.image.height
      this.overlayCanvasTarget.width = this.image.width
      this.overlayCanvasTarget.height = this.image.height
      this.brushCanvasTarget.width = this.image.width
      this.brushCanvasTarget.height = this.image.height
      this.imageCanvasTarget.getContext("2d").drawImage(this.image, 0, 0)

      if (this.maskUrlValue) {
        this.drawMask(this.maskUrlValue)
      }
    }
    this.image.src = this.imageUrlValue

    this.restoreTolerance()
    this.restoreBrushSize()
    this.restoreZoom()
    this.restoreBorderSize()
    this.updateToolOptions()

    this.boundKeydown = this.keydown.bind(this)
    document.addEventListener("keydown", this.boundKeydown)

    this.boundPointerMove = this.pointerMove.bind(this)
    this.editorMainTarget.addEventListener("mousemove", this.boundPointerMove)

    this.boundBrushDown = this.brushPointerDown.bind(this)
    this.overlayCanvasTarget.addEventListener("mousedown", this.boundBrushDown)

    this.boundBrushUp = this.brushPointerUp.bind(this)
    window.addEventListener("mouseup", this.boundBrushUp)

    this.boundBrushLeave = this.brushPointerLeave.bind(this)
    this.overlayCanvasTarget.addEventListener("mouseleave", this.boundBrushLeave)

    this.boundMarch = this.march.bind(this)
    this.marchAnimationId = requestAnimationFrame(this.boundMarch)
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundKeydown)
    this.editorMainTarget.removeEventListener("mousemove", this.boundPointerMove)
    this.overlayCanvasTarget.removeEventListener("mousedown", this.boundBrushDown)
    window.removeEventListener("mouseup", this.boundBrushUp)
    this.overlayCanvasTarget.removeEventListener("mouseleave", this.boundBrushLeave)
    cancelAnimationFrame(this.marchAnimationId)
  }

  // Every selection-mutating action (click(), invert(), clearSelection(),
  // undo(), etc.) reads this.selectionPath as a guard, sends one request,
  // and on response updates this.selectionPath — but each is triggered by
  // its own independent event handler with no shared in-flight tracking.
  // Selecting a region and immediately pressing Delete used to race: the
  // guard in clearSelection() reads this.selectionPath before the select's
  // response has come back and updated it, so the guard sees stale (null)
  // state and drops the Delete entirely — the user then has to press it
  // again once the select finishes. Routing every such action through this
  // queue serializes whole actions (guard check through state update), not
  // just the request send, so a later action's guard always sees the
  // previous action's fully-applied result.
  enqueue(action) {
    const run = () => Promise.resolve().then(action)
    const queued = (this.actionQueue || Promise.resolve()).then(run, run)
    this.actionQueue = queued.catch(() => {})
    return queued
  }

  // Tracks the pointer in image coordinates so the in-progress line select
  // preview (see renderLineSelectPreview()) can follow the cursor between
  // the first click and the second. No-op for every other tool.
  pointerMove(event) {
    if (this.tool === "brush") {
      this.brushPointer = this.eventToImageCoordinates(event)
      if (this.brushDrawing) {
        this.currentBrushStroke.push(this.brushPointer)
      }
      this.renderBrushCanvas()
      return
    }

    if (this.lineSelectStart) {
      this.lineSelectPointer = this.eventToImageCoordinates(event)
      this.renderOverlay()
      return
    }

    if (this.rectSelectStart) {
      this.rectSelectPointer = this.eventToImageCoordinates(event)
      this.renderOverlay()
      return
    }

    if (this.splitSelectionLine) {
      this.splitSelectionPointer = this.eventToImageCoordinates(event)
      this.renderOverlay()
      return
    }

    if (this.smoothAutoFillStart) {
      this.smoothAutoFillPointer = this.eventToImageCoordinates(event)
      this.renderOverlay()
    }
  }

  // Brush tool: mousedown starts a new stroke (a fresh point array pushed
  // onto this.brushStrokes), mousemove while down appends points to it, and
  // mouseup/mouseleave end the drag. Kept as separate mousedown/mousemove/
  // mouseup listeners rather than reusing click() since a brush stroke is a
  // continuous drag, not a discrete click the way every other tool's input is.
  brushPointerDown(event) {
    if (this.tool !== "brush") return
    if (event.button !== 0) return

    this.brushDrawing = true
    this.currentBrushStroke = [ this.eventToImageCoordinates(event) ]
    this.brushStrokes.push(this.currentBrushStroke)
    this.renderBrushCanvas()
  }

  brushPointerUp() {
    if (!this.brushDrawing) return
    this.brushDrawing = false
    this.currentBrushStroke = null
  }

  // Ending the drag if the pointer leaves the canvas mid-stroke (rather than
  // continuing to record points off-canvas) matches how mouseup would behave
  // if released just inside the edge — avoids a stroke silently continuing
  // to accumulate far-away coordinates the user can no longer see.
  brushPointerLeave() {
    this.brushPointerUp()
    this.brushPointer = null
    this.renderBrushCanvas()
  }

  // Drives the "marching ants" dash animation continuously (GIMP-style):
  // the dash offset scrolls along the boundary path rather than the
  // stroke alternating color, which reads better at a glance.
  march() {
    this.marchOffset = (this.marchOffset + 0.3) % 8
    if (this.selectionPath) this.renderOverlay()
    this.marchAnimationId = requestAnimationFrame(this.boundMarch)
  }

  keydown(event) {
    const meta = event.metaKey || event.ctrlKey

    if (meta && event.key.toLowerCase() === "i") {
      event.preventDefault()
      this.invert()
      return
    }

    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault()
      this.selectAll()
      return
    }

    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault()
      this.deselectAll()
      return
    }

    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault()
      if (event.shiftKey) {
        this.redo()
      } else {
        this.undo()
      }
      return
    }

    if (meta && event.shiftKey && event.key.toLowerCase() === "h") {
      event.preventDefault()
      this.removeHoles()
      return
    }

    if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault()
      this.download()
      return
    }

    if (this.isTypingTarget(event.target)) return

    if (!meta && event.key.toLowerCase() === "u") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="fuzzy_select"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "f") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="free_select"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "g") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="gradient_select"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "o") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="select_by_color"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "l") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="line_select"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "r") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="rect_select"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "b") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="brush"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "s") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="split_selection"]') })
      return
    }

    if (!meta && event.key.toLowerCase() === "a") {
      event.preventDefault()
      this.selectTool({ currentTarget: this.toolbarTarget.querySelector('[data-tool="smooth_auto_fill"]') })
      return
    }

    if (!meta && (event.key === "+" || event.key === "=")) {
      event.preventDefault()
      this.zoomIn()
      return
    }

    if (!meta && event.key === "-") {
      event.preventDefault()
      this.zoomOut()
      return
    }

    if (!meta && event.key === "0") {
      event.preventDefault()
      this.zoomReset()
      return
    }

    if (!meta && event.key === "Escape") {
      event.preventDefault()
      this.cancelFreeSelect()
      this.cancelLineSelect()
      this.cancelRectSelect()
      this.cancelSplitSelection()
      this.cancelSmoothAutoFill()
      this.cancelBrush()
      return
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      this.clearSelection()
    }
  }

  isTypingTarget(target) {
    return target.tagName === "INPUT" || target.tagName === "TEXTAREA"
  }

  selectTool(event) {
    const button = event.currentTarget
    if (this.tool === "free_select" && button.dataset.tool !== "free_select") {
      this.cancelFreeSelect()
    }
    if (this.tool === "line_select" && button.dataset.tool !== "line_select") {
      this.cancelLineSelect()
    }
    if (this.tool === "rect_select" && button.dataset.tool !== "rect_select") {
      this.cancelRectSelect()
    }
    if (this.tool === "split_selection" && button.dataset.tool !== "split_selection") {
      this.cancelSplitSelection()
    }
    if (this.tool === "smooth_auto_fill" && button.dataset.tool !== "smooth_auto_fill") {
      this.cancelSmoothAutoFill()
    }
    if (this.tool === "brush" && button.dataset.tool !== "brush") {
      this.cancelBrush()
    }
    this.tool = button.dataset.tool

    this.toolbarTarget.querySelectorAll(".tool-button[data-tool]").forEach((el) => {
      el.classList.toggle("active", el === button)
    })

    this.updateToolOptions()
  }

  updateToolOptions() {
    this.toleranceControlTarget.hidden = !["fuzzy_select", "gradient_select", "select_by_color", "smooth_auto_fill"].includes(this.tool)
    this.brushSizeControlTarget.hidden = this.tool !== "line_select" && this.tool !== "brush"
    this.brushSubmitControlTarget.hidden = this.tool !== "brush"
    this.editorMainTarget.classList.toggle("zoom-cursor", this.tool === "zoom")
    if (this.tool === "brush") {
      this.renderBrushCanvas()
    } else {
      this.clearBrushCanvas()
    }
  }

  // Escape, or switching tools mid-drawing, discards every uncommitted brush
  // stroke without submitting anything — brush strokes are frontend-only
  // until one of the three submission buttons runs (see DESIGN.md), so
  // there's no server-side state to roll back here, just local state to drop.
  cancelBrush() {
    if (this.brushStrokes.length === 0) return
    this.brushStrokes = []
    this.brushDrawing = false
    this.currentBrushStroke = null
    this.clearBrushCanvas()
    this.setStatus("")
  }

  // Ctrl/Cmd+A (GIMP's Select > All): replaces the current selection with
  // the whole image. Always available regardless of active tool.
  selectAll() {
    return this.enqueue(() => this.selectAllNow())
  }

  async selectAllNow() {
    this.cancelFreeSelect()
    this.setStatus("Working…")
    const response = await this.post(this.selectAllUrlValue, {})
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Ctrl/Cmd+D (GIMP's Select > None): drops the current selection entirely.
  deselectAll() {
    return this.enqueue(() => this.deselectAllNow())
  }

  async deselectAllNow() {
    this.cancelFreeSelect()
    if (!this.selectionPath) return

    this.setStatus("Working…")
    const response = await this.post(this.deselectAllUrlValue, {})
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    this.selectionPath = null
    this.clearOverlay()
    this.setStatus("")
  }

  // Escape or switching tools mid-path abandons an in-progress free select
  // without submitting anything — GIMP allows canceling a lasso in progress.
  cancelFreeSelect() {
    if (this.freeSelectPoints.length === 0) return
    this.freeSelectPoints = []
    this.renderOverlay()
    this.setStatus("")
  }

  // Escape, or switching tools mid-line, abandons an in-progress line select
  // (a placed first point with no second point yet) without submitting
  // anything — same convention as cancelFreeSelect().
  cancelLineSelect() {
    if (!this.lineSelectStart) return
    this.lineSelectStart = null
    this.lineSelectPointer = null
    this.renderOverlay()
    this.setStatus("")
  }

  // Escape, or switching tools mid-rectangle, abandons an in-progress rect
  // select (a placed first corner with no second corner yet) without
  // submitting anything — same convention as cancelLineSelect().
  cancelRectSelect() {
    if (!this.rectSelectStart) return
    this.rectSelectStart = null
    this.rectSelectPointer = null
    this.renderOverlay()
    this.setStatus("")
  }

  // Escape, or switching tools mid-gesture, abandons an in-progress split
  // selection (the two line-direction points placed, with no third "which
  // side to keep" click yet) without submitting anything — same convention
  // as cancelFreeSelect()/cancelLineSelect().
  cancelSplitSelection() {
    if (!this.splitSelectionLine) return
    this.splitSelectionLine = null
    this.splitSelectionPointer = null
    this.renderOverlay()
    this.setStatus("")
  }

  // Escape, or switching tools mid-vector, abandons an in-progress Smooth
  // Auto Fill vector pick (a placed first point with no second point yet)
  // without submitting anything — same convention as cancelLineSelect().
  cancelSmoothAutoFill() {
    if (!this.smoothAutoFillStart) return
    this.smoothAutoFillStart = null
    this.smoothAutoFillPointer = null
    this.renderOverlay()
    this.setStatus("")
  }

  // Tool option values persist across page loads (GIMP remembers tool
  // options per-tool across the whole session), stored client-side since
  // this is UI preference, not selection state — the server has no reason
  // to know about it.
  restoreTolerance() {
    const stored = parseFloat(localStorage.getItem(TOLERANCE_STORAGE_KEY))
    this.setTolerance(Number.isFinite(stored) ? stored : TOLERANCE_DEFAULT)
  }

  toleranceSliderChanged(event) {
    this.setTolerance(parseFloat(event.target.value))
  }

  toleranceInputChanged(event) {
    this.setTolerance(parseFloat(event.target.value))
  }

  toleranceStepUp() {
    this.setTolerance(this.tolerance + TOLERANCE_STEP)
  }

  toleranceStepDown() {
    this.setTolerance(this.tolerance - TOLERANCE_STEP)
  }

  setTolerance(value) {
    if (!Number.isFinite(value)) value = TOLERANCE_DEFAULT
    const clamped = Math.min(TOLERANCE_MAX, Math.max(TOLERANCE_MIN, value))
    const rounded = Math.round(clamped * 10) / 10

    this.tolerance = rounded
    this.toleranceInputTarget.value = rounded.toFixed(1)
    this.toleranceSliderTarget.value = rounded
    localStorage.setItem(TOLERANCE_STORAGE_KEY, rounded)
  }

  // Line select's Brush Size tool option: the stroke width (in image
  // pixels) of the line drawn between the two clicked points. Same
  // persist-across-page-loads pattern as Threshold — a client-side UI
  // preference, not selection state (see DESIGN.md §3).
  restoreBrushSize() {
    const stored = parseInt(localStorage.getItem(BRUSH_SIZE_STORAGE_KEY), 10)
    this.setBrushSize(Number.isFinite(stored) ? stored : BRUSH_SIZE_DEFAULT)
  }

  brushSizeSliderChanged(event) {
    this.setBrushSize(parseInt(event.target.value, 10))
  }

  brushSizeInputChanged(event) {
    this.setBrushSize(parseInt(event.target.value, 10))
  }

  brushSizeStepUp() {
    this.setBrushSize(this.brushSize + BRUSH_SIZE_STEP)
  }

  brushSizeStepDown() {
    this.setBrushSize(this.brushSize - BRUSH_SIZE_STEP)
  }

  setBrushSize(value) {
    if (!Number.isFinite(value)) value = BRUSH_SIZE_DEFAULT
    const clamped = Math.min(BRUSH_SIZE_MAX, Math.max(BRUSH_SIZE_MIN, value))

    this.brushSize = clamped
    this.brushSizeInputTarget.value = clamped
    this.brushSizeSliderTarget.value = clamped
    localStorage.setItem(BRUSH_SIZE_STORAGE_KEY, clamped)

    if (this.tool === "brush") this.renderBrushCanvas()
  }

  // Zoom is a pure view transform (CSS scale on the canvas stack) — it never
  // touches canvas pixel dimensions, image data, or anything sent to Rails.
  // The uploaded image / mask / export pipeline is completely unaffected by
  // zoom level; this only changes how big the same pixels are drawn on
  // screen. Persisted client-side like tolerance, since it's a UI
  // preference, not selection state (see DESIGN.md §3).
  restoreZoom() {
    const stored = parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY))
    this.setZoom(Number.isFinite(stored) ? stored : ZOOM_DEFAULT)
  }

  // Keyboard zoom (+/-/0) has no click point to anchor on, so it zooms
  // around the current viewport center — the nearest equivalent of "this is
  // where I'm already looking."
  zoomIn() {
    this.setZoom(this.zoom + ZOOM_STEP, this.viewportCenter())
  }

  zoomOut() {
    this.setZoom(this.zoom - ZOOM_STEP, this.viewportCenter())
  }

  zoomReset() {
    this.setZoom(ZOOM_DEFAULT, this.viewportCenter())
  }

  viewportCenter() {
    const main = this.editorMainTarget
    return {
      contentX: main.scrollLeft + main.clientWidth / 2,
      contentY: main.scrollTop + main.clientHeight / 2,
      viewportX: main.clientWidth / 2,
      viewportY: main.clientHeight / 2,
    }
  }

  // GIMP-style zoom tool: plain click zooms in, Ctrl/Cmd+click zooms out,
  // both anchored on the clicked point so that exact image pixel stays
  // under the cursor after rescaling — same modifier convention as fuzzy
  // select's add-to-selection (see click()).
  zoomAtEvent(event, direction) {
    const main = this.editorMainTarget
    const mainRect = main.getBoundingClientRect()
    const viewportX = event.clientX - mainRect.left
    const viewportY = event.clientY - mainRect.top

    const anchor = {
      contentX: main.scrollLeft + viewportX,
      contentY: main.scrollTop + viewportY,
      viewportX,
      viewportY,
    }

    this.setZoom(this.zoom + direction * ZOOM_STEP, anchor)
  }

  // Rescales the canvas stack and adjusts scroll position so the anchor
  // point's underlying image pixel stays visually fixed under `viewportX/Y`
  // — the content position scales by newZoom/oldZoom, then scroll is set so
  // that scaled position lands back at the same spot in the viewport. Without
  // an anchor (e.g. initial restore from localStorage), zoom is just applied
  // in place with no scroll adjustment.
  setZoom(value, anchor = null) {
    if (!Number.isFinite(value)) value = ZOOM_DEFAULT
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
    const previousZoom = this.zoom || ZOOM_DEFAULT

    this.zoom = clamped
    this.canvasStackTarget.style.transform = `scale(${clamped})`
    if (this.hasZoomLevelTarget) this.zoomLevelTarget.textContent = `${Math.round(clamped * 100)}%`
    localStorage.setItem(ZOOM_STORAGE_KEY, clamped)

    if (anchor && this.hasEditorMainTarget) {
      const scaleRatio = clamped / previousZoom
      this.editorMainTarget.scrollLeft = anchor.contentX * scaleRatio - anchor.viewportX
      this.editorMainTarget.scrollTop = anchor.contentY * scaleRatio - anchor.viewportY
    }
  }

  // Dispatches a canvas click to whichever tool is active. Fuzzy select on a
  // plain click; Ctrl/Cmd+click adds the clicked region to the existing
  // selection (GIMP's "add to selection" modifier, replacing the old
  // standalone "combine" tool); Shift+click instead subtracts the clicked
  // region from the existing selection ("subtract from selection" modifier,
  // the counterpart to add — see mask_with_modifier in the Rails controller).
  // Select by Color shares this same branch (see selectUrlForTool()): unlike
  // fuzzy select it matches every pixel in the image within tolerance of the
  // clicked color, not just the connected region, which is what makes it
  // useful for selecting scattered/disconnected pixels (e.g. stray hairs) in
  // one click instead of Ctrl/Cmd+clicking each disconnected patch.
  // Zoom tool: plain click zooms in, Ctrl/Cmd+click zooms out, both anchored
  // on the click point (see zoomAtEvent()). Free select: clicks add path
  // points instead of firing a request per click (see freeSelectClick()).
  click(event) {
    return this.enqueue(() => this.clickNow(event))
  }

  async clickNow(event) {
    if (this.tool === "zoom") {
      const zoomOut = event.metaKey || event.ctrlKey
      this.zoomAtEvent(event, zoomOut ? -1 : 1)
      return
    }

    if (this.tool === "brush") return

    const { x, y } = this.eventToImageCoordinates(event)

    if (this.tool === "free_select") {
      await this.freeSelectClick(x, y, event)
      return
    }

    if (this.tool === "line_select") {
      await this.lineSelectClick(x, y, event)
      return
    }

    if (this.tool === "rect_select") {
      await this.rectSelectClick(x, y, event)
      return
    }

    if (this.tool === "split_selection") {
      await this.splitSelectionClick(x, y)
      return
    }

    if (this.tool === "smooth_auto_fill") {
      await this.smoothAutoFillClick(x, y)
      return
    }

    const addToSelection = event.metaKey || event.ctrlKey
    const subtractFromSelection = event.shiftKey

    this.setStatus("Working…")

    const url = this.selectUrlForTool()
    const response = await this.post(url, {
      x, y, tolerance: this.tolerance, add: addToSelection, subtract: subtractFromSelection,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Fuzzy Select, Gradient Select, and Select by Color all share click()'s
  // plain-click branch (same coordinate mapping, same add/subtract modifier
  // handling) — the only difference between them is which URL the region
  // request posts to, since the three algorithms diverge only on the Python
  // side (see masks.select_by_color/gradient_select).
  selectUrlForTool() {
    if (this.tool === "gradient_select") return this.gradientSelectUrlValue
    if (this.tool === "select_by_color") return this.selectByColorUrlValue
    return this.fuzzySelectUrlValue
  }

  // Clicks outside the canvas (GIMP allows this, e.g. to place a free-select
  // vertex past the image edge without having to hit the edge pixel exactly)
  // are clamped to the nearest in-bounds pixel rather than left negative or
  // beyond width/height, so every downstream consumer of these coordinates
  // (Python rasterization, overlay preview math) only ever sees valid points.
  eventToImageCoordinates(event) {
    const rect = this.overlayCanvasTarget.getBoundingClientRect()
    const x = Math.round((event.clientX - rect.left) * (this.overlayCanvasTarget.width / rect.width))
    const y = Math.round((event.clientY - rect.top) * (this.overlayCanvasTarget.height / rect.height))
    return {
      x: Math.min(Math.max(x, 0), this.overlayCanvasTarget.width - 1),
      y: Math.min(Math.max(y, 0), this.overlayCanvasTarget.height - 1),
    }
  }

  // GIMP-style free select (lasso): each click adds a vertex to the
  // in-progress path. The first point is drawn as an enlarged handle (see
  // renderOverlay()) — clicking back within its hit radius closes the path
  // and submits the polygon as a selection, same as completing a round trip
  // in GIMP. Ctrl/Cmd+click on that closing click adds the result to the
  // current selection instead of replacing it, mirroring fuzzy select's
  // add-to-selection modifier; Shift+click on the closing click instead
  // subtracts the polygon from the current selection.
  async freeSelectClick(x, y, event) {
    if (this.freeSelectPoints.length >= 3 && this.isNearFirstPoint(x, y)) {
      const addToSelection = event.metaKey || event.ctrlKey
      const subtractFromSelection = event.shiftKey
      await this.submitFreeSelect(addToSelection, subtractFromSelection)
      return
    }

    this.freeSelectPoints.push({ x, y })
    this.renderOverlay()
  }

  isNearFirstPoint(x, y) {
    const [first] = this.freeSelectPoints
    const dx = x - first.x
    const dy = y - first.y
    return Math.sqrt(dx * dx + dy * dy) <= FREE_SELECT_HANDLE_RADIUS
  }

  async submitFreeSelect(addToSelection, subtractFromSelection) {
    const points = this.freeSelectPoints
    this.freeSelectPoints = []

    this.setStatus("Working…")

    const response = await this.post(this.freeSelectUrlValue, {
      points: points.map((point) => ({ x: point.x, y: point.y })),
      add: addToSelection,
      subtract: subtractFromSelection,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      this.renderOverlay()
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Line select: click one point, then click a second point — every pixel
  // on the segment between them (stroked to Brush Size width) is added to
  // the selection. Unlike free select there's no closing gesture; the
  // second click submits immediately. Ctrl/Cmd+click on that second click
  // unions the line into the current selection (same modifier convention as
  // every other select tool); Shift+click subtracts it instead.
  async lineSelectClick(x, y, event) {
    if (!this.lineSelectStart) {
      this.lineSelectStart = { x, y }
      this.renderOverlay()
      return
    }

    const addToSelection = event.metaKey || event.ctrlKey
    const subtractFromSelection = event.shiftKey
    await this.submitLineSelect(x, y, addToSelection, subtractFromSelection)
  }

  async submitLineSelect(x, y, addToSelection, subtractFromSelection) {
    const start = this.lineSelectStart
    this.lineSelectStart = null
    this.lineSelectPointer = null

    this.setStatus("Working…")

    const response = await this.post(this.lineSelectUrlValue, {
      x1: start.x, y1: start.y, x2: x, y2: y,
      brush_size: this.brushSize,
      add: addToSelection, subtract: subtractFromSelection,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      this.renderOverlay()
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Rectangle select: click one corner, then click the opposite corner —
  // every pixel in the axis-aligned rectangle between them is selected.
  // Unlike line select there's no brush size (the whole enclosed area is
  // filled, not stroked); otherwise the same two-click shape, submitting
  // immediately on the second click with the same add/subtract modifiers.
  async rectSelectClick(x, y, event) {
    if (!this.rectSelectStart) {
      this.rectSelectStart = { x, y }
      this.renderOverlay()
      return
    }

    const addToSelection = event.metaKey || event.ctrlKey
    const subtractFromSelection = event.shiftKey
    await this.submitRectSelect(x, y, addToSelection, subtractFromSelection)
  }

  async submitRectSelect(x, y, addToSelection, subtractFromSelection) {
    const start = this.rectSelectStart
    this.rectSelectStart = null
    this.rectSelectPointer = null

    this.setStatus("Working…")

    const response = await this.post(this.rectSelectUrlValue, {
      x1: start.x, y1: start.y, x2: x, y2: y,
      add: addToSelection, subtract: subtractFromSelection,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      this.renderOverlay()
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Smooth Auto Fill: only usable with an existing selection (like Split
  // Selection — there's no selection to limit the fill to otherwise). Click
  // one point, then a second point — those two set a direction vector, not a
  // segment endpoint pair (same "direction/position only" convention as
  // Split Selection's line, not Line Select's stroke endpoints). The second
  // click submits immediately; no add/subtract modifier, since this doesn't
  // change what's selected, only the pixel colors within it.
  async smoothAutoFillClick(x, y) {
    if (!this.selectionPath) return

    if (!this.smoothAutoFillStart) {
      this.smoothAutoFillStart = { x, y }
      this.renderOverlay()
      return
    }

    await this.submitSmoothAutoFill(x, y)
  }

  async submitSmoothAutoFill(x, y) {
    const start = this.smoothAutoFillStart
    this.smoothAutoFillStart = null
    this.smoothAutoFillPointer = null

    this.setStatus("Working…")

    const response = await this.post(this.smoothAutoFillUrlValue, {
      x1: start.x, y1: start.y, x2: x, y2: y, tolerance: this.tolerance,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      this.renderOverlay()
      return
    }

    const { final_image_url } = await response.json()
    await this.redrawCanvas(final_image_url)
    this.setStatus("")
  }

  // Brush tool (GIMP foreground-select style): draws entirely client-side
  // while strokes accumulate in this.brushStrokes — nothing is sent to Rails
  // until the user picks Add/Remove/New Selection from the tool options, so
  // freehand dragging never round-trips per frame. While active, the whole
  // canvas is tinted blue and every painted stroke punches a hole in that
  // tint (via "destination-out", see punchBrushStroke()) so the original
  // image shows through wherever the user has drawn — the same visual
  // language as GIMP's foreground/quick-mask select tools, just to make the
  // in-progress drawing legible against the tint rather than to hide it.
  // Uncommitted strokes live on their own canvas layer (brushCanvasTarget),
  // stacked between the image and the marching-ants overlay, so committing
  // is just a fetch + drawMask() the same as every other tool and this
  // layer gets cleared, never touching selectionPath itself.
  renderBrushCanvas() {
    const canvas = this.brushCanvasTarget
    const context = canvas.getContext("2d")
    context.clearRect(0, 0, canvas.width, canvas.height)

    if (this.tool !== "brush") return

    context.globalCompositeOperation = "source-over"
    context.fillStyle = "rgba(51, 136, 255, 0.35)"
    context.fillRect(0, 0, canvas.width, canvas.height)

    context.globalCompositeOperation = "destination-out"
    context.fillStyle = "rgba(0, 0, 0, 1)"
    context.strokeStyle = "rgba(0, 0, 0, 1)"
    context.lineWidth = this.brushSize
    context.lineCap = "round"
    context.lineJoin = "round"

    this.brushStrokes.forEach((points) => this.punchBrushStroke(context, points))

    context.globalCompositeOperation = "source-over"

    if (this.brushPointer && !this.brushDrawing) {
      context.strokeStyle = "rgba(255, 255, 255, 0.9)"
      context.lineWidth = 1
      context.beginPath()
      context.arc(this.brushPointer.x, this.brushPointer.y, this.brushSize / 2, 0, Math.PI * 2)
      context.stroke()
    }
  }

  // Punches one stroke's path out of the blue tint. A single point (a click
  // with no drag) needs an explicit dot — stroke()ing a zero-length path
  // draws nothing even with round line caps.
  punchBrushStroke(context, points) {
    if (points.length === 0) return

    if (points.length === 1) {
      context.beginPath()
      context.arc(points[0].x, points[0].y, this.brushSize / 2, 0, Math.PI * 2)
      context.fill()
      return
    }

    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    points.slice(1).forEach((point) => context.lineTo(point.x, point.y))
    context.stroke()
  }

  clearBrushCanvas() {
    const context = this.brushCanvasTarget.getContext("2d")
    context.clearRect(0, 0, this.brushCanvasTarget.width, this.brushCanvasTarget.height)
  }

  // The three submission buttons in the brush tool's options: Add unions the
  // painted strokes into the current selection, Remove subtracts them,
  // New Selection replaces the current selection with just the painted
  // strokes — same add/subtract/replace semantics as every other select
  // tool's modifier keys (see mask_with_modifier server-side), just exposed
  // as buttons instead of Ctrl/Cmd/Shift because a brush stroke is drawn
  // over multiple mousedowns rather than ending on a single qualifying click.
  submitBrushAdd() {
    return this.enqueue(() => this.submitBrush({ add: true, subtract: false }))
  }

  submitBrushRemove() {
    return this.enqueue(() => this.submitBrush({ add: false, subtract: true }))
  }

  submitBrushNew() {
    return this.enqueue(() => this.submitBrush({ add: false, subtract: false }))
  }

  async submitBrush({ add, subtract }) {
    if (this.brushStrokes.length === 0) return

    const strokes = this.brushStrokes
    this.brushStrokes = []
    this.brushDrawing = false
    this.currentBrushStroke = null
    this.clearBrushCanvas()

    this.setStatus("Working…")

    const response = await this.post(this.brushSelectUrlValue, {
      strokes: strokes.map((points) => points.map((point) => ({ x: point.x, y: point.y }))),
      brush_size: this.brushSize,
      add, subtract,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Split Selection: only usable when a selection already exists (like
  // invert/grow/border, this transforms the current selection rather than
  // adding a fresh region — see DESIGN.md §1). Click one point, then a
  // second point — those two define an infinite line's direction, not a
  // segment endpoint pair the way line select's two clicks do — then a third
  // click on whichever side of that line should be kept. The other side of
  // the selection is discarded. No add/subtract modifier: like invert, this
  // is a one-shot transform, not a click-to-add operation.
  async splitSelectionClick(x, y) {
    if (!this.selectionPath) return

    if (!this.splitSelectionLine) {
      this.splitSelectionLine = { x1: x, y1: y, x2: null, y2: null }
      this.renderOverlay()
      return
    }

    if (this.splitSelectionLine.x2 === null) {
      this.splitSelectionLine.x2 = x
      this.splitSelectionLine.y2 = y
      this.renderOverlay()
      return
    }

    await this.submitSplitSelection(x, y)
  }

  async submitSplitSelection(keepX, keepY) {
    const { x1, y1, x2, y2 } = this.splitSelectionLine
    this.splitSelectionLine = null
    this.splitSelectionPointer = null

    this.setStatus("Working…")

    const response = await this.post(this.splitSelectionUrlValue, {
      x1, y1, x2, y2, keep_x: keepX, keep_y: keepY,
    })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      this.renderOverlay()
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  invert() {
    return this.enqueue(() => this.invertNow())
  }

  async invertNow() {
    if (!this.selectionPath) return

    this.setStatus("Working…")
    const response = await this.post(this.invertUrlValue, {})
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // GIMP's Select > Remove Holes: folds any unselected region fully
  // enclosed by the current selection into the selection itself.
  removeHoles() {
    return this.enqueue(() => this.removeHolesNow())
  }

  async removeHolesNow() {
    if (!this.selectionPath) return

    this.setStatus("Working…")
    const response = await this.post(this.removeHolesUrlValue, {})
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Gradient Select from Selection: walks outward from the current
  // selection's boundary using the same tolerance-against-the-last-pixel
  // logic as Gradient Select, instead of a single clicked seed. Intended
  // flow (see DESIGN.md §1): Gradient Select to a hard edge, Grow Selection
  // to expand past it, then this to keep walking the gradient beyond that
  // edge — repeat until the whole object is selected. Reuses the Threshold
  // tool option already in the sidebar rather than prompting for a new
  // value, since it's the same "how much drift counts as still connected"
  // knob Gradient Select itself uses.
  gradientSelectFromSelection() {
    return this.enqueue(() => this.gradientSelectFromSelectionNow())
  }

  async gradientSelectFromSelectionNow() {
    if (!this.selectionPath) return

    this.setStatus("Working…")
    const response = await this.post(this.gradientSelectFromSelectionUrlValue, { tolerance: this.tolerance })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // GIMP's Select > Grow / Select > Border both prompt for a border size via
  // the same shared dialog before running — opening either just remembers
  // which operation to run on confirm (this.borderSizeAction) and shows the
  // dialog pre-filled with the last-used size (shared preference, see
  // restoreBorderSize()).
  openGrowSelectionDialog() {
    return this.enqueue(() => {
      if (!this.selectionPath) return
      this.openBorderSizeDialog("growSelection", "Grow Selection")
    })
  }

  openSelectBorderDialog() {
    return this.enqueue(() => {
      if (!this.selectionPath) return
      this.openBorderSizeDialog("selectBorder", "Select Border")
    })
  }

  openBorderSizeDialog(action, title) {
    this.borderSizeAction = action
    this.borderSizeDialogTitleTarget.textContent = title
    this.borderSizeInputTarget.value = this.borderSize
    this.borderSizeDialogTarget.showModal()
  }

  closeBorderSizeDialog() {
    this.borderSizeDialogTarget.close()
  }

  // Not itself wrapped in enqueue(): the dialog only ever opens from
  // openGrowSelectionDialog/openSelectBorderDialog above, which already ran
  // (and finished) inside the queue to get here, and showModal() blocks
  // further tool actions at the UI level until the user confirms/cancels —
  // there's no fresh guard read here that could be stale.
  async confirmBorderSizeDialog() {
    this.setBorderSize(parseInt(this.borderSizeInputTarget.value, 10))
    this.borderSizeDialogTarget.close()

    if (this.borderSizeAction === "growSelection") {
      await this.growSelection()
    } else if (this.borderSizeAction === "selectBorder") {
      await this.selectBorder()
    }
  }

  growSelection() {
    return this.enqueue(() => this.growSelectionNow())
  }

  async growSelectionNow() {
    this.setStatus("Working…")
    const response = await this.post(this.growSelectionUrlValue, { border_size: this.borderSize })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  selectBorder() {
    return this.enqueue(() => this.selectBorderNow())
  }

  async selectBorderNow() {
    this.setStatus("Working…")
    const response = await this.post(this.selectBorderUrlValue, { border_size: this.borderSize })
    if (!response.ok) {
      this.setStatus("Operation failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Border Size is a shared preference between Grow Selection and Select
  // Border (GIMP itself remembers one size across both), persisted the same
  // client-side-UI-preference way as Threshold/Brush Size (see DESIGN.md §3).
  restoreBorderSize() {
    const stored = parseInt(localStorage.getItem(BORDER_SIZE_STORAGE_KEY), 10)
    this.setBorderSize(Number.isFinite(stored) ? stored : BORDER_SIZE_DEFAULT)
  }

  borderSizeInputChanged(event) {
    this.setBorderSize(parseInt(event.target.value, 10))
  }

  borderSizeStepUp() {
    this.setBorderSize(this.borderSize + BORDER_SIZE_STEP)
  }

  borderSizeStepDown() {
    this.setBorderSize(this.borderSize - BORDER_SIZE_STEP)
  }

  setBorderSize(value) {
    if (!Number.isFinite(value)) value = BORDER_SIZE_DEFAULT
    const clamped = Math.min(BORDER_SIZE_MAX, Math.max(BORDER_SIZE_MIN, value))

    this.borderSize = clamped
    this.borderSizeInputTarget.value = clamped
    localStorage.setItem(BORDER_SIZE_STORAGE_KEY, clamped)
  }

  // Saves the current selection into one of up to 3 slots server-side (see
  // EditSession#save_selection! / DESIGN.md §3) so it can be recalled later
  // via Merge Saved Selection. Once all 3 slots are full, saving again rolls
  // the oldest one off — no dialog needed here since there's nothing for the
  // user to choose, unlike merge below.
  saveSelection() {
    return this.enqueue(() => this.saveSelectionNow())
  }

  async saveSelectionNow() {
    if (!this.selectionPath) return

    this.setStatus("Working…")
    const response = await this.post(this.saveSelectionUrlValue, {})
    if (!response.ok) {
      this.setStatus("Save failed.")
      return
    }

    this.setStatus("Selection saved.")
  }

  // Opens the Merge Saved Selection dialog: fetches the current session's
  // saved selections and renders one row per slot (thumbnail + Merge
  // button), same fetch-then-render-fragment shape as the Load Session
  // dialog in global_actions_controller.js, just via JSON instead of an HTML
  // fragment since there's no server-side partial needed for three rows.
  async openMergeSelectionDialog() {
    this.setStatus("Working…")
    const response = await fetch(this.savedSelectionsUrlValue)
    if (!response.ok) {
      this.setStatus("Could not load saved selections.")
      return
    }

    const { saved_selections } = await response.json()
    this.renderSavedSelectionList(saved_selections)
    this.mergeSelectionDialogTarget.showModal()
    this.setStatus("")
  }

  closeMergeSelectionDialog() {
    this.mergeSelectionDialogTarget.close()
  }

  renderSavedSelectionList(savedSelections) {
    const list = this.savedSelectionListTarget
    list.innerHTML = ""

    if (savedSelections.length === 0) {
      const empty = document.createElement("li")
      empty.className = "saved-selection-empty"
      empty.textContent = "No saved selections yet."
      list.appendChild(empty)
      return
    }

    savedSelections.forEach((savedSelection) => {
      const item = document.createElement("li")
      item.className = "saved-selection-item"

      const thumb = document.createElement("img")
      thumb.className = "saved-selection-thumb"
      thumb.src = savedSelection.mask_url

      const label = document.createElement("span")
      label.textContent = `Slot ${savedSelection.slot + 1}`

      const mergeButton = document.createElement("button")
      mergeButton.type = "button"
      mergeButton.className = "dialog-button dialog-button-primary"
      mergeButton.textContent = "Merge"
      mergeButton.addEventListener("click", () => this.mergeSelection(savedSelection.id))

      item.append(thumb, label, mergeButton)
      list.appendChild(item)
    })
  }

  // Unions the current selection with the chosen saved one (Rails/Python
  // side runs /combine, see EditSession#merge_selection!) and redraws the
  // result — same mask-in/mask-out response shape as every other select op.
  mergeSelection(savedSelectionId) {
    return this.enqueue(() => this.mergeSelectionNow(savedSelectionId))
  }

  async mergeSelectionNow(savedSelectionId) {
    this.mergeSelectionDialogTarget.close()
    this.setStatus("Working…")

    const response = await this.post(this.mergeSelectionUrlValue, { saved_selection_id: savedSelectionId })
    if (!response.ok) {
      this.setStatus("Merge failed.")
      return
    }

    const { mask_url } = await response.json()
    this.drawMask(mask_url)
    this.setStatus("")
  }

  // Clears the current selection to transparent (Delete/Backspace, GIMP's
  // Edit > Clear). Distinct from download — this only updates the canvas.
  // The mask stays attached server-side (matches GIMP: clearing doesn't
  // deselect), so the selection outline keeps showing over the now-cleared
  // area rather than disappearing.
  clearSelection() {
    return this.enqueue(() => this.clearSelectionNow())
  }

  async clearSelectionNow() {
    if (!this.selectionPath) return

    this.setStatus("Clearing selection…")

    const response = await this.post(this.deleteUrlValue, {})
    if (!response.ok) {
      this.setStatus("Clear failed.")
      return
    }

    const { final_image_url } = await response.json()
    await this.redrawCanvas(final_image_url)
    this.setStatus("Selection cleared.")
  }

  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (GIMP-style undo/redo, see DESIGN.md §3).
  // Every fuzzy_select/invert/delete is one history step; the server is the
  // sole owner of position and both attachments, so undo/redo just fetches
  // whatever it now points at and redraws — same pattern as every other tool.
  undo() {
    return this.enqueue(() => this.stepHistory(this.undoUrlValue, "Nothing to undo."))
  }

  redo() {
    return this.enqueue(() => this.stepHistory(this.redoUrlValue, "Nothing to redo."))
  }

  async stepHistory(url, emptyMessage) {
    this.freeSelectPoints = []
    this.lineSelectStart = null
    this.lineSelectPointer = null
    this.rectSelectStart = null
    this.rectSelectPointer = null
    this.smoothAutoFillStart = null
    this.smoothAutoFillPointer = null
    this.cancelBrush()
    this.setStatus("Working…")

    const response = await this.post(url, {})
    if (!response.ok) {
      this.setStatus(emptyMessage)
      return
    }

    const { mask_url, final_image_url } = await response.json()
    await this.redrawCanvas(final_image_url)

    if (mask_url) {
      this.drawMask(mask_url)
    } else {
      this.selectionPath = null
      this.clearOverlay()
    }
    this.setStatus("")
  }

  redrawCanvas(imageUrl) {
    return new Promise((resolve) => {
      this.image.onload = () => {
        const context = this.imageCanvasTarget.getContext("2d")
        context.clearRect(0, 0, this.imageCanvasTarget.width, this.imageCanvasTarget.height)
        context.drawImage(this.image, 0, 0)
        resolve()
      }
      this.image.src = imageUrl
    })
  }

  // Exports whatever the canvas currently shows — the original image if
  // nothing has been cleared yet, or the transparent cutout after Delete.
  download() {
    const link = document.createElement("a")
    link.href = this.exportUrlValue
    link.download = "sprite.png"
    link.click()

    this.setStatus("Downloaded.")
  }

  async post(url, params) {
    const body = new URLSearchParams()
    this.appendFormParams(body, params)
    return fetch(url, {
      method: "POST",
      headers: {
        "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]').content,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    })
  }

  // Rails-style bracket encoding for nested params (e.g. free select's
  // `points` array of {x, y} objects) — URLSearchParams itself only handles
  // flat key/value pairs, so arrays/objects need `key[]`/`key[subkey]` keys
  // for Rails' param parser to rebuild them into an array of hashes. An
  // array of arrays (brush select's `strokes`, one point-array per stroke)
  // needs the outer level explicitly indexed (`key[0][]`, `key[1][]`, ...)
  // rather than `key[][]` for every stroke: Rack's parser can't tell where
  // one `[]`-nested array ends and the next begins when both levels are
  // unindexed, and silently collapses every stroke's points into the last
  // stroke alone. A flat array of scalars/objects (every other array this
  // app sends) has no such ambiguity, so only the array-of-arrays case needs
  // the extra index.
  appendFormParams(body, value, prefix = null) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const key = Array.isArray(item) ? `${prefix}[${index}]` : `${prefix}[]`
        this.appendFormParams(body, item, key)
      })
    } else if (value !== null && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        this.appendFormParams(body, item, prefix ? `${prefix}[${key}]` : key)
      })
    } else {
      body.append(prefix, value)
    }
  }

  drawMask(maskUrl) {
    const maskImage = new Image()
    maskImage.onload = () => {
      const scratch = document.createElement("canvas")
      scratch.width = maskImage.width
      scratch.height = maskImage.height
      const scratchContext = scratch.getContext("2d")
      scratchContext.drawImage(maskImage, 0, 0)

      const { width, height, data } = scratchContext.getImageData(0, 0, scratch.width, scratch.height)
      const selected = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false
        return data[(y * width + x) * 4] > 127 // mask is single-channel 0/255, read from the R byte
      }

      this.selectionPath = this.traceSelectionBoundary(width, height, selected)
      this.renderOverlay()
    }
    maskImage.src = maskUrl
  }

  // Selection is shown GIMP-style as "marching ants": a black-and-white
  // dashed outline traced along the selection boundary, with the dash
  // offset scrolling continuously (driven by march(), not color
  // alternation) so it stays readable against any background. No tint
  // over the selected pixels — it obscured the image underneath. An
  // in-progress free-select path (see freeSelectClick()) draws on top of
  // that, if present — the two aren't mutually exclusive, since starting a
  // new lasso doesn't clear the existing selection until you close the path.
  renderOverlay() {
    this.clearOverlay()

    const context = this.overlayCanvasTarget.getContext("2d")

    if (this.selectionPath) {
      context.lineWidth = 1.5
      context.setLineDash([4, 4])

      context.lineDashOffset = -this.marchOffset
      context.strokeStyle = "black"
      context.stroke(this.selectionPath)

      context.lineDashOffset = -this.marchOffset + 4
      context.strokeStyle = "white"
      context.stroke(this.selectionPath)
    }

    if (this.freeSelectPoints.length > 0) {
      this.renderFreeSelectPath(context)
    }

    if (this.lineSelectStart) {
      this.renderLineSelectPreview(context)
    }

    if (this.rectSelectStart) {
      this.renderRectSelectPreview(context)
    }

    if (this.splitSelectionLine) {
      this.renderSplitSelectionPreview(context)
    }

    if (this.smoothAutoFillStart) {
      this.renderSmoothAutoFillPreview(context)
    }
  }

  // Draws the in-progress line select: a plain (non-marching) line from the
  // placed first point to the current pointer position, stroked at Brush
  // Size width so the preview shows exactly what will be selected — plus a
  // small dot marking the placed first point. Only rendered once a first
  // point exists (see lineSelectClick()); nothing to preview before that.
  renderLineSelectPreview(context) {
    const end = this.lineSelectPointer || this.lineSelectStart

    context.setLineDash([])
    context.lineWidth = this.brushSize
    context.lineCap = "round"
    context.strokeStyle = "rgba(51, 136, 255, 0.5)"

    context.beginPath()
    context.moveTo(this.lineSelectStart.x, this.lineSelectStart.y)
    context.lineTo(end.x, end.y)
    context.stroke()
    context.lineCap = "butt"

    context.fillStyle = "#3388ff"
    context.beginPath()
    context.arc(this.lineSelectStart.x, this.lineSelectStart.y, 3, 0, Math.PI * 2)
    context.fill()
  }

  // Draws the in-progress rectangle select: a dashed rectangle outline from
  // the placed first corner to the current pointer position, so the user can
  // see exactly what area will be selected before the second click commits —
  // plus a small dot marking the placed corner, same visual language as
  // renderLineSelectPreview().
  renderRectSelectPreview(context) {
    const end = this.rectSelectPointer || this.rectSelectStart

    context.setLineDash([4, 4])
    context.lineWidth = 1
    context.strokeStyle = "rgba(51, 136, 255, 0.8)"
    context.fillStyle = "rgba(51, 136, 255, 0.15)"

    const x = Math.min(this.rectSelectStart.x, end.x)
    const y = Math.min(this.rectSelectStart.y, end.y)
    const width = Math.abs(end.x - this.rectSelectStart.x)
    const height = Math.abs(end.y - this.rectSelectStart.y)

    context.fillRect(x, y, width, height)
    context.strokeRect(x, y, width, height)
    context.setLineDash([])

    context.fillStyle = "#3388ff"
    context.beginPath()
    context.arc(this.rectSelectStart.x, this.rectSelectStart.y, 3, 0, Math.PI * 2)
    context.fill()
  }

  // Draws the in-progress Smooth Auto Fill vector pick: a plain line from
  // the placed first point to the current pointer position, same visual
  // language as renderLineSelectPreview() but at a fixed 1px width — unlike
  // Line Select's stroke, this line only conveys direction, not an area that
  // will be selected, so there's no Brush-Size-width preview to show.
  renderSmoothAutoFillPreview(context) {
    const end = this.smoothAutoFillPointer || this.smoothAutoFillStart

    context.setLineDash([])
    context.lineWidth = 1.5
    context.strokeStyle = "rgba(51, 136, 255, 0.8)"

    context.beginPath()
    context.moveTo(this.smoothAutoFillStart.x, this.smoothAutoFillStart.y)
    context.lineTo(end.x, end.y)
    context.stroke()

    context.fillStyle = "#3388ff"
    context.beginPath()
    context.arc(this.smoothAutoFillStart.x, this.smoothAutoFillStart.y, 3, 0, Math.PI * 2)
    context.fill()
  }

  // Draws the in-progress split selection. Before the second point is
  // placed, this is just a dot-to-pointer preview line, same as line
  // select's first-point preview. Once both direction points are placed, the
  // two points no longer mark a segment — they only set a direction — so the
  // preview instead extends that direction to the full canvas bounds
  // (clipExtendedLine()) to make clear the split runs the whole way across
  // the image, and follows the pointer to preview which side a third click
  // would keep by tinting that half of the canvas.
  renderSplitSelectionPreview(context) {
    const { x1, y1, x2, y2 } = this.splitSelectionLine

    context.setLineDash([])
    context.fillStyle = "#3388ff"
    context.beginPath()
    context.arc(x1, y1, 3, 0, Math.PI * 2)
    context.fill()

    if (x2 === null) {
      const end = this.splitSelectionPointer || { x: x1, y: y1 }
      context.lineWidth = 1
      context.strokeStyle = "#3388ff"
      context.beginPath()
      context.moveTo(x1, y1)
      context.lineTo(end.x, end.y)
      context.stroke()
      return
    }

    context.fillStyle = "#3388ff"
    context.beginPath()
    context.arc(x2, y2, 3, 0, Math.PI * 2)
    context.fill()

    const width = this.overlayCanvasTarget.width
    const height = this.overlayCanvasTarget.height
    const extended = this.clipExtendedLine(x1, y1, x2, y2, width, height)

    context.lineWidth = 1.5
    context.strokeStyle = "#ff3838"
    if (extended) {
      context.beginPath()
      context.moveTo(extended.from.x, extended.from.y)
      context.lineTo(extended.to.x, extended.to.y)
      context.stroke()
    }

    const keepPoint = this.splitSelectionPointer
    if (keepPoint) {
      const dx = x2 - x1
      const dy = y2 - y1
      const side = (keepPoint.x - x1) * dy - (keepPoint.y - y1) * dx

      context.fillStyle = "rgba(51, 136, 255, 0.15)"
      context.beginPath()
      if (side >= 0) {
        this.tracePositiveSidePolygon(context, x1, y1, dx, dy, width, height)
      } else {
        this.tracePositiveSidePolygon(context, x1, y1, -dx, -dy, width, height)
      }
      context.fill()
    }
  }

  // Extends the infinite line through (x1, y1)/(x2, y2) to the two points
  // where it crosses the canvas bounds, so the preview shows the whole line
  // the split will actually run along rather than just the short segment
  // between the two clicked points (which only set direction, not extent —
  // see splitSelectionClick()). Returns null in the degenerate case where
  // both points coincide (no direction to extend).
  clipExtendedLine(x1, y1, x2, y2, width, height) {
    const dx = x2 - x1
    const dy = y2 - y1
    if (dx === 0 && dy === 0) return null

    const candidates = []
    if (dx !== 0) {
      candidates.push((0 - x1) / dx, (width - x1) / dx)
    }
    if (dy !== 0) {
      candidates.push((0 - y1) / dy, (height - y1) / dy)
    }

    const points = candidates
      .map((t) => ({ x: x1 + t * dx, y: y1 + t * dy, t }))
      .filter((point) => point.x >= -1 && point.x <= width + 1 && point.y >= -1 && point.y <= height + 1)

    if (points.length < 2) return null

    points.sort((a, b) => a.t - b.t)
    return { from: points[0], to: points[points.length - 1] }
  }

  // Fills the half of the canvas on the side of the line through (x1, y1)
  // with direction (dx, dy) where the cross-product test is > 0 — the same
  // sign test masks.split_selection uses server-side. A half-plane clipped
  // to a rectangle is the polygon: the line's two boundary-crossing points,
  // plus whichever canvas corners fall on the kept side — but those corners
  // must be visited in the order encountered while walking the rectangle's
  // perimeter from one crossing point to the other, not in a fixed corner
  // order, or the polygon "bowties" (self-intersects, filling nothing)
  // whenever the kept corners straddle the start of that fixed order.
  tracePositiveSidePolygon(context, x1, y1, dx, dy, width, height) {
    const extended = this.clipExtendedLine(x1, y1, x1 + dx, y1 + dy, width, height)
    if (!extended) return

    const corners = [
      { x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height },
    ]
    const side = (point) => (point.x - x1) * dy - (point.y - y1) * dx
    const keptCorners = corners.filter((corner) => side(corner) > 0)

    // Perimeter position in [0, 4), walking clockwise from the top-left
    // corner — used to order points along the rectangle boundary regardless
    // of which edge they fall on.
    const perimeterPosition = (point) => {
      if (point.y <= 0) return point.x / width
      if (point.x >= width) return 1 + point.y / height
      if (point.y >= height) return 2 + (width - point.x) / width
      return 3 + (height - point.y) / height
    }
    const arcLength = (from, to) => (to - from + 4) % 4

    const fromPosition = perimeterPosition(extended.from)
    const toPosition = perimeterPosition(extended.to)
    const onForwardArc = keptCorners.filter(
      (corner) => arcLength(fromPosition, perimeterPosition(corner)) < arcLength(fromPosition, toPosition)
    )

    // Kept corners walking forward from `from` to `to` means that arc holds
    // the kept region; otherwise it's the other arc, walking from `to` to
    // `from` instead.
    const [start, end, ordered] = onForwardArc.length > 0 || keptCorners.length === 0
      ? [extended.from, extended.to, onForwardArc.sort((a, b) => arcLength(fromPosition, perimeterPosition(a)) - arcLength(fromPosition, perimeterPosition(b)))]
      : [extended.to, extended.from, keptCorners.sort((a, b) => arcLength(toPosition, perimeterPosition(a)) - arcLength(toPosition, perimeterPosition(b)))]

    const points = [ start, ...ordered, end ]
    context.moveTo(points[0].x, points[0].y)
    points.slice(1).forEach((point) => context.lineTo(point.x, point.y))
    context.closePath()
  }

  // Draws the in-progress free-select path as a plain (non-marching) solid
  // line, plus an enlarged handle circle on the first point — GIMP-style,
  // made deliberately big enough to click on to close the path (see
  // isNearFirstPoint()/freeSelectClick()).
  renderFreeSelectPath(context) {
    const [first, ...rest] = this.freeSelectPoints

    context.setLineDash([])
    context.lineWidth = 1
    context.strokeStyle = "#3388ff"
    context.fillStyle = "rgba(51, 136, 255, 0.3)"

    context.beginPath()
    context.moveTo(first.x, first.y)
    rest.forEach((point) => context.lineTo(point.x, point.y))
    context.stroke()

    context.beginPath()
    context.arc(first.x, first.y, FREE_SELECT_HANDLE_RADIUS, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  }

  // Builds a Path2D tracing the boundary between selected/unselected pixels:
  // collects a unit edge for every side of a selected pixel that borders an
  // unselected one (or the image edge), then chains them into continuous
  // subpaths (one per contour) so a dash pattern spans real distance instead
  // of restarting on every 1px edge. Cheap and exact for the small
  // per-session images this editor targets; a marching-squares contour pass
  // would be the next step if that ever stops being true.
  traceSelectionBoundary(width, height, selected) {
    const key = (x, y) => `${x},${y}`
    const edgesFrom = new Map() // point key -> [{to, key}]

    const addEdge = (fromX, fromY, toX, toY) => {
      const fromKey = key(fromX, fromY)
      if (!edgesFrom.has(fromKey)) edgesFrom.set(fromKey, [])
      edgesFrom.get(fromKey).push({ x: toX, y: toY })
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!selected(x, y)) continue

        if (!selected(x, y - 1)) addEdge(x, y, x + 1, y)
        if (!selected(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1)
        if (!selected(x - 1, y)) addEdge(x, y + 1, x, y)
        if (!selected(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1)
      }
    }

    const path = new Path2D()
    while (edgesFrom.size > 0) {
      const [startKey] = edgesFrom.keys()
      let [x, y] = startKey.split(",").map(Number)
      path.moveTo(x, y)

      while (true) {
        const fromKey = key(x, y)
        const outgoing = edgesFrom.get(fromKey)
        if (!outgoing || outgoing.length === 0) break

        const next = outgoing.pop()
        if (outgoing.length === 0) edgesFrom.delete(fromKey)

        path.lineTo(next.x, next.y)
        x = next.x
        y = next.y
      }
    }
    return path
  }

  clearOverlay() {
    const context = this.overlayCanvasTarget.getContext("2d")
    context.clearRect(0, 0, this.overlayCanvasTarget.width, this.overlayCanvasTarget.height)
  }

  setStatus(message) {
    this.statusTarget.textContent = message
  }
}
