import { Controller } from "@hotwired/stimulus"

// Cross-page session-management UI: upload (hidden form + drag/drop) and the
// Load Session dialog, plus their two keyboard shortcuts. Mounted on <body>
// (see layout) so it's identical on the landing page and the editor page.
// No pixel math, no EditSession business logic — pure UI glue that submits a
// form / fetches a fragment and updates the DOM with what comes back.
export default class extends Controller {
  static targets = ["form", "fileInput", "dialog", "sessionList"]
  static values = { indexUrl: String }

  connect() {
    this.boundKeydown = this.keydown.bind(this)
    document.addEventListener("keydown", this.boundKeydown)

    this.boundDragOver = this.dragOver.bind(this)
    this.boundDrop = this.drop.bind(this)
    document.addEventListener("dragover", this.boundDragOver)
    document.addEventListener("drop", this.boundDrop)
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundKeydown)
    document.removeEventListener("dragover", this.boundDragOver)
    document.removeEventListener("drop", this.boundDrop)
  }

  keydown(event) {
    const meta = event.metaKey || event.ctrlKey

    if (meta && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault()
      this.openFileDialog()
      return
    }

    if (meta && event.key.toLowerCase() === "o") {
      event.preventDefault()
      this.openLoadDialog()
      return
    }
  }

  // Ctrl/Cmd+Shift+O, or an "Upload New" button: opens the native file
  // picker via a hidden <input type="file">.
  openFileDialog() {
    this.fileInputTarget.value = ""
    this.fileInputTarget.click()
  }

  // Auto-submits on file-picker selection — no separate "Upload" button
  // click. Always creates a NEW EditSession; whatever session (if any) is
  // currently open is left untouched in the DB.
  fileInputChanged() {
    if (this.fileInputTarget.files[0]) this.formTarget.requestSubmit()
  }

  containsFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files")
  }

  // dragover must call preventDefault() or the browser rejects the drop
  // entirely (its default behavior is to navigate to the dropped file).
  dragOver(event) {
    if (!this.containsFiles(event)) return
    event.preventDefault()
  }

  // Assigns the dropped file(s) to the hidden form's file input via
  // DataTransfer (the standard way to programmatically populate a native
  // file input) and submits the same form the picker path uses, so both
  // routes converge on one upload mechanism.
  drop(event) {
    if (!this.containsFiles(event)) return
    event.preventDefault()

    const file = event.dataTransfer.files[0]
    if (!file) return

    this.fileInputTarget.files = event.dataTransfer.files
    this.formTarget.requestSubmit()
  }

  // Ctrl/Cmd+O, or a "Load Session" button: fetches the session list as an
  // HTML fragment and injects it into the <dialog> — matching the app's
  // existing server-rendered-HTML + fetch style (no Turbo Frames/Streams
  // used anywhere in this app).
  async openLoadDialog() {
    const response = await fetch(this.indexUrlValue, {
      headers: { "Accept": "text/html" },
    })
    if (response.ok) {
      this.sessionListTarget.innerHTML = await response.text()
    }
    this.dialogTarget.showModal()
  }

  closeLoadDialog() {
    this.dialogTarget.close()
  }

  // One delegated listener on the list container: anchor clicks fall
  // through to normal browser navigation, delete-button clicks are
  // intercepted. Rows are re-rendered wholesale on every open, so
  // delegation avoids re-binding per-row listeners after each fetch.
  async sessionListClick(event) {
    const deleteButton = event.target.closest(".session-delete-button")
    if (!deleteButton) return

    event.preventDefault()
    if (!confirm("Delete this session? This cannot be undone.")) return

    const id = deleteButton.dataset.id
    const response = await fetch(`/edit_sessions/${id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]').content },
    })

    if (response.ok) {
      deleteButton.closest(".session-list-item").remove()
    }
  }
}
