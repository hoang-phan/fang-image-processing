class CreateEditSessions < ActiveRecord::Migration[8.1]
  def change
    create_table :edit_sessions do |t|
      t.string :session_token

      t.timestamps
    end
    add_index :edit_sessions, :session_token, unique: true
  end
end
