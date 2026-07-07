class CreateEditSessionSnapshots < ActiveRecord::Migration[8.1]
  def change
    create_table :edit_session_snapshots do |t|
      t.references :edit_session, null: false, foreign_key: true
      t.integer :position, null: false
      t.string :operation, null: false

      t.timestamps
    end
    add_index :edit_session_snapshots, [:edit_session_id, :position], unique: true
  end
end
