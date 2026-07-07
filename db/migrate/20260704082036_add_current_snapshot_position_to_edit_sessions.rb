class AddCurrentSnapshotPositionToEditSessions < ActiveRecord::Migration[8.1]
  def change
    add_column :edit_sessions, :current_snapshot_position, :integer, null: false, default: -1
  end
end
