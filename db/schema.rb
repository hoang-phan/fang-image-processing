# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_07_05_060104) do
  create_table "active_storage_attachments", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.bigint "record_id", null: false
    t.string "record_type", null: false
    t.index ["blob_id"], name: "index_active_storage_attachments_on_blob_id"
    t.index ["record_type", "record_id", "name", "blob_id"], name: "index_active_storage_attachments_uniqueness", unique: true
  end

  create_table "active_storage_blobs", force: :cascade do |t|
    t.bigint "byte_size", null: false
    t.string "checksum"
    t.string "content_type"
    t.datetime "created_at", null: false
    t.string "filename", null: false
    t.string "key", null: false
    t.text "metadata"
    t.string "service_name", null: false
    t.index ["key"], name: "index_active_storage_blobs_on_key", unique: true
  end

  create_table "active_storage_variant_records", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.string "variation_digest", null: false
    t.index ["blob_id", "variation_digest"], name: "index_active_storage_variant_records_uniqueness", unique: true
  end

  create_table "edit_session_saved_selections", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.integer "edit_session_id", null: false
    t.integer "slot", null: false
    t.datetime "updated_at", null: false
    t.index ["edit_session_id", "slot"], name: "idx_on_edit_session_id_slot_33dd78d711", unique: true
    t.index ["edit_session_id"], name: "index_edit_session_saved_selections_on_edit_session_id"
  end

  create_table "edit_session_snapshots", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.integer "edit_session_id", null: false
    t.string "operation", null: false
    t.integer "position", null: false
    t.datetime "updated_at", null: false
    t.index ["edit_session_id", "position"], name: "index_edit_session_snapshots_on_edit_session_id_and_position", unique: true
    t.index ["edit_session_id"], name: "index_edit_session_snapshots_on_edit_session_id"
  end

  create_table "edit_sessions", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.integer "current_snapshot_position", default: -1, null: false
    t.string "session_token"
    t.datetime "updated_at", null: false
    t.index ["session_token"], name: "index_edit_sessions_on_session_token", unique: true
  end

  add_foreign_key "active_storage_attachments", "active_storage_blobs", column: "blob_id"
  add_foreign_key "active_storage_variant_records", "active_storage_blobs", column: "blob_id"
  add_foreign_key "edit_session_saved_selections", "edit_sessions"
  add_foreign_key "edit_session_snapshots", "edit_sessions"
end
