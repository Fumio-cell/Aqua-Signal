#version 300 es
precision highp float;

uniform sampler2D u_prev_wetness;
uniform sampler2D u_prev_pigment;

uniform vec2 u_mouse_pos;
uniform float u_radius;
uniform float u_water_amount;
uniform vec4 u_pigment_color; // (r, g, b, density)
uniform float u_force;
uniform vec2 u_resolution;

in vec2 v_uv;
layout(location = 0) out vec4 out_wetness;
layout(location = 1) out vec4 out_pigment;

void main() {
  vec2 pos = v_uv * u_resolution;
  float dist = distance(pos, u_mouse_pos);
  
  float falloff = smoothstep(u_radius, u_radius * 0.5, dist);
  
  vec4 prev_w = texture(u_prev_wetness, v_uv);
  vec4 prev_p = texture(u_prev_pigment, v_uv);

  // Inject water
  float next_w = prev_w.r + u_water_amount * falloff * u_force;
  
  // Inject pigment
  // simple additive blending for pigment
  vec4 next_p = prev_p;
  if (falloff > 0.0) {
    float amount = u_pigment_color.a * falloff * u_force;
    next_p.rgb = (prev_p.rgb * prev_p.a + u_pigment_color.rgb * amount) / (prev_p.a + amount + 1e-6);
    next_p.a = prev_p.a + amount;
  }

  out_wetness = vec4(next_w, 0.0, 0.0, 1.0);
  out_pigment = next_p;
}
