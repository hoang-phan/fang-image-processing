class CreateEditSessionSavedSelections < ActiveRecord::Migration[8.1]
  def change
    create_table :edit_session_saved_selections do |t|
      t.references :edit_session, null: false, foreign_key: true
      t.integer :slot, null: false

      t.timestamps
    end
    add_index :edit_session_saved_selections, [:edit_session_id, :slot], unique: true
  end
end
