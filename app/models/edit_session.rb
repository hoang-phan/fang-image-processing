# The state owner (§3 of DESIGN.md): original upload, current selection mask,
# accumulating canvas, and the undo/redo history of both. Every tool operation
# (fuzzy_select, invert, delete) is a snapshot; undo/redo moves
# current_snapshot_position and restores current_mask/canvas_image to match.
class EditSession < ApplicationRecord
  has_one_attached :original_image
  has_one_attached :current_mask
  has_one_attached :canvas_image

  has_many :snapshots, class_name: "EditSessionSnapshot", dependent: :destroy
  has_many :saved_selections, class_name: "EditSessionSavedSelection", dependent: :destroy

  MAX_SAVED_SELECTIONS = 3

  before_create :generate_session_token

  def selection_present?
    current_mask.attached?
  end

  # Saves the current selection into a slot (max MAX_SAVED_SELECTIONS): fills
  # an empty slot first, or once all three are full, rolls over the oldest
  # one (by updated_at) so saving always succeeds without prompting the user
  # to pick what to evict — same "just keep the N most recent" ergonomics as
  # e.g. shell history.
  def save_selection!
    return nil unless current_mask.attached?

    slot = next_saved_selection_slot
    saved_selection = saved_selections.find_or_initialize_by(slot: slot)
    saved_selection.mask.attach(current_mask.blob)
    saved_selection.save!
    saved_selection
  end

  # Unions the current selection with a previously saved one via Python's
  # /combine (same op the add-to-selection modifier uses, see
  # SelectionsController#mask_with_modifier) and records the result as a new
  # undo step. If nothing is currently selected, the saved selection simply
  # becomes the current selection instead of no-op'ing.
  def merge_selection!(saved_selection:, pixel_engine:)
    merged_mask = if current_mask.attached?
      pixel_engine.combine(mask_a: current_mask.download, mask_b: saved_selection.mask.download)
    else
      saved_selection.mask.download
    end

    record_snapshot!(operation: "merge_selection", mask_bytes: merged_mask)
  end

  # The image the canvas/export should currently show: the accumulating
  # result of prior deletes, or the untouched original before any delete.
  def display_image
    canvas_image.attached? ? canvas_image : original_image
  end

  # Records a new undo/redo step after a tool operation and makes it current.
  # Any redo history beyond the current position is discarded first, matching
  # GIMP/standard undo semantics: making a new edit after undoing invalidates
  # the branch you undid past.
  #
  # Every snapshot carries a canvas_image, even for operations (fuzzy_select,
  # invert) that don't change it: it reuses the still-live canvas_image blob
  # from before this snapshot. Without that, undoing past a delete to an
  # intervening selection step would find no canvas on that snapshot and
  # revert the visible image all the way back to the original upload instead
  # of showing the canvas as it actually looked at that point in history.
  def record_snapshot!(operation:, mask_bytes:, canvas_bytes: nil)
    transaction do
      snapshots.where("position > ?", current_snapshot_position).destroy_all
      carried_canvas_blob = canvas_image.attached? ? canvas_image.blob : nil

      new_position = current_snapshot_position + 1
      snapshot = snapshots.create!(position: new_position, operation: operation)
      snapshot.mask.attach(io: StringIO.new(mask_bytes), filename: "mask.png", content_type: "image/png") if mask_bytes

      if canvas_bytes
        snapshot.canvas_image.attach(io: StringIO.new(canvas_bytes), filename: "canvas.png", content_type: "image/png")
      elsif carried_canvas_blob
        snapshot.canvas_image.attach(carried_canvas_blob)
      end

      update!(current_snapshot_position: new_position)
      apply_snapshot_attachments(snapshot)
    end
  end

  def undo!
    return false if current_snapshot_position < 0

    target_position = current_snapshot_position - 1
    restore_to_position!(target_position)
    true
  end

  def redo!
    target_position = current_snapshot_position + 1
    return false unless snapshots.exists?(position: target_position)

    restore_to_position!(target_position)
    true
  end

  private

  # An empty slot (0..MAX_SAVED_SELECTIONS-1) if one exists, otherwise the
  # oldest existing saved selection's slot so save_selection! overwrites it —
  # the "rolled update" that keeps the most recent MAX_SAVED_SELECTIONS saves.
  def next_saved_selection_slot
    used_slots = saved_selections.pluck(:slot)
    empty_slot = (0...MAX_SAVED_SELECTIONS).find { |slot| !used_slots.include?(slot) }
    return empty_slot if empty_slot

    saved_selections.order(:updated_at).first.slot
  end

  # Copies a snapshot's mask/canvas onto the live attachments the rest of the
  # app reads (current_mask/canvas_image), so EditSessionSnapshot stays a pure
  # history record and every other controller keeps reading the same two
  # attachment names regardless of undo/redo position.
  def apply_snapshot_attachments(snapshot)
    if snapshot.mask.attached?
      current_mask.attach(snapshot.mask.blob)
    else
      current_mask.purge
    end

    if snapshot.canvas_image.attached?
      canvas_image.attach(snapshot.canvas_image.blob)
    else
      canvas_image.purge
    end
  end

  def restore_to_position!(target_position)
    transaction do
      if target_position < 0
        current_mask.purge
        canvas_image.purge
      else
        apply_snapshot_attachments(snapshots.find_by!(position: target_position))
      end

      update!(current_snapshot_position: target_position)
    end
  end

  def generate_session_token
    self.session_token ||= SecureRandom.hex(16)
  end
end
