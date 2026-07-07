# One undo/redo step for an EditSession (§3 of DESIGN.md). Each snapshot
# captures the full selection mask and canvas state *after* one tool
# operation (fuzzy_select, invert, or delete) ran, so undo/redo can jump
# straight to a position without replaying operations.
class EditSessionSnapshot < ApplicationRecord
  belongs_to :edit_session

  has_one_attached :mask
  has_one_attached :canvas_image

  validates :position, uniqueness: { scope: :edit_session_id }
end
