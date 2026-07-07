# A user-named "slot" for a selection mask, saved via the Save Selection
# function (§1/§3 of DESIGN.md) so it can be recalled later and merged into
# whatever is currently selected. Distinct from EditSessionSnapshot: this is
# selection storage the user opts into keeping, not automatic undo/redo
# history — capped at 3 per EditSession, enforced in EditSession#save_selection!.
class EditSessionSavedSelection < ApplicationRecord
  belongs_to :edit_session

  has_one_attached :mask

  validates :slot, uniqueness: { scope: :edit_session_id }, inclusion: { in: 0..2 }
end
