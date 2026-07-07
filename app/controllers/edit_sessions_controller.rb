class EditSessionsController < ApplicationController
  before_action :set_edit_session, only: [:show, :export, :destroy]

  def new
    @edit_session = EditSession.new
  end

  # Lists every EditSession (no per-user scoping exists — see DESIGN.md §5)
  # as a bare HTML fragment for the Load Session dialog's fetch() call.
  def index
    @edit_sessions = EditSession.order(created_at: :desc)
    render partial: "session_list", locals: { edit_sessions: @edit_sessions }, layout: false
  end

  def create
    @edit_session = EditSession.new
    @edit_session.original_image.attach(params.require(:edit_session).permit(:original_image)[:original_image])
    @edit_session.save!
    redirect_to edit_session_path(@edit_session)
  end

  def show
  end

  # Exports whichever image currently represents the canvas: the
  # background-cleared result if Delete has been used, otherwise the
  # untouched original (see DESIGN.md §1 — Download exports current state).
  def export
    redirect_to rails_blob_path(@edit_session.display_image, disposition: "attachment", filename: "sprite.png")
  end

  def destroy
    @edit_session.destroy
    head :no_content
  end

  private

  def set_edit_session
    @edit_session = EditSession.find(params[:id])
  end
end
