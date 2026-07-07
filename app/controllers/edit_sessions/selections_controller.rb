module EditSessions
  # The selection tools (§1, §4 of DESIGN.md). Each action calls
  # PixelEngineClient for the pixel math and persists the result on EditSession,
  # which stays the sole owner of "what is currently selected."
  class SelectionsController < ApplicationController
    before_action :set_edit_session
    around_action :lock_edit_session, except: [:saved_selections]

    # One Mutex per EditSession id, used by lock_edit_session below to
    # serialize concurrent tool-operation requests against the same session.
    # Lazily created and never evicted, same "no cleanup job yet" posture as
    # EditSession/snapshot rows themselves (see DESIGN.md §1) — acceptable
    # since this holds only a handful of tiny Mutex objects per session ever
    # touched, in a single Puma process/worker (see config/puma.rb).
    MUTEXES_LOCK = Mutex.new
    MUTEXES = {}

    def self.mutex_for(edit_session_id)
      MUTEXES_LOCK.synchronize { MUTEXES[edit_session_id] ||= Mutex.new }
    end

    def fuzzy_select
      region_mask = pixel_engine.fuzzy_select(
        image: @edit_session.display_image.download,
        x: params.require(:x).to_i,
        y: params.require(:y).to_i,
        tolerance: params.fetch(:tolerance, 32).to_i
      )

      @edit_session.record_snapshot!(operation: "fuzzy_select", mask_bytes: mask_with_modifier(region_mask))
      render_mask
    end

    # Like fuzzy_select, but walks outward comparing each candidate pixel to
    # the already-selected neighbor it was reached from rather than the
    # original seed color — see masks.gradient_select for why this needs its
    # own Python endpoint instead of reusing fuzzy_select's flood-fill.
    def gradient_select
      region_mask = pixel_engine.gradient_select(
        image: @edit_session.display_image.download,
        x: params.require(:x).to_i,
        y: params.require(:y).to_i,
        tolerance: params.fetch(:tolerance, 32).to_i
      )

      @edit_session.record_snapshot!(operation: "gradient_select", mask_bytes: mask_with_modifier(region_mask))
      render_mask
    end

    # GIMP's Select > By Color: selects every pixel in the image within
    # tolerance of the clicked color, regardless of whether it's connected to
    # the clicked point — unlike fuzzy_select's flood-fill, which only reaches
    # contiguous pixels. Useful for distributed objects (e.g. stray hairs
    # scattered across a background) where one click should grab every
    # matching pixel at once. Same add/subtract/replace modifier conventions
    # as every other click-based select tool.
    def select_by_color
      region_mask = pixel_engine.select_by_color(
        image: @edit_session.display_image.download,
        x: params.require(:x).to_i,
        y: params.require(:y).to_i,
        tolerance: params.fetch(:tolerance, 32).to_i
      )

      @edit_session.record_snapshot!(operation: "select_by_color", mask_bytes: mask_with_modifier(region_mask))
      render_mask
    end

    # Like gradient_select, but seeded from the whole current selection
    # boundary instead of a single clicked point — see masks.
    # gradient_select_from_selection for the BFS shape. Intended to be used
    # after gradient_select stops at a hard edge and Grow Selection has
    # expanded past it: this picks up the outward walk from every pixel on
    # the new boundary, repeating the gradient-select -> grow cycle until
    # the whole gradient region is covered (see DESIGN.md §1). Always adds
    # to the current selection — there is nothing to seed from without one.
    def gradient_select_from_selection
      return render_no_selection unless @edit_session.current_mask.attached?

      grown_mask = pixel_engine.gradient_select_from_selection(
        image: @edit_session.display_image.download,
        mask: @edit_session.current_mask.download,
        tolerance: params.fetch(:tolerance, 32).to_i
      )

      @edit_session.record_snapshot!(operation: "gradient_select_from_selection", mask_bytes: grown_mask)
      render_mask
    end

    # Ctrl/Cmd+A: replaces the current selection with the whole image, GIMP's
    # Select > All. Always a fresh full mask, never additive (there's nothing
    # a full selection could usefully be combined with).
    def select_all
      full_mask = pixel_engine.select_all(image: @edit_session.original_image.download)

      @edit_session.record_snapshot!(operation: "select_all", mask_bytes: full_mask)
      render_mask
    end

    # Ctrl/Cmd+D: clears the current selection entirely, GIMP's Select > None.
    # Distinct from delete/clear (Delete key) — this only drops the mask, it
    # never touches canvas pixels.
    def deselect_all
      return render_no_selection unless @edit_session.current_mask.attached?

      @edit_session.record_snapshot!(operation: "deselect_all", mask_bytes: nil)
      render json: { mask_url: nil }
    end

    # Free select (GIMP-style lasso/polygon select): the browser collects
    # clicked path points and closes the loop when the user clicks back near
    # the first point, then sends the full point list here in one request —
    # same shape as fuzzy_select's region-then-optional-union (see
    # mask_with_add), just rasterized from a polygon instead of flood-filled
    # from a seed pixel.
    def free_select
      points = params.require(:points).map { |point| [ point[:x].to_i, point[:y].to_i ] }
      region_mask = pixel_engine.free_select(image: @edit_session.display_image.download, points: points)

      @edit_session.record_snapshot!(operation: "free_select", mask_bytes: mask_with_modifier(region_mask))
      render_mask
    end

    # Line select: the browser sends two clicked points plus a brush size
    # (the line's stroke width) in one request — unlike free select, there's
    # no path-closing gesture, so each pair of clicks submits immediately.
    # Same mask_with_modifier add/subtract shape as every other select tool.
    def line_select
      region_mask = pixel_engine.line_select(
        image: @edit_session.display_image.download,
        x1: params.require(:x1).to_i,
        y1: params.require(:y1).to_i,
        x2: params.require(:x2).to_i,
        y2: params.require(:y2).to_i,
        brush_size: params.fetch(:brush_size, 1).to_i
      )

      @edit_session.record_snapshot!(operation: "line_select", mask_bytes: mask_with_modifier(region_mask))
      render_mask
    end

    # Brush select: the browser paints one or more freehand strokes entirely
    # client-side (see editor_controller.js) and only submits here once the
    # user picks one of the three submission buttons — add/subtract/new
    # selection map directly onto the same add/subtract params fuzzy_select/
    # free_select/line_select already use via mask_with_modifier, so a plain
    # click with neither flag (the "new selection" button) replaces as
    # normal. `strokes` is indexed (`strokes[0][]`, `strokes[1][]`, ...)
    # rather than doubly-bracketed (`strokes[][]`) on the wire — see
    # appendFormParams in editor_controller.js — so Rails parses the outer
    # level as a Parameters hash keyed by index, not an array; `.values`
    # recovers stroke order the same way the browser sent them.
    def brush_select
      strokes = params.require(:strokes).values.map do |stroke|
        stroke.map { |point| [ point[:x].to_i, point[:y].to_i ] }
      end
      region_mask = pixel_engine.brush_select(
        image: @edit_session.display_image.download,
        strokes: strokes,
        brush_size: params.fetch(:brush_size, 1).to_i
      )

      @edit_session.record_snapshot!(operation: "brush_select", mask_bytes: mask_with_modifier(region_mask))
      render_mask
    end

    def invert
      return render_no_selection unless @edit_session.current_mask.attached?

      inverted_mask = pixel_engine.invert(mask: @edit_session.current_mask.download)

      @edit_session.record_snapshot!(operation: "invert", mask_bytes: inverted_mask)
      render_mask
    end

    # Split Selection: the browser sends two points defining an infinite
    # line (direction only, not a segment — see masks.split_selection) plus a
    # third point indicating which side of that line to keep. The selection
    # is replaced with whatever part of it falls on the kept side; the other
    # side is discarded. No add/subtract modifier — like invert/grow/border,
    # this is a one-shot transform of the current selection, not a click-add
    # tool, so there's nothing to union or subtract against.
    def split_selection
      return render_no_selection unless @edit_session.current_mask.attached?

      split_mask = pixel_engine.split_selection(
        mask: @edit_session.current_mask.download,
        x1: params.require(:x1).to_i,
        y1: params.require(:y1).to_i,
        x2: params.require(:x2).to_i,
        y2: params.require(:y2).to_i,
        keep_x: params.require(:keep_x).to_i,
        keep_y: params.require(:keep_y).to_i
      )

      @edit_session.record_snapshot!(operation: "split_selection", mask_bytes: split_mask)
      render_mask
    end

    # GIMP's Select > Remove Holes: folds any fully-enclosed unselected
    # region within the current selection into the selection itself.
    def remove_holes
      return render_no_selection unless @edit_session.current_mask.attached?

      filled_mask = pixel_engine.remove_holes(mask: @edit_session.current_mask.download)

      @edit_session.record_snapshot!(operation: "remove_holes", mask_bytes: filled_mask)
      render_mask
    end

    # GIMP's Select > Grow: expands the current selection outward by
    # `border_size` pixels, adding that ring to the existing selection
    # (unlike select_border, the interior is kept).
    def grow_selection
      return render_no_selection unless @edit_session.current_mask.attached?

      grown_mask = pixel_engine.grow_selection(
        mask: @edit_session.current_mask.download,
        border_size: params.require(:border_size).to_i
      )

      @edit_session.record_snapshot!(operation: "grow_selection", mask_bytes: grown_mask)
      render_mask
    end

    # GIMP's Select > Border: replaces the current selection with just the
    # ring of `border_size` pixels straddling its boundary, dropping the
    # interior — the counterpart to grow_selection.
    def select_border
      return render_no_selection unless @edit_session.current_mask.attached?

      border_mask = pixel_engine.select_border(
        mask: @edit_session.current_mask.download,
        border_size: params.require(:border_size).to_i
      )

      @edit_session.record_snapshot!(operation: "select_border", mask_bytes: border_mask)
      render_mask
    end

    # Clears the current selection to transparent, compositing onto whatever
    # the canvas already shows (§3 of DESIGN.md) rather than the original
    # upload every time — so a second delete after a second selection doesn't
    # revert the first one. The mask carries forward unchanged: clearing
    # doesn't deselect (matches GIMP's Edit > Clear).
    def delete
      return render_no_selection unless @edit_session.current_mask.attached?

      composited_png = pixel_engine.delete(
        image: @edit_session.display_image.download,
        mask: @edit_session.current_mask.download
      )

      @edit_session.record_snapshot!(
        operation: "delete",
        mask_bytes: @edit_session.current_mask.download,
        canvas_bytes: composited_png
      )

      render json: { final_image_url: url_for(@edit_session.canvas_image) }
    end

    def undo
      return render_no_history("Nothing to undo.") unless @edit_session.undo!

      render_history_state
    end

    def redo
      return render_no_history("Nothing to redo.") unless @edit_session.redo!

      render_history_state
    end

    # Saves the current selection into one of MAX_SAVED_SELECTIONS slots
    # (rolling over the oldest once full, see EditSession#save_selection!) so
    # it can be recalled later via merge_selection. Not an undo step itself —
    # saved selections are separate from the fuzzy_select/invert/delete
    # history in §3, so this doesn't call record_snapshot!.
    def save_selection
      return render_no_selection unless @edit_session.current_mask.attached?

      @edit_session.save_selection!
      render_saved_selections
    end

    # Bare list of the current session's saved selections (thumbnail URL +
    # slot) for the merge dialog to render — same fragment-less JSON-list
    # shape as render_history_state, just for a different piece of state.
    def saved_selections
      render_saved_selections
    end

    # Unions the current selection with a previously saved one (picked from
    # the merge dialog) and records the result as a new undo step, same as
    # any other mask-producing tool operation.
    def merge_selection
      saved_selection = @edit_session.saved_selections.find(params.require(:saved_selection_id))

      @edit_session.merge_selection!(saved_selection: saved_selection, pixel_engine: pixel_engine)
      render_mask
    end

    private

    def render_no_selection
      render json: { error: "Make a selection first." }, status: :unprocessable_content
    end

    def render_no_history(message)
      render json: { error: message }, status: :unprocessable_content
    end

    def pixel_engine
      @pixel_engine ||= PixelEngineClient.new
    end

    # Shared by fuzzy_select, free_select, line_select, and brush_select: Ctrl/Cmd+click (params[:add])
    # unions the newly selected region into the current selection instead of
    # replacing it — the same union behavior the old standalone "combine"
    # tool performed, now reached as a modifier on either select tool. Shift
    # +click (params[:subtract]) instead removes the newly selected region
    # from the current selection. The two modifiers are mutually exclusive;
    # if neither is set (or there's no existing selection to modify), the
    # region replaces the current selection as normal (see DESIGN.md §1/§4).
    def mask_with_modifier(region_mask)
      return region_mask unless @edit_session.current_mask.attached?

      if ActiveModel::Type::Boolean.new.cast(params[:subtract])
        pixel_engine.subtract(mask_a: @edit_session.current_mask.download, mask_b: region_mask)
      elsif ActiveModel::Type::Boolean.new.cast(params[:add])
        pixel_engine.combine(mask_a: @edit_session.current_mask.download, mask_b: region_mask)
      else
        region_mask
      end
    end

    def render_mask
      render json: { mask_url: url_for(@edit_session.current_mask) }
    end

    # Slot + thumbnail URL for every saved selection, ordered by slot —
    # shared by save_selection's response and saved_selections' listing, and
    # what the merge dialog renders.
    def render_saved_selections
      selections = @edit_session.saved_selections.order(:slot).map do |saved_selection|
        { id: saved_selection.id, slot: saved_selection.slot, mask_url: url_for(saved_selection.mask) }
      end

      render json: { saved_selections: selections }
    end

    # After undo/redo the mask may no longer be attached (position -1 has
    # none) and the canvas may have reverted to the original image — the
    # Stimulus controller needs both URLs (or null) to redraw either.
    def render_history_state
      render json: {
        mask_url: @edit_session.current_mask.attached? ? url_for(@edit_session.current_mask) : nil,
        final_image_url: url_for(@edit_session.display_image)
      }
    end

    def set_edit_session
      @edit_session = EditSession.find(params[:edit_session_id])
    end

    # Every action here reads current_mask, does a (comparatively slow)
    # PixelEngineClient round-trip, and writes a new snapshot from what it
    # read — a classic read-modify-write. Two Ctrl/Cmd+click requests fired
    # in quick succession (Puma runs multiple threads per DESIGN.md) can
    # otherwise interleave: request B reads current_mask before request A's
    # record_snapshot! commits, so B's write clobbers A's, silently dropping
    # A's region from the selection. Holding this session's mutex for the
    # whole action serializes that sequence so each request's read reflects
    # the previous one's write. ActiveRecord's `with_lock` doesn't do this
    # under SQLite (no row-level FOR UPDATE support, see MUTEXES above), so
    # this uses a plain in-process Mutex instead.
    def lock_edit_session
      self.class.mutex_for(@edit_session.id).synchronize { yield }
    end
  end
end
