require "net/http"

# Thin HTTP wrapper around the Python pixel-processing service.
# The only boundary Rails uses to reach Python — see DESIGN.md §4/§5.
class PixelEngineClient
  BASE_URL = ENV.fetch("PIXEL_ENGINE_URL", "http://localhost:5001")

  def fuzzy_select(image:, mask: nil, x:, y:, tolerance:)
    body = { image: encode(image), x: x, y: y, tolerance: tolerance }
    body[:mask] = encode(mask) if mask
    decode(post("/fuzzy_select", body).fetch("mask"))
  end

  def gradient_select(image:, mask: nil, x:, y:, tolerance:)
    body = { image: encode(image), x: x, y: y, tolerance: tolerance }
    body[:mask] = encode(mask) if mask
    decode(post("/gradient_select", body).fetch("mask"))
  end

  def select_by_color(image:, mask: nil, x:, y:, tolerance:)
    body = { image: encode(image), x: x, y: y, tolerance: tolerance }
    body[:mask] = encode(mask) if mask
    decode(post("/select_by_color", body).fetch("mask"))
  end

  def gradient_select_from_selection(image:, mask:, tolerance:)
    body = { image: encode(image), mask: encode(mask), tolerance: tolerance }
    decode(post("/gradient_select_from_selection", body).fetch("mask"))
  end

  def combine(mask_a:, mask_b:)
    body = { mask_a: encode(mask_a), mask_b: encode(mask_b) }
    decode(post("/combine", body).fetch("mask"))
  end

  def subtract(mask_a:, mask_b:)
    body = { mask_a: encode(mask_a), mask_b: encode(mask_b) }
    decode(post("/subtract", body).fetch("mask"))
  end

  def invert(mask:)
    body = { mask: encode(mask) }
    decode(post("/invert", body).fetch("mask"))
  end

  def split_selection(mask:, x1:, y1:, x2:, y2:, keep_x:, keep_y:)
    body = { mask: encode(mask), x1: x1, y1: y1, x2: x2, y2: y2, keep_x: keep_x, keep_y: keep_y }
    decode(post("/split_selection", body).fetch("mask"))
  end

  def remove_holes(mask:)
    body = { mask: encode(mask) }
    decode(post("/remove_holes", body).fetch("mask"))
  end

  def grow_selection(mask:, border_size:)
    body = { mask: encode(mask), border_size: border_size }
    decode(post("/grow_selection", body).fetch("mask"))
  end

  def select_border(mask:, border_size:)
    body = { mask: encode(mask), border_size: border_size }
    decode(post("/select_border", body).fetch("mask"))
  end

  def delete(image:, mask:)
    body = { image: encode(image), mask: encode(mask) }
    decode(post("/delete", body).fetch("png"))
  end

  def select_all(image:)
    body = { image: encode(image) }
    decode(post("/select_all", body).fetch("mask"))
  end

  def free_select(image:, points:)
    body = { image: encode(image), points: points }
    decode(post("/free_select", body).fetch("mask"))
  end

  def line_select(image:, x1:, y1:, x2:, y2:, brush_size:)
    body = { image: encode(image), x1: x1, y1: y1, x2: x2, y2: y2, brush_size: brush_size }
    decode(post("/line_select", body).fetch("mask"))
  end

  def brush_select(image:, strokes:, brush_size:)
    body = { image: encode(image), strokes: strokes, brush_size: brush_size }
    decode(post("/brush_select", body).fetch("mask"))
  end

  private

  def post(path, body)
    uri = URI.join(BASE_URL, path)
    request = Net::HTTP::Post.new(uri, "Content-Type" => "application/json")
    request.body = body.to_json

    response = Net::HTTP.start(uri.host, uri.port) { |http| http.request(request) }
    unless response.is_a?(Net::HTTPSuccess)
      raise "PixelEngineClient: #{path} failed (#{response.code}): #{response.body}"
    end

    JSON.parse(response.body)
  end

  def encode(binary)
    Base64.strict_encode64(binary)
  end

  def decode(base64)
    Base64.strict_decode64(base64)
  end
end
